/**
 * Start one DSH agent session for a webhook-triggered job.
 *
 * The sequence mirrors the shipped `dsh-webhook` integration (CONTRACT.md §4/§5):
 * resolve the preset, take a preset scope, create (or reuse) the workspace,
 * create the agent with the preset mounted, attach it to the workspace, pin the
 * permission preset, set the title, deliver the prompt as a user message, then
 * wait for the session to go idle (cancelling on timeout) and fold the outcome
 * out of the session log.
 *
 * The agent is intentionally NOT disposed: it stays visible in the Web UI.
 *
 * @module bigfatfish-bot/lib/session
 */

import crypto from 'node:crypto'

import { installBotGuard } from './guard.js'

/**
 * Build the user message that starts a webhook-driven turn.
 *
 * Mirrors `@deepseek-ai/dsh-llm`'s `createUserMessage` (fresh identity plus a
 * detached deep-frozen snapshot) without importing that package: a linked
 * profile bundle cannot resolve npm dependencies from its workspace realpath.
 * @param {any} input
 * @returns {any}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return value
}

function createUserMessage(input) {
  const message = structuredClone({ ...input, role: 'user' })
  message.id = crypto.randomUUID()
  return deepFreeze(message)
}

const DEFAULT_TIMEOUT_MS = 1800000
const DEFAULT_MAX_REPLY_CHARS = 6000
const TURN_ERROR_MAX_CHARS = 300
/** Extra wait granted after `cancel()` so a stuck turn can actually unwind. */
const CANCEL_GRACE_MS = 60000

function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function toCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function clip(text, max) {
  if (typeof text !== 'string') return ''
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Fold one usage object into the session totals. */
function addUsage(target, usage) {
  if (!usage || typeof usage !== 'object') return
  const input = toCount(usage.inputTokens)
  const output = toCount(usage.outputTokens)
  const cacheRead = toCount(usage.cacheReadTokens)
  const cacheWrite = toCount(usage.cacheWriteTokens)
  const reportedTotal = toCount(usage.totalTokens)
  target.input += input
  target.output += output
  // Providers report a total (excluding cache duplication) on the usage chunk;
  // when absent, prompt buckets plus completion is the billable total.
  target.total += reportedTotal > 0 ? reportedTotal : input + output + cacheRead + cacheWrite
}

/** Short, single-line summary of one `turn/end` failure. */
function summarizeTurnError(error) {
  if (error === null || error === undefined) return 'unknown error'
  let message = ''
  let code = ''
  if (typeof error === 'string') {
    message = error
  } else if (typeof error === 'object') {
    if (typeof error.message === 'string') message = error.message
    if (typeof error.code === 'string' && error.code !== 'UNKNOWN') code = error.code
    if (message === '' && typeof error.cause === 'string') message = error.cause
  }
  const text = message.replace(/\s+/g, ' ').trim() || 'unknown error'
  const clipped = clip(text, TURN_ERROR_MAX_CHARS)
  return code !== '' && !clipped.includes(code) ? `${code}: ${clipped}` : clipped
}

/**
 * Fold the session log into the values the caller publishes.
 * @param {any[]} events
 * @param {number} maxReplyChars
 */
function extractOutcome(events, maxReplyChars) {
  const usage = { input: 0, output: 0, total: 0 }
  let replyText = ''
  let turnError = null

  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const data = event.data && typeof event.data === 'object' ? event.data : {}

    if (event.type === 'assistant/message') {
      addUsage(usage, data.usage)
      const content = data.message && Array.isArray(data.message.content) ? data.message.content : []
      const text = content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim()
      if (text.length > 0) replyText = text
    } else if (event.type === 'turn/end') {
      const reason = data.reason
      if (reason && typeof reason === 'object' && reason.kind === 'error') {
        turnError = summarizeTurnError(reason.error)
      }
    }
  }

  return { replyText: clip(replyText, maxReplyChars).trim(), usage, turnError }
}

/**
 * Wait until the agent has no running activity.
 * @param {any} agent
 * @param {number} timeoutMs
 * @param {any} logger
 * @returns {Promise<boolean>} true when the wait timed out
 */
function waitForIdle(agent, timeoutMs, logger) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (timedOut, reason) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (reason !== undefined) logger?.warn?.(`agent session wait ended with an error: ${reason}`)
      resolve(timedOut)
    }
    const timer = setTimeout(() => finish(true), timeoutMs)
    agent.whenIdle().then(
      () => finish(false),
      (error) => finish(false, error?.message ?? String(error)),
    )
  })
}

/**
 * Run one webhook-triggered agent session to completion.
 * @param {any} ctx DSH host context (plugin `apply` ctx).
 * @param {any} config BigFatFish config (§3).
 * @param {{ repoDir: string, title: string, prompt: string, deliveryId?: string, ruleId?: string }} opts
 * @returns {Promise<{ sessionId: string, replyText: string, usage: { input: number, output: number, total: number }, turnError: string | null, timedOut: boolean }>}
 */
export async function runAgentSession(ctx, config, opts) {
  const logger = ctx?.logger
  const timeoutMs = positiveNumber(config?.sessionTimeoutMs, DEFAULT_TIMEOUT_MS)
  const maxReplyChars = positiveNumber(config?.maxReplyChars, DEFAULT_MAX_REPLY_CHARS)
  const { repoDir, title, prompt } = opts ?? {}
  if (typeof repoDir !== 'string' || repoDir.trim() === '') {
    throw new TypeError('runAgentSession: `repoDir` must be a non-empty string')
  }
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new TypeError('runAgentSession: `prompt` must be a non-empty string')
  }
  const sessionTitle = typeof title === 'string' && title.trim() !== '' ? title.trim() : 'bigfatfish-bot'

  const preset = await ctx.agentPresets.resolve(config?.agentPreset)
  if (preset.broken !== undefined) {
    logger?.warn?.(`agent preset '${preset.id}' is not healthy: ${String(preset.broken)}`)
  }
  // Resolve before creating anything so an unknown preset fails the job early.
  ctx.permissionPresets.resolve(config?.permissionPreset)
  const scope = await ctx.agentPresets.acquireScope(preset.id)
  const explicitModel =
    opts?.model && typeof opts.model.provider === 'string' && typeof opts.model.model === 'string' &&
    opts.model.provider !== '' && opts.model.model !== ''
      ? { provider: opts.model.provider, model: opts.model.model }
      : config?.modelProvider && config?.modelId
        ? { provider: config.modelProvider, model: config.modelId }
        : null
  const agentOptions = explicitModel !== null
    ? { ...explicitModel }
    : { ...ctx.agentDefaultModel.currentSelection() }

  const followupMessage = createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: {
      kind: 'webhook',
      provider: 'github',
      source: 'bigfatfish-github',
      deliveryId: opts.deliveryId,
      ruleId: opts.ruleId,
      form: 'notice',
      summary: 'github webhook handled by bigfatfish-bot',
    },
  })

  /** Deliver the prompt to one agent and fold its finished turn out of the log. */
  async function followupAndWait(agent, sessionId) {
    try {
      opts.onSessionReady?.(sessionId, agent)
    } catch (error) {
      logger?.warn?.(`onSessionReady failed for session '${sessionId}': ${error?.message ?? error}`)
    }
    agent.followup(followupMessage)
    let timedOut = await waitForIdle(agent, timeoutMs, logger)
    if (timedOut) {
      logger?.warn?.(`session '${sessionId}' exceeded ${timeoutMs}ms; cancelling`)
      try {
        agent.cancel({ kind: 'hook', reason: 'timeout' })
      } catch (error) {
        logger?.warn?.(`failed to cancel timed-out session '${sessionId}': ${error?.message ?? error}`)
      }
      const stillRunning = await waitForIdle(agent, CANCEL_GRACE_MS, logger)
      if (stillRunning) {
        logger?.warn?.(`session '${sessionId}' is still running ${CANCEL_GRACE_MS}ms after cancel; reading the log as-is`)
      }
      timedOut = true
    }
    const events = agent.session.snapshotEvents()
    const { replyText, usage, turnError } = extractOutcome(events, maxReplyChars)
    logger?.info?.(
      `session '${sessionId}' finished (timedOut=${timedOut}, tokens=${usage.total}${turnError ? `, error=${turnError}` : ''})`,
    )
    return { sessionId, replyText, usage, turnError, timedOut }
  }

  try {
    // Same issue, same conversation: continue the implementation session for
    // PR comments, reviews and retries instead of opening a new DSH Session.
    const resumeSessionId =
      typeof opts.resumeSessionId === 'string' && opts.resumeSessionId !== '' ? opts.resumeSessionId : null
    if (resumeSessionId !== null) {
      const live = ctx.agents.get(resumeSessionId)
      if (live !== undefined && live.session !== undefined) {
        try {
          ctx.permissionPresets.set(live.session, config?.permissionPreset)
        } catch (error) {
          logger?.warn?.(`failed to pin permission preset on live session '${resumeSessionId}': ${error?.message ?? error}`)
        }
        logger?.info?.(`continuing live session '${resumeSessionId}'`)
        return await followupAndWait(live, resumeSessionId)
      }
      try {
        const resumedHandle = await ctx.agents.resume({
          resumeSessionId,
          agentOptions,
          setup: async (agentCtx) => {
            await ctx.agentPresets.mount(agentCtx, preset.id)
          },
        })
        const resumed = resumedHandle.agent
        const resumedWorkspace = resumed.session?.header?.cwd ?? repoDir
        try {
          installBotGuard(resumed.ctx, { workspace: resumedWorkspace })
        } catch (error) {
          logger?.warn?.(`failed to install bot guard on resumed session '${resumeSessionId}': ${error?.message ?? error}`)
        }
        try {
          ctx.permissionPresets.set(resumed.session, config?.permissionPreset)
        } catch (error) {
          logger?.warn?.(`failed to pin permission preset on resumed session '${resumeSessionId}': ${error?.message ?? error}`)
        }
        logger?.info?.(`resumed session '${resumeSessionId}' from its persisted log`)
        return await followupAndWait(resumed, resumeSessionId)
      } catch (error) {
        logger?.warn?.(`could not resume session '${resumeSessionId}' (${error?.message ?? error}); opening a new session`)
      }
    }

    const workspace = await ctx.workspaceRegistry.create(repoDir, sessionTitle)
    const sessionId = `bigfatfish-${crypto.randomUUID()}`

    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: workspace.path, agentPreset: preset.id },
      agentOptions,
      setup: async (agentCtx) => {
        await ctx.agentPresets.mount(agentCtx, preset.id)
      },
    })
    await workspace.attachSession(sessionId)

    // Hard per-agent policy: tool allowlist + workspace path containment + a
    // command blocklist. The agent is unattended and the issue text is
    // untrusted, so this is independent of the prompt and of the preset.
    try {
      installBotGuard(handle.agent.ctx, { workspace: workspace.path })
    } catch (error) {
      logger?.warn?.(`failed to install bot guard for session '${sessionId}': ${error?.message ?? error}`)
    }

    try {
      ctx.permissionPresets.set(handle.agent.session, config?.permissionPreset)
    } catch (error) {
      logger?.warn?.(`failed to pin permission preset '${config?.permissionPreset}': ${error?.message ?? error}`)
    }
    try {
      ctx.sessionTitle.rename(handle.agent.session, sessionTitle)
    } catch (error) {
      logger?.warn?.(`failed to rename session '${sessionId}': ${error?.message ?? error}`)
    }

    return await followupAndWait(handle.agent, sessionId)
  } finally {
    await scope[Symbol.asyncDispose]?.()
  }

}
