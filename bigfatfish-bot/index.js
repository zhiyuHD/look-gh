/**
 * BigFatFish bot — Host half.
 *
 * Receives signed GitHub webhook deliveries through its own HTTP ingress,
 * decides what kind of reaction they deserve, and runs DSH agent sessions for
 * approved issues and review changes. Every HTTP/Git call goes through the
 * sibling modules; this file only owns dispatch, queues, quota coordination,
 * replies and the read-only usage route.
 */
import { appendFile, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  MARKERS,
  associationAllowed,
  botLogin,
  hasMarker,
  hasMention,
  isApproval,
  isBotSender,
  isRepoAllowed,
  issueKey,
  parseBranchIssue,
  repoFullName,
  truncate,
} from './lib/decisions.js'
import { GitHubError, createGitHubClient } from './lib/github.js'
import { createGit } from './lib/git.js'
import { createUsageStore } from './lib/usage-store.js'
import { runAgentSession } from './lib/session.js'
import { buildIssuePrompt, buildTriagePrompt, buildReviewPrompt } from './lib/prompts.js'
import { createIngress } from './lib/ingress.js'
import { createRelay } from './lib/relay.js'
import { registerBotTools } from './lib/tools.js'
import { createSandboxBash } from './lib/sandbox-bash.js'
import { createMemoryStore } from './lib/memory.js'

/** Cordis plugin name (also the loader entry name in `cordis.patch.yml`). */
export const name = 'bigfatfish-bot'

/** Services the Host provides before this plugin may activate. */
export const inject = [
  'agents',
  'agentPresets',
  'permissionPresets',
  'sessionTitle',
  'workspaceRegistry',
  'agentDefaultModel',
  'llm',
  'tools',
  'webServer',
]

/**
 * Config defaults plus required-field checks. `schemastery` is deliberately
 * not imported: a profile-installed linked bundle cannot resolve npm packages
 * from its workspace realpath, so the plugin keeps its dependency surface at
 * Node built-ins only and normalizes the row config itself.
 */
const CONFIG_DEFAULTS = {
  allowedRepos: [],
  mention: 'bigfatfish-bot',
  agentPreset: 'standard',
  permissionPreset: 'danger-full-access',
  branchPrefix: 'dsh/issue-',
  approvalAssociations: ['OWNER', 'COLLABORATOR', 'MEMBER'],
  approvalKeywords: ['/approve', '同意', '批准', '可以开工', '开工', 'approve', 'lgtm'],
  denyKeywords: ['不同意', '不批', '先别', '不要', '暂缓', 'hold'],
  dailyIssueLimit: 5,
  quotaTimeZone: 'Asia/Shanghai',
  maxConcurrentSessions: 2,
  maxQueuePerRepo: 5,
  sessionTimeoutMs: 1800000,
  maxIssueContextChars: 20000,
  maxReplyChars: 6000,
  modelProvider: '',
  modelId: '',
  usageRoutePath: '/bigfatfish/usage',
  ingressHost: '127.0.0.1',
  ingressPort: 5562,
  ingressPath: '/github',
  maxBodyBytes: 5 * 1024 * 1024,
  webhookSecretRef: 'BIGFATFISH_GITHUB_WEBHOOK_SECRET',
  relayEnabled: true,
  relayHost: '127.0.0.1',
  relayPort: 5563,
  relayKey: 'local-dev-key',
  relayProvider: '',
  relayModel: '',
  relayPriceInputCnyPerM: 2,
  relayPriceOutputCnyPerM: 8,
  relayInitialCreditCny: 5,
}

function normalizeConfig(raw) {
  const config = { ...CONFIG_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  for (const field of ['appId', 'appSlug', 'privateKeyPath', 'webhookSecretPath', 'workspaceRoot']) {
    if (typeof config[field] !== 'string' || config[field].trim() === '') {
      throw new Error(`[bigfatfish] config.${field} is required`)
    }
  }
  config.allowedRepos = Array.isArray(config.allowedRepos)
    ? config.allowedRepos.filter((repo) => typeof repo === 'string' && repo.includes('/'))
    : []
  return config
}

/** Rule id shared by the webhook runtime registration and the agent session. */
const RULE_ID = 'bigfatfish-github'
/** Webhook source configured on the `dsh-webhook-github` adapter entry. */
const WEBHOOK_SOURCE = 'bigfatfish-github'
/** Delivery ids and unsupported notices are remembered for one day. */
const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000
/** Repository reply texts fixed by CONTRACT.md §2. */
const FIXED = {
  ack: '👋 收到。Owner/Collaborator 回复 `/approve` 或「同意」后开始处理。',
  prAck: '👋 收到。维护者回复 `/approve` 或「同意」后，我会按这条 PR 评论修改。',
  unsupported: '⚠️ 仓库不在支持列表（仓库不支持），请联系维护者。',
  started: '🛠 已收到批准，开始处理，完成后会在此回复结果。',
  approved: '👍 已收到 approve，等待维护者合并。',
  reviewNoChange: '✅ 已按 review 检查完成，无需代码改动。',
}

export function apply(ctx, config) {
  return start(ctx, normalizeConfig(config))
}

/**
 * Boot the plugin: load the webhook secret, then wire the ingress listener, the
 * usage route and the rule dispatcher. An unavailable secret or bind failure
 * throws so the loader reports this entry as failed instead of running a
 * half-working bot.
 */
async function start(ctx, config) {
  const logger = ctx.logger
  const lifecycle = new AbortController()
  ctx.effect(() => () => lifecycle.abort(), 'bigfatfish-bot: abort queued work')
  /** Optional loopback model relay; assigned after the ingestion listener starts. */
  let relay = null

  const secret = (await readFile(config.webhookSecretPath, 'utf8')).trim()
  if (secret === '') throw new Error(`[bigfatfish] webhook secret file is empty: ${config.webhookSecretPath}`)

  const github = createGitHubClient({
    appId: config.appId,
    privateKeyPath: config.privateKeyPath,
    logger,
  })
  const git = createGit(logger)
  const sandboxBash = createSandboxBash({ logger })
  const memoryStore = createMemoryStore({ logger })
  /**
   * Agents own commit/PR decisions through `bff_*` tools; this map is the
   * per-session job context those tools resolve while a turn runs. It must be
   * initialized before the tool effect's initializer runs.
   */
  const sessionJobs = new Map()
  ctx.effect(
    () => registerBotTools(ctx, {
      sessionJobs,
      github,
      git,
      logger,
      getAllowedRepos: () => (Array.isArray(config.allowedRepos) ? config.allowedRepos : []),
      ensureExcludes: ensureGitExcludes,
      sandboxBash,
      memory: memoryStore,
    }),
    'bigfatfish-bot: model tools',
  )
  const usageStore = createUsageStore({
    filePath: join(homedir(), '.dsh', 'bigfatfish-bot', 'usage.json'),
    limit: config.dailyIssueLimit,
    timeZone: config.quotaTimeZone,
    logger,
  })
  await usageStore.init()

  // Whitelist lives in an override file so the sidebar page can change it
  // without restarting the plugin; config.allowedRepos is only the fallback.
  const storedRepos = await loadStoredRepos()
  if (storedRepos !== null) config.allowedRepos = storedRepos
  else await saveStoredRepos(config.allowedRepos)

  // Bot sessions use this provider/model override when set from the sidebar.
  let sessionModel = await loadStoredModel()

  // ---------------------------------------------------------------- dispatch

  /** deliveryId -> ts */
  const seenDeliveries = new Map()
  /** issueKey -> ts of the last "repository unsupported" notice */
  const unsupportedSent = new Map()
  /** issueKey whose ack comment is being resolved right now */
  const mentionInFlight = new Set()
  /** issueKey of an accepted implementation job (queued or running) */
  const inFlightIssues = new Set()
  /** `review:<repo>#<id>` of an accepted review job (queued or running) */
  const inFlightReviews = new Set()
  /** `<repo>#<pr>` with a review job queued or running (any trigger source) */
  const reviewPendingPrs = new Set()
  /** repo -> { pending: Job[], running: boolean } */
  const queues = new Map()
  /** Number of jobs currently occupying a global slot. */
  let activeJobs = 0
  const slotWaiters = []

  function prune(map, ttl) {
    const now = Date.now()
    for (const [key, timestamp] of map) {
      if (now - timestamp > ttl) map.delete(key)
    }
  }

  function alreadySeen(deliveryId) {
    prune(seenDeliveries, DEDUPE_TTL_MS)
    const key = String(deliveryId ?? '')
    if (key === '') return false
    if (seenDeliveries.has(key)) return true
    seenDeliveries.set(key, Date.now())
    return false
  }

  function installationIdOf(payload) {
    const id = payload?.installation?.id
    return Number.isInteger(id) && id > 0 ? id : null
  }

  function defaultBranchOf(payload) {
    const branch = payload?.repository?.default_branch
    return typeof branch === 'string' && branch !== '' ? branch : 'main'
  }

  /** True when the issue author is the repository owner (owner requests need no approval). */
  function ownerRequested(payload, issue) {
    const author = issue?.user?.login
    const owner = payload?.repository?.owner?.login
    if (typeof author === 'string' && typeof owner === 'string' && author.toLowerCase() === owner.toLowerCase()) {
      return true
    }
    return issue?.author_association === 'OWNER'
  }

  async function handleDelivery(delivery) {
    if (!delivery || delivery.kind !== 'github' || delivery.source !== WEBHOOK_SOURCE) return
    const event = delivery.event
    const eventName = event?.name
    const payload = event?.payload
    if (typeof eventName !== 'string' || !payload || typeof payload !== 'object') return
    const deliveryId = String(delivery.deliveryId ?? '')
    if (alreadySeen(deliveryId)) {
      logger.info(`[bigfatfish] duplicate delivery ${deliveryId} ignored`)
      return
    }
    const repo = repoFullName(payload)
    if (repo === undefined) return
    if (isBotSender(payload)) return
    const allowed = isRepoAllowed(config, repo)
    switch (eventName) {
      case 'issues':
        return handleIssuesEvent(payload, repo, allowed, deliveryId)
      case 'issue_comment':
        return handleIssueCommentEvent(payload, repo, allowed, deliveryId)
      case 'pull_request_review':
        return handlePullRequestReviewEvent(payload, repo, allowed, deliveryId)
      default:
        return
    }
  }

  /** Engine entry: the ingress calls this fire-and-forget. */
  async function ruleRun(delivery) {
    try {
      await handleDelivery(delivery)
    } catch (error) {
      logger.error(`[bigfatfish] delivery failed: ${describeError(error)}`)
    }
    return null
  }

  // -------------------------------------------------------- mention handling

  async function handleIssuesEvent(payload, repo, allowed, deliveryId) {
    const action = payload.action
    const issue = payload.issue
    if (!issue || issue.pull_request) return
    if (action === 'closed') {
      await archiveClosedIssue(repo, issue.number)
      return
    }
    if (action !== 'opened' && action !== 'edited') return
    const installationId = installationIdOf(payload)
    if (installationId === null) {
      logger.warn(`[bigfatfish] ${repo}: issues payload without installation id`)
      return
    }
    await handleMention({
      repo,
      number: issue.number,
      text: issue.body,
      allowed,
      installationId,
      defaultBranch: defaultBranchOf(payload),
      issueTitle: typeof issue.title === 'string' ? issue.title : '',
      owner: ownerRequested(payload, issue),
    })
  }

  async function noteCleanup(line) {
    try {
      const file = join(homedir(), '.dsh', 'bigfatfish-bot', 'cleanup.log')
      await appendFile(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
    } catch {
      /* best effort */
    }
  }

  /** Closing an issue ends its session: archive it and release the workspace. */
  async function archiveClosedIssue(repo, issueNumber) {
    try {
      const sessionId = await usageStore.findIssueSession(repo, issueNumber)
      const snapshot = await usageStore.snapshot()
      const entry = snapshot?.repos?.find((row) => row.repo === repo)
      const otherSessions =
        (entry?.issues ?? []).some(
          (row) => row && row.number !== issueNumber && typeof row.sessionId === 'string' && row.sessionId !== '',
        ) ||
        Object.entries(entry?.triageSessions ?? {}).some(
          ([number, id]) => Number(number) !== issueNumber && typeof id === 'string' && id !== '',
        )
      const activeJob = [...inFlightIssues].some((key) => key.startsWith(`${repo}#`))
      if (otherSessions || activeJob) {
        if (typeof sessionId === 'string' && sessionId !== '') {
          await ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true }).catch((error) => {
            logger.warn(`[bigfatfish] archive closed issue ${repo}#${issueNumber} failed: ${describeError(error)}`)
          })
        }
        await usageStore.clearIssueSession(repo, issueNumber).catch(() => {})
        await noteCleanup(`closed issue ${repo}#${issueNumber}: archived session, kept shared workspace`)
        logger.info(
          `[bigfatfish] issue ${repo}#${issueNumber} closed; archived its session but kept the shared clone/workspace`,
        )
        return
      }
      await cleanupRepoWorkspace(repoDirFor(repo), {
        sessionId: sessionId ?? undefined,
        repo,
        issueNumber,
      })
      await noteCleanup(`closed issue ${repo}#${issueNumber}: archived session and removed workspace`)
      logger.info(`[bigfatfish] issue ${repo}#${issueNumber} closed; archived session and cleaned workspace`)
    } catch (error) {
      logger.warn(`[bigfatfish] closed issue cleanup for ${repo}#${issueNumber} failed: ${describeError(error)}`)
    }
  }

  async function handleIssueCommentEvent(payload, repo, allowed, deliveryId) {
    const action = payload.action
    if (action !== 'created' && action !== 'edited') return
    const comment = payload.comment
    const issue = payload.issue
    if (!comment || !issue) return
    const installationId = installationIdOf(payload)
    if (installationId === null) {
      logger.warn(`[bigfatfish] ${repo}: issue_comment payload without installation id`)
      return
    }
    await handleMention({
      repo,
      number: issue.number,
      text: comment.body,
      allowed,
      installationId,
      pullRequest: Boolean(issue.pull_request),
      defaultBranch: defaultBranchOf(payload),
      issueTitle: typeof issue.title === 'string' ? issue.title : '',
      owner: ownerRequested(payload, issue),
    })
    // Owner/Collaborator approval: issues start an implementation, PR
    // conversations start a review-fix session on the PR's branch.
    if (action !== 'created') return
    if (!allowed) return
    if (!associationAllowed(config, payload.author_association ?? comment.author_association)) return
    if (!isApproval(config, comment.body)) return
    if (issue.pull_request) {
      await handlePullRequestCommentApproval({ repo, issue, comment, installationId, deliveryId })
      return
    }
    await handleApproval({
      payload,
      repo,
      issue,
      installationId,
      deliveryId,
    })
  }

  async function handleMention({
    repo,
    number,
    text,
    allowed,
    installationId,
    pullRequest = false,
    defaultBranch = 'main',
    issueTitle = '',
    owner = false,
  }) {
    if (!hasMention(text, config.mention)) return
    const key = issueKey(repo, number)
    if (!allowed) {
      prune(unsupportedSent, DEDUPE_TTL_MS)
      if (unsupportedSent.has(key)) return
      unsupportedSent.set(key, Date.now())
      await safeCommentIssue(repo, number, withMarker(FIXED.unsupported, MARKERS.unsupported), installationId)
      return
    }
    // PR conversation mentions stay on the review path: acknowledge and wait
    // for the maintainer's /approve before touching the PR branch.
    if (pullRequest) {
      if (mentionInFlight.has(key)) return
      mentionInFlight.add(key)
      try {
        const comments = await github.listIssueComments(repo, number, installationId)
        if (comments.some((comment) => hasMarker(comment?.body, MARKERS.ack))) return
        await github.commentIssue(repo, number, withMarker(FIXED.prAck, MARKERS.ack), installationId)
      } catch (error) {
        logger.warn(`[bigfatfish] PR ack for ${key} failed: ${describeError(error)}`)
      } finally {
        mentionInFlight.delete(key)
      }
      return
    }

    if (mentionInFlight.has(key) || inFlightIssues.has(key)) return
    mentionInFlight.add(key)
    let reserved = false
    try {
      // Every new mention gets a triage turn (idle sessions are resumed); the
      // delivery-id dedupe and the in-flight reservation stop duplicate runs.
      inFlightIssues.add(key)
      reserved = true
      const accepted = enqueue(repo, {
        kind: owner ? 'issue' : 'triage',
        mode: owner ? 'owner' : 'triage',
        repo,
        issueNumber: number,
        issueTitle,
        defaultBranch,
        installationId,
        deliveryId: undefined,
      })
      if (!accepted) {
        inFlightIssues.delete(key)
        reserved = false
        await safeCommentIssue(repo, number, withMarker(busyText(), MARKERS.failed), installationId)
      }
    } catch (error) {
      logger.warn(`[bigfatfish] triage for ${key} failed to start: ${describeError(error)}`)
    } finally {
      if (!reserved) inFlightIssues.delete(key)
      mentionInFlight.delete(key)
    }
  }

  // ------------------------------------------------------- approval handling

  async function handleApproval({ payload, repo, issue, installationId, deliveryId }) {
    const number = issue.number
    const key = issueKey(repo, number)
    if (inFlightIssues.has(key)) return
    // Reserve the issue before the first await so two near-simultaneous
    // approvals cannot both start a session for the same branch.
    inFlightIssues.add(key)
    let queued = false
    try {
      const comments = await github.listIssueComments(repo, number, installationId)
      if (!comments.some((comment) => hasMarker(comment?.body, MARKERS.approvalRequested))) return
      const branch = `${config.branchPrefix}${number}`
      const openPull = await github.findOpenPull(repo, branch, installationId)
      if (openPull) {
        logger.info(`[bigfatfish] ${key} already has open pull request #${openPull.number}`)
        return
      }
      if (!(await quotaAvailable(repo))) {
        await safeCommentIssue(repo, number, withMarker(limitText(), MARKERS.limit), installationId)
        return
      }
      queued = enqueue(repo, {
        kind: 'issue',
        mode: 'approved',
        repo,
        issueNumber: number,
        issueTitle: typeof issue.title === 'string' ? issue.title : '',
        defaultBranch: defaultBranchOf(payload),
        installationId,
        deliveryId,
      })
      if (!queued) {
        await safeCommentIssue(repo, number, withMarker(busyText(), MARKERS.failed), installationId)
      }
    } catch (error) {
      logger.warn(`[bigfatfish] approval for ${key} skipped: ${describeError(error)}`)
    } finally {
      // The job clears the reservation when it finishes; failed/no-op paths
      // must release it here.
      if (!queued) inFlightIssues.delete(key)
    }
  }

  /**
   * Approval of a PR conversation comment: treat the comment as review
   * feedback and fix the bot's own PR branch. This is the path that covers
   * "描述改的口语化一点 → @bot → 同意" without a formal GitHub review.
   */
  async function handlePullRequestCommentApproval({ repo, issue, comment, installationId, deliveryId }) {
    const number = issue.number
    const prKey = `${repo}#${number}`
    if (reviewPendingPrs.has(prKey)) return
    reviewPendingPrs.add(prKey)
    let queued = false
    try {
      const comments = await github.listIssueComments(repo, number, installationId)
      if (!comments.some((entry) => hasMarker(entry?.body, MARKERS.ack))) return
      const pull = await github.getPull(repo, number, installationId)
      const head = pull?.head?.ref
      // The agent may choose any branch name now; for non-prefixed branches
      // only accept PRs authored by this bot app.
      const botLogin =
        typeof config.appSlug === 'string' && config.appSlug !== '' ? `${config.appSlug}[bot]`.toLowerCase() : ''
      const authorLogin = typeof pull?.user?.login === 'string' ? pull.user.login.toLowerCase() : ''
      const botAuthored =
        (botLogin !== '' && authorLogin === botLogin) ||
        (pull?.user?.type === 'Bot' && authorLogin.endsWith('[bot]'))
      if (typeof head !== 'string' || head === '') return
      if (!head.startsWith(config.branchPrefix) && !botAuthored) return
      const review = {
        id: Number.isInteger(comment.id) ? comment.id : Date.parse(comment.created_at ?? '') || number,
        state: 'commented',
        body: typeof comment.body === 'string' ? comment.body : '',
        user: comment.user,
      }
      const key = reviewKey(repo, review.id)
      queued = enqueue(repo, {
        kind: 'review',
        repo,
        pullNumber: number,
        review,
        branch: head,
        baseBranch: pull?.base?.ref ?? 'main',
        installationId,
        deliveryId,
        trigger: 'comment',
      })
      if (!queued) {
        await safeCommentPull(repo, number, withMarker(busyText(), MARKERS.failed), installationId)
      } else {
        inFlightReviews.add(key)
      }
    } catch (error) {
      logger.warn(`[bigfatfish] PR comment approval for ${prKey} skipped: ${describeError(error)}`)
    } finally {
      if (!queued) reviewPendingPrs.delete(prKey)
    }
  }

  /** Read-only quota pre-check; `beginIssue` remains the authoritative check. */
  async function quotaAvailable(repo) {
    const snapshot = await usageStore.snapshot()
    const repos = Array.isArray(snapshot?.repos) ? snapshot.repos : []
    const target = String(repo).toLowerCase()
    const entry = repos.find(
      (item) => typeof item?.repo === 'string' && item.repo.toLowerCase() === target,
    )
    const limit = Number.isFinite(entry?.limit) ? entry.limit : config.dailyIssueLimit
    const count = Number.isFinite(entry?.count) ? entry.count : 0
    return count < limit
  }

  // --------------------------------------------------------- review handling

  async function handlePullRequestReviewEvent(payload, repo, allowed, deliveryId) {
    if (payload.action !== 'submitted') return
    if (!allowed) return
    const review = payload.review
    const pull = payload.pull_request
    if (!review || !pull || !Number.isInteger(review.id)) return
    const installationId = installationIdOf(payload)
    if (installationId === null) {
      logger.warn(`[bigfatfish] ${repo}: pull_request_review payload without installation id`)
      return
    }
    const head = pull.head?.ref
    if (typeof head !== 'string' || !head.startsWith(config.branchPrefix)) return
    const number = pull.number
    const state = review.state
    if (state === 'approved') {
      await safeCommentPull(repo, number, withMarker(FIXED.approved, MARKERS.approved), installationId)
      return
    }
    if (state !== 'changes_requested' && state !== 'commented') return
    const hasBody = typeof review.body === 'string' && review.body.trim() !== ''
    if (!hasBody) {
      try {
        const comments = await github.listReviewComments(repo, number, installationId)
        const hasComments = comments.some(
          (comment) =>
            comment &&
            comment.pull_request_review_id === review.id &&
            typeof comment.body === 'string' &&
            comment.body.trim() !== '',
        )
        if (!hasComments) return
      } catch (error) {
        logger.warn(`[bigfatfish] review gate for ${repo}#${number} failed: ${describeError(error)}`)
        return
      }
    }
    const key = reviewKey(repo, review.id)
    if (inFlightReviews.has(key)) return
    const prKey = `${repo}#${number}`
    if (reviewPendingPrs.has(prKey)) return
    inFlightReviews.add(key)
    reviewPendingPrs.add(prKey)
    const accepted = enqueue(repo, {
      kind: 'review',
      repo,
      pullNumber: number,
      review,
      branch: head,
      baseBranch: pull.base?.ref ?? defaultBranchOf(payload),
      installationId,
      deliveryId,
      trigger: 'review',
    })
    if (!accepted) {
      inFlightReviews.delete(key)
      reviewPendingPrs.delete(prKey)
      await safeCommentPull(repo, number, withMarker(busyText(), MARKERS.failed), installationId)
    }
  }

  // ----------------------------------------------------------------- queues

  function queueFor(repo) {
    let queue = queues.get(repo)
    if (queue === undefined) {
      queue = { pending: [], running: false }
      queues.set(repo, queue)
    }
    return queue
  }

  function enqueue(repo, job) {
    const queue = queueFor(repo)
    if (queue.pending.length >= config.maxQueuePerRepo) return false
    queue.pending.push(job)
    void pump(repo)
    return true
  }

  async function pump(repo) {
    const queue = queueFor(repo)
    if (queue.running) return
    queue.running = true
    try {
      while (queue.pending.length > 0) {
        if (lifecycle.signal.aborted) {
          queue.pending.length = 0
          break
        }
        const job = queue.pending.shift()
        await acquireSlot()
        if (lifecycle.signal.aborted) {
          releaseSlot()
          break
        }
        try {
          await processJob(job)
        } catch (error) {
          logger.error(`[bigfatfish] job crashed: ${describeError(error)}`)
        } finally {
          releaseSlot()
        }
      }
    } finally {
      queue.running = false
      if (queue.pending.length > 0 && !lifecycle.signal.aborted) void pump(repo)
    }
  }

  function acquireSlot() {
    if (activeJobs < config.maxConcurrentSessions) {
      activeJobs += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      slotWaiters.push(resolve)
    })
  }

  function releaseSlot() {
    const next = slotWaiters.shift()
    if (next !== undefined) {
      next()
      return
    }
    activeJobs = Math.max(0, activeJobs - 1)
  }

  async function processJob(job) {
    if (job?.kind === 'issue') return processIssueJob(job)
    if (job?.kind === 'triage') return processTriageJob(job)
    if (job?.kind === 'review') return processReviewJob(job)
  }

  // ------------------------------------------------------- triage pipeline

  async function processTriageJob(job) {
    const { repo, issueNumber, installationId } = job
    const deliveryId = job.deliveryId || `triage-${issueNumber}-${Date.now()}`
    const key = issueKey(repo, issueNumber)
    const baseBranch = job.defaultBranch || 'main'
    let sessionResult = null
    let jobContext = null
    try {
      const repoDir = repoDirFor(repo)
      const token = await github.getInstallationToken(installationId)
      await git.ensureRepo({
        repoDir,
        repoFullName: repo,
        defaultBranch: baseBranch,
        token,
        signal: lifecycle.signal,
      })
      await ensureGitExcludes(repoDir)
      const issue = await github.getIssue(repo, issueNumber, installationId)
      const comments = await github.listIssueComments(repo, issueNumber, installationId)
      const memoryFiles = await memoryStore.summary(repo)
      const prompt = buildTriagePrompt({
        repo,
        issue,
        comments,
        branch: baseBranch,
        baseBranch,
        maxChars: config.maxIssueContextChars,
        relay: relayInfo(),
        allowedRepos: Array.isArray(config.allowedRepos) ? config.allowedRepos : [],
        memoryFiles,
      })
      const triagePrimaryState = {
        repo,
        repoDir,
        branch: null,
        baseBranch,
        installationId,
        committedSha: null,
        pushedSha: null,
        prUrl: null,
        prNumber: null,
        isPrimary: true,
      }
      jobContext = {
        repo,
        primaryRepo: repo,
        primaryRepoDir: repoDir,
        branch: null,
        baseBranch,
        installationId,
        issueNumber,
        pullRequest: false,
        sessionStartedAt: Date.now(),
        progressCount: 0,
        lastProgressAt: 0,
        replyContext: null,
        author: commitAuthor(),
        mode: 'triage',
        allowWrite: false,
        approvalRequested: false,
        doneRequested: false,
        replyBody: '',
        repos: { [repo]: triagePrimaryState },
        extraPrs: [],
        finishSummary: '',
      }
      sessionResult = await runAgentSession(ctx, config, {
        repoDir,
        model: effectiveModel(),
        title: `Triage #${issueNumber}: ${truncate(issue.title || '', 48)}`.trim(),
        prompt,
        deliveryId,
        ruleId: RULE_ID,
        resumeSessionId: (await usageStore.findIssueSession(repo, issueNumber)) ?? undefined,
        onSessionReady: (sessionId) => {
          sessionJobs.set(sessionId, jobContext)
        },
      })
      assertSessionSucceeded(sessionResult)
      const text = (jobContext.replyBody || '').trim() ||
        '（这次没有生成回复内容，请维护者补充说明。）'
      const marker = jobContext.approvalRequested ? MARKERS.approvalRequested : MARKERS.triageDone
      const triageReplyParts = [truncate(text, config.maxReplyChars)]
      const triageContext = replyContextAppendix(jobContext)
      if (triageContext !== '') triageReplyParts.push(triageContext)
      triageReplyParts.push(marker)
      await github.commentIssue(repo, issueNumber, triageReplyParts.join('\n\n'), installationId)
      await usageStore.recordIssueSession(repo, issueNumber, sessionResult.sessionId)
      logger.info(
        `[bigfatfish] triage ${key} done${jobContext.approvalRequested ? ' (approval requested)' : ''}`,
      )
    } catch (error) {
      const reason = describeError(error)
      logger.error(`[bigfatfish] triage ${key} failed: ${reason}`)
      await safeCommentIssue(repo, issueNumber, withMarker(failedText(reason), MARKERS.failed), installationId)
    } finally {
      if (sessionResult?.sessionId) sessionJobs.delete(sessionResult.sessionId)
      inFlightIssues.delete(key)
      if (jobContext?.doneRequested) {
        await cleanupRepoWorkspace(repoDirFor(repo), {
          sessionId: sessionResult?.sessionId,
          repo,
          issueNumber,
        })
      } else {
        logger.info(`[bigfatfish] triage ${key}: task not marked done, keeping clone/workspace/session`)
      }
    }
  }

  // ------------------------------------------------------- issue pipeline

  async function processIssueJob(job) {
    const { repo, issueNumber, installationId } = job
    const deliveryId = job.deliveryId || `issue-${issueNumber}-${Date.now()}`
    const key = issueKey(repo, issueNumber)
    const branch = `${config.branchPrefix}${issueNumber}`
    const baseBranch = job.defaultBranch || 'main'
    let sessionResult = null
    let jobContext = null
    try {
      const begun = await usageStore.beginIssue(repo, {
        number: issueNumber,
        title: job.issueTitle || '',
      })
      if (!begun.allowed) {
        await safeCommentIssue(repo, issueNumber, withMarker(limitText(), MARKERS.limit), installationId)
        return
      }
      await github.commentIssue(
        repo,
        issueNumber,
        withMarker(FIXED.started, MARKERS.started),
        installationId,
      )
      const repoDir = repoDirFor(repo)
      const token = await github.getInstallationToken(installationId)
      await git.ensureRepo({
        repoDir,
        repoFullName: repo,
        defaultBranch: baseBranch,
        token,
        signal: lifecycle.signal,
      })
      await ensureGitExcludes(repoDir)
      const issue = await github.getIssue(repo, issueNumber, installationId)
      const comments = await github.listIssueComments(repo, issueNumber, installationId)
      const memoryFiles = await memoryStore.summary(repo)
      const prompt = buildIssuePrompt({
        repo,
        issue,
        comments,
        branch,
        baseBranch,
        maxChars: config.maxIssueContextChars,
        relay: relayInfo(),
        allowedRepos: Array.isArray(config.allowedRepos) ? config.allowedRepos : [],
        memoryFiles,
      })
      const primaryState = {
        repo,
        repoDir,
        branch: null,
        baseBranch,
        installationId,
        committedSha: null,
        pushedSha: null,
        prUrl: null,
        prNumber: null,
        isPrimary: true,
      }
      jobContext = {
        repo,
        primaryRepo: repo,
        primaryRepoDir: repoDir,
        branch: null,
        baseBranch,
        installationId,
        issueNumber,
        pullRequest: false,
        sessionStartedAt: Date.now(),
        progressCount: 0,
        lastProgressAt: 0,
        replyContext: null,
        author: commitAuthor(),
        mode: job.mode || 'owner',
        allowWrite: true,
        approvalRequested: false,
        doneRequested: false,
        replyBody: '',
        repos: { [repo]: primaryState },
        extraPrs: [],
        finishSummary: '',
      }
      sessionResult = await runAgentSession(ctx, config, {
        repoDir,
        model: effectiveModel(),
        title: `Issue #${issueNumber}: ${truncate(issue.title || '', 60)}`.trim(),
        prompt,
        deliveryId,
        ruleId: RULE_ID,
        resumeSessionId: (await usageStore.findIssueSession(repo, issueNumber)) ?? undefined,
        onSessionReady: (sessionId) => {
          sessionJobs.set(sessionId, jobContext)
        },
      })
      assertSessionSucceeded(sessionResult)
      const primary = jobContext.repos[repo]
      const prUrl = primary?.prUrl ?? null
      const extraPrs = Array.isArray(jobContext.extraPrs) ? jobContext.extraPrs : []
      const replyText = (jobContext.replyBody || '').trim()
      const linkLines = []
      if (prUrl) linkLines.push(`PR: ${prUrl}`)
      for (const extra of extraPrs) {
        if (extra && typeof extra.url === 'string' && extra.url !== '') {
          linkLines.push(`PR (${extra.repo}): ${extra.url}`)
        }
      }
      const issueContext = replyContextAppendix(jobContext)
      const replyParts = [truncate(replyText || '✅ 已完成改动并创建 PR。', config.maxReplyChars)]
      if (linkLines.length > 0) replyParts.push(linkLines.join('\n'))
      if (issueContext !== '') replyParts.push(issueContext)
      replyParts.push(MARKERS.started)
      const reply = replyParts.join('\n\n')
      await github.commentIssue(repo, issueNumber, reply, installationId)
      await usageStore.finishIssue(repo, issueNumber, {
        status: 'done',
        prUrl: prUrl ?? null,
        extraPrs: extraPrs.map((extra) => ({ repo: extra.repo, url: extra.url, number: extra.number })),
        branch: primary?.branch ?? null,
        sessionId: sessionResult.sessionId ?? null,
        tokens: tokensOf(sessionResult),
        finishedAt: Date.now(),
        error: null,
      })
      logger.info(
        `[bigfatfish] issue ${key} done${prUrl ? `: ${prUrl}` : ' (no PR)'}` +
          `${extraPrs.length > 0 ? ` + ${extraPrs.length} extra PR(s)` : ''}`,
      )
    } catch (error) {
      const reason = describeError(error)
      logger.error(`[bigfatfish] issue ${key} failed: ${reason}`)
      await safeCommentIssue(repo, issueNumber, withMarker(failedText(reason), MARKERS.failed), installationId)
      try {
        await usageStore.finishIssue(repo, issueNumber, {
          status: 'failed',
          branch,
          sessionId: sessionResult?.sessionId ?? null,
          tokens: tokensOf(sessionResult),
          finishedAt: Date.now(),
          error: reason,
        })
      } catch (finishError) {
        logger.error(`[bigfatfish] could not record failure for ${key}: ${describeError(finishError)}`)
      }
    } finally {
      if (sessionResult?.sessionId) sessionJobs.delete(sessionResult.sessionId)
      inFlightIssues.delete(key)
      if (jobContext?.doneRequested) {
        await cleanupRepoWorkspace(repoDirFor(repo), {
          sessionId: sessionResult?.sessionId,
          repo,
          issueNumber,
        })
      } else {
        logger.info(`[bigfatfish] issue ${key}: task not marked done, keeping clone/workspace/session`)
      }
    }
  }

  // ------------------------------------------------------ review pipeline

  async function processReviewJob(job) {
    const { repo, pullNumber, review, installationId, deliveryId } = job
    const key = reviewKey(repo, review.id)
    const branch = job.branch
    const baseBranch = job.baseBranch || 'main'
    const reviewId = review.id
    let sessionResult = null
    let jobContext = null
    let linkedIssue = null
    try {
      await usageStore.beginReview(repo, { pullNumber, reviewId })
      const repoDir = repoDirFor(repo)
      const token = await github.getInstallationToken(installationId)
      await git.ensureRepo({
        repoDir,
        repoFullName: repo,
        defaultBranch: baseBranch,
        token,
        signal: lifecycle.signal,
      })
      await ensureGitExcludes(repoDir)
      const pull = await github.getPull(repo, pullNumber, installationId)
      const reviews = await github.listReviews(repo, pullNumber, installationId)
      const reviewComments = await github.listReviewComments(repo, pullNumber, installationId)
      const conversation = await github.listIssueComments(repo, pullNumber, installationId)
      const memoryFiles = await memoryStore.summary(repo)
      const prompt = buildReviewPrompt({
        repo,
        pull,
        review,
        reviews,
        reviewComments,
        conversation,
        branch,
        baseBranch,
        maxChars: config.maxIssueContextChars,
        relay: relayInfo(),
        allowedRepos: Array.isArray(config.allowedRepos) ? config.allowedRepos : [],
        memoryFiles,
      })
      linkedIssue = parseBranchIssue(branch, config.branchPrefix)
      const resumeSessionId =
        linkedIssue === null ? undefined : (await usageStore.findIssueSession(repo, linkedIssue)) ?? undefined
      const reviewPrimaryState = {
        repo,
        repoDir,
        branch: null,
        baseBranch,
        installationId,
        committedSha: null,
        pushedSha: null,
        prUrl: null,
        prNumber: pullNumber,
        isPrimary: true,
      }
      jobContext = {
        repo,
        primaryRepo: repo,
        primaryRepoDir: repoDir,
        branch: null,
        baseBranch,
        installationId,
        pullNumber,
        pullRequest: true,
        sessionStartedAt: Date.now(),
        progressCount: 0,
        lastProgressAt: 0,
        replyContext: null,
        author: commitAuthor(),
        allowWrite: true,
        mode: 'review',
        doneRequested: false,
        replyBody: '',
        repos: { [repo]: reviewPrimaryState },
        extraPrs: [],
        finishSummary: '',
      }
      sessionResult = await runAgentSession(ctx, config, {
        repoDir,
        model: effectiveModel(),
        title: `Review PR #${pullNumber}: ${truncate(pull?.title || '', 48)}`.trim(),
        prompt,
        deliveryId,
        ruleId: RULE_ID,
        resumeSessionId,
        onSessionReady: (sessionId) => {
          sessionJobs.set(sessionId, jobContext)
        },
      })
      assertSessionSucceeded(sessionResult)
      const reviewPrimary = jobContext.repos[repo]
      const pushedSha = reviewPrimary?.pushedSha ?? null
      const localCommitSha = reviewPrimary?.committedSha ?? null
      const commitSha = pushedSha
      const commitUrl = commitSha ? `https://github.com/${repo}/commit/${commitSha}` : null
      const replyText = (jobContext.replyBody || '').trim()
      const replyParts = []
      replyParts.push(
        replyText
          ? truncate(replyText, config.maxReplyChars)
          : commitSha
            ? reviewDoneText(shortSha(commitSha))
            : FIXED.reviewNoChange,
      )
      if (commitUrl) replyParts.push(`Commit: ${commitUrl}`)
      if (commitSha === null && localCommitSha !== null) {
        replyParts.push('（本地已有提交但未成功推送，请检查分支后重试）')
      }
      const reviewContext = replyContextAppendix(jobContext)
      if (reviewContext !== '') replyParts.push(reviewContext)
      replyParts.push(MARKERS.reviewDone)
      await github.commentPull(repo, pullNumber, replyParts.join('\n\n'), installationId)
      await usageStore.finishReview(repo, reviewId, {
        status: 'done',
        commitSha,
        tokens: tokensOf(sessionResult),
        finishedAt: Date.now(),
      })
      logger.info(`[bigfatfish] review ${key} done${commitSha ? `: ${commitSha}` : ' (no push)'}`)
    } catch (error) {
      const reason = describeError(error)
      logger.error(`[bigfatfish] review ${key} failed: ${reason}`)
      await safeCommentPull(repo, pullNumber, withMarker(failedText(reason), MARKERS.failed), installationId)
      try {
        await usageStore.finishReview(repo, reviewId, {
          status: 'failed',
          commitSha: null,
          tokens: tokensOf(sessionResult),
          finishedAt: Date.now(),
        })
      } catch (finishError) {
        logger.error(`[bigfatfish] could not record failure for ${key}: ${describeError(finishError)}`)
      }
    } finally {
      if (sessionResult?.sessionId) sessionJobs.delete(sessionResult.sessionId)
      inFlightReviews.delete(key)
      reviewPendingPrs.delete(`${repo}#${pullNumber}`)
      if (jobContext?.doneRequested) {
        await cleanupRepoWorkspace(repoDirFor(repo), {
          sessionId: sessionResult?.sessionId,
          repo,
          issueNumber: linkedIssue ?? undefined,
        })
      } else {
        logger.info(`[bigfatfish] review ${key}: task not marked done, keeping clone/workspace/session`)
      }
    }
  }

  // ----------------------------------------------------------- HTTP routes

  async function readJsonBody(request, limit = 64 * 1024) {
    const chunks = []
    let size = 0
    for await (const raw of request) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      size += chunk.byteLength
      if (size > limit) throw new Error('request body is too large')
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks, size).toString('utf8')
    return text.trim() === '' ? {} : JSON.parse(text)
  }

  function respondJson(response, status, value) {
    const body = JSON.stringify(value)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    response.end(body)
  }

  async function uiSnapshot() {
    const snapshot = await usageStore.snapshot()
    if (snapshot && typeof snapshot === 'object') {
      snapshot.allowedRepos = Array.isArray(config.allowedRepos) ? [...config.allowedRepos] : []
      if (relay !== null) snapshot.relay = relay.snapshot()
    }
    return snapshot
  }

  async function usageHandler(request, response) {
    const method = request?.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
      response.end('Method Not Allowed')
      return
    }
    try {
      const snapshot = await uiSnapshot()
      const body = JSON.stringify(snapshot ?? {})
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      })
      response.end(method === 'HEAD' ? undefined : body)
    } catch (error) {
      logger.error(`[bigfatfish] usage snapshot failed: ${describeError(error)}`)
      response.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ error: 'usage snapshot failed' }))
    }
  }

  function providerCatalog() {
    try {
      return ctx.llm.listProviders().map((provider) => {
        const id = typeof provider?.id === 'string' ? provider.id : typeof provider?.provider === 'string' ? provider.provider : ''
        const name =
          typeof provider?.displayName === 'string'
            ? provider.displayName
            : typeof provider?.name === 'string'
              ? provider.name
              : id
        const rawModels = Array.isArray(provider?.models)
          ? provider.models
          : Array.isArray(provider?.modelList)
            ? provider.modelList
            : []
        const models = rawModels
          .map((model) => (typeof model === 'string' ? model : typeof model?.id === 'string' ? model.id : ''))
          .filter((model) => model !== '')
        return { id, name, models }
      }).filter((provider) => provider.id !== '')
    } catch (error) {
      logger.warn(`[bigfatfish] could not list llm providers: ${describeError(error)}`)
      return []
    }
  }

  /** GET/POST the provider/model used by bot sessions. */
  async function modelHandler(request, response) {
    try {
      if (request.method === 'GET') {
        const selection = effectiveModel()
        const fallback = ctx.agentDefaultModel.currentSelection()
        respondJson(response, 200, {
          provider: selection?.provider ?? fallback.provider,
          model: selection?.model ?? fallback.model,
          override: sessionModel !== null,
          default: { provider: fallback.provider, model: fallback.model },
          providers: providerCatalog(),
        })
        return
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'GET, POST', 'cache-control': 'no-store' })
        response.end('Method Not Allowed')
        return
      }
      const body = await readJsonBody(request)
      if (body?.reset === true) {
        sessionModel = null
        await unlink(storedModelPath()).catch(() => {})
        const selection = effectiveModel()
        const fallback = ctx.agentDefaultModel.currentSelection()
        respondJson(response, 200, {
          ok: true,
          provider: selection?.provider ?? fallback.provider,
          model: selection?.model ?? fallback.model,
          override: false,
        })
        return
      }
      const provider = typeof body?.provider === 'string' ? body.provider.trim() : ''
      const model = typeof body?.model === 'string' ? body.model.trim() : ''
      if (provider === '' || model === '') {
        respondJson(response, 400, { error: 'provider and model are required' })
        return
      }
      const providers = providerCatalog()
      if (providers.length > 0 && !providers.some((entry) => entry.id === provider)) {
        respondJson(response, 400, { error: `unknown provider: ${provider}` })
        return
      }
      await saveStoredModel({ provider, model })
      sessionModel = { provider, model }
      respondJson(response, 200, { ok: true, provider, model, override: true })
    } catch (error) {
      logger.warn(`[bigfatfish] model selection failed: ${describeError(error)}`)
      respondJson(response, 400, { error: 'could not update the session model' })
    }
  }

  /** GET/POST the repository whitelist (stored outside the plugin config). */
  async function reposHandler(request, response) {
    try {
      if (request.method === 'GET') {
        respondJson(response, 200, { repos: Array.isArray(config.allowedRepos) ? config.allowedRepos : [] })
        return
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'GET, POST', 'cache-control': 'no-store' })
        response.end('Method Not Allowed')
        return
      }
      const body = await readJsonBody(request)
      const raw = Array.isArray(body?.repos) ? body.repos : null
      if (raw === null) {
        respondJson(response, 400, { error: 'repos must be an array of owner/repo strings' })
        return
      }
      const repos = []
      for (const value of raw) {
        if (typeof value !== 'string') continue
        const repo = value.trim()
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
          respondJson(response, 400, { error: `invalid repository: ${repo}` })
          return
        }
        if (!repos.includes(repo)) repos.push(repo)
      }
      if (repos.length > 100) {
        respondJson(response, 400, { error: 'at most 100 repositories' })
        return
      }
      await saveStoredRepos(repos)
      config.allowedRepos = repos
      respondJson(response, 200, { ok: true, repos })
    } catch (error) {
      logger.warn(`[bigfatfish] whitelist update failed: ${describeError(error)}`)
      respondJson(response, 400, { error: 'could not update the whitelist' })
    }
  }

  /** Reset today's usage counter and records for one repository. */
  async function resetUsageHandler(request, response) {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' })
      response.end('Method Not Allowed')
      return
    }
    try {
      const body = await readJsonBody(request)
      const repo = typeof body?.repo === 'string' ? body.repo.trim() : ''
      if (repo === '') {
        respondJson(response, 400, { error: 'repo is required' })
        return
      }
      await usageStore.resetRepo(repo)
      respondJson(response, 200, { ok: true, snapshot: await uiSnapshot() })
    } catch (error) {
      logger.warn(`[bigfatfish] usage reset failed: ${describeError(error)}`)
      respondJson(response, 400, { error: 'could not reset usage' })
    }
  }

  // ------------------------------------------------------------- replies

  function replyContextAppendix(jobContext) {
    const rows = Array.isArray(jobContext?.replyContext) ? jobContext.replyContext : []
    const valid = rows.filter((row) => row && typeof row.author === 'string' && typeof row.excerpt === 'string' && row.excerpt.trim() !== '')
    if (valid.length === 0) return ''
    return `---\n**最近的人类回复**\n${valid.map((row) => `- @${row.author}: ${row.excerpt}`).join('\n')}`
  }

  function withMarker(text, marker) {
    return `${text}\n\n${marker}`
  }

  function composeReply({ text, linkLine, marker }) {
    return `${text}\n\n${linkLine}\n${marker}`
  }

  function limitText() {
    const limit = config.dailyIssueLimit
    return `⛔ 该仓库今日已达到上限（${limit}/${limit}），请明天再试。`
  }

  function busyText() {
    return '❌ 自动处理失败：该仓库处理队列已满，请稍后重试。'
  }

  function failedText(reason) {
    const short = String(reason ?? 'unknown error').replace(/[。.!！\s]+$/u, '')
    return `❌ 自动处理失败：${truncate(short, 300)}。可再次回复 /approve 重试。`
  }

  function issueDoneText(url) {
    return `✅ 已创建 PR：${url}`
  }

  function reviewDoneText(sha) {
    return `✅ 已按 review 更新（commit ${sha}）。`
  }

  async function safeCommentIssue(repo, number, body, installationId) {
    try {
      await github.commentIssue(repo, number, body, installationId)
      return true
    } catch (error) {
      logger.warn(`[bigfatfish] comment on ${repo}#${number} failed: ${describeError(error)}`)
      return false
    }
  }

  async function safeCommentPull(repo, number, body, installationId) {
    try {
      await github.commentPull(repo, number, body, installationId)
      return true
    } catch (error) {
      logger.warn(`[bigfatfish] comment on PR ${repo}#${number} failed: ${describeError(error)}`)
      return false
    }
  }

  // -------------------------------------------------------------- helpers

  function storedReposPath() {
    return join(homedir(), '.dsh', 'bigfatfish-bot', 'allowed-repos.json')
  }

  function storedModelPath() {
    return join(homedir(), '.dsh', 'bigfatfish-bot', 'model.json')
  }

  async function loadStoredModel() {
    try {
      const parsed = JSON.parse(await readFile(storedModelPath(), 'utf8'))
      const provider = typeof parsed?.provider === 'string' ? parsed.provider.trim() : ''
      const model = typeof parsed?.model === 'string' ? parsed.model.trim() : ''
      return provider !== '' && model !== '' ? { provider, model } : null
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.warn(`[bigfatfish] could not read ${storedModelPath()}: ${describeError(error)}`)
      return null
    }
  }

  async function saveStoredModel(selection) {
    const file = storedModelPath()
    await mkdir(join(homedir(), '.dsh', 'bigfatfish-bot'), { recursive: true, mode: 0o700 })
    const tmp = `${file}.tmp-${process.pid}`
    await writeFile(tmp, `${JSON.stringify(selection, null, 2)}\n`, { mode: 0o600 })
    await rename(tmp, file)
  }

  /** Provider/model actually used for the next bot session. */
  function effectiveModel() {
    if (sessionModel && sessionModel.provider && sessionModel.model) return { ...sessionModel }
    if (config.modelProvider && config.modelId) {
      return { provider: config.modelProvider, model: config.modelId }
    }
    return undefined
  }

  async function loadStoredRepos() {
    try {
      const parsed = JSON.parse(await readFile(storedReposPath(), 'utf8'))
      const repos = Array.isArray(parsed?.repos) ? parsed.repos : parsed
      if (!Array.isArray(repos)) return null
      return repos.filter((repo) => typeof repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.warn(`[bigfatfish] could not read ${storedReposPath()}: ${describeError(error)}`)
      return null
    }
  }

  async function saveStoredRepos(repos) {
    const file = storedReposPath()
    const dir = join(homedir(), '.dsh', 'bigfatfish-bot')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    let previous = null
    try {
      previous = await readFile(file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (previous !== null) {
      // Never lose an existing production whitelist: keep a timestamped copy
      // of the previous content before every change (the newest five).
      try {
        const parsed = JSON.parse(previous)
        if (Array.isArray(parsed?.repos) && JSON.stringify(parsed.repos) === JSON.stringify(repos)) return
      } catch {
        /* still keep the raw backup below */
      }
      await writeFile(`${file}.bak-${Date.now()}`, previous, { mode: 0o600 }).catch((error) => {
        logger.warn(`[bigfatfish] could not back up ${file}: ${describeError(error)}`)
      })
    }
    const tmp = `${file}.tmp-${process.pid}`
    try {
      await writeFile(tmp, `${JSON.stringify({ repos }, null, 2)}\n`, { mode: 0o600 })
      await rename(tmp, file)
    } catch (error) {
      logger.warn(`[bigfatfish] could not write ${file}: ${describeError(error)}`)
      throw error
    }
    try {
      const backups = (await readdir(dir))
        .filter((name) => name.startsWith('allowed-repos.json.bak-'))
        .sort()
        .reverse()
      for (const stale of backups.slice(5)) await unlink(join(dir, stale)).catch(() => {})
    } catch {
      /* pruning is best effort */
    }
  }

  /** Relay connection facts offered to the model for real-provider tests. */
  function relayInfo() {
    if (relay === null) return undefined
    return {
      baseUrl: `http://${config.relayHost}:${config.relayPort}/v1`,
      apiKey: config.relayKey,
      model: config.relayModel || 'deployment-default',
      creditCny: relay.snapshot().creditCny,
    }
  }

  function repoDirFor(repo) {
    const parts = String(repo).split('/')
    const owner = safeSegment(parts[0] ?? 'unknown')
    const name = safeSegment(parts[1] ?? 'repo')
    return join(config.workspaceRoot, owner, name)
  }

  /**
   * Delete the per-job clone and its DSH workspace registration. Runs after
   * every triage/issue/review job so no repository copy survives on disk.
   */
  async function cleanupRepoWorkspace(repoDir, { sessionId, repo, issueNumber } = {}) {
    const logFile = join(homedir(), '.dsh', 'bigfatfish-bot', 'cleanup.log')
    const note = async (line) => {
      try {
        await appendFile(logFile, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
      } catch {
        /* best effort */
      }
    }
    if (typeof sessionId === 'string' && sessionId !== '') {
      try {
        await ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
        await note(`archived session ${sessionId}`)
      } catch (error) {
        await note(`archive ${sessionId} failed: ${describeError(error)}`)
      }
    }
    if (typeof repo === 'string' && Number.isInteger(issueNumber)) {
      try {
        await usageStore.clearIssueSession(repo, issueNumber)
        await note(`cleared issue session mapping ${repo}#${issueNumber}`)
      } catch (error) {
        await note(`clear mapping ${repo}#${issueNumber} failed: ${describeError(error)}`)
      }
    }
    let workspaceId = null
    try {
      const workspace = await ctx.workspaceRegistry?.resolveByPath?.(repoDir)
      workspaceId = workspace?.id ?? null
    } catch (error) {
      if (error?.code !== 'ENOENT') await note(`resolve ${repoDir}: ${describeError(error)}`)
    }
    try {
      await rm(repoDir, { recursive: true, force: true, maxRetries: 3 })
      await note(`removed clone ${repoDir}`)
    } catch (error) {
      await note(`rm ${repoDir} failed: ${describeError(error)}`)
      logger.warn(`[bigfatfish] could not delete clone ${repoDir}: ${describeError(error)}`)
    }
    if (workspaceId !== null) {
      try {
        await ctx.workspaceRegistry.delete(workspaceId)
        await note(`removed workspace ${workspaceId}`)
      } catch (error) {
        await note(`workspace delete ${workspaceId} failed: ${describeError(error)}`)
        logger.warn(`[bigfatfish] could not remove workspace ${workspaceId}: ${describeError(error)}`)
      }
    }
  }

  /**
   * Keep build/test caches and installed dependencies out of the commit the
   * plugin creates after the session. Written to `.git/info/exclude`, so the
   * repository's own tracked `.gitignore` stays untouched.
   */
  async function ensureGitExcludes(repoDir) {
    const infoDir = join(repoDir, '.git', 'info')
    const excludePath = join(infoDir, 'exclude')
    const entries = [
      '# BigFatFish session caches (never committed)',
      'node_modules/',
      '.cache/',
      '.go-cache/',
      '.go-mod/',
      '.gopath/',
      'coverage.out',
      '*.test',
      '.bigfatfish/',
      'bin/',
      'dist/',
      '*.exe',
      '*.out',
      '*.log',
      '.dsh/',
    ]
    try {
      await mkdir(infoDir, { recursive: true })
      let existing = ''
      try {
        existing = await readFile(excludePath, 'utf8')
      } catch {
        existing = ''
      }
      const present = new Set(existing.split('\n').map((line) => line.trim()))
      const missing = entries.filter((entry) => !present.has(entry))
      if (missing.length > 0) await appendFile(excludePath, `${missing.join('\n')}\n`)
    } catch (error) {
      logger.warn(`[bigfatfish] could not write git excludes in ${repoDir}: ${describeError(error)}`)
    }
  }

  function commitAuthor() {
    return {
      name: botLogin(config.appSlug),
      email: `${config.appId}+${config.appSlug}[bot]@users.noreply.github.com`,
    }
  }

  function commitMessage(scope, title) {
    const trimmedTitle = typeof title === 'string' ? title.trim() : ''
    const suffix = trimmedTitle === '' ? '' : `: ${truncate(trimmedTitle, 72)}`
    return `dsh: ${scope}${suffix}`
  }

  async function createPullSafe({ repo, branch, baseBranch, issue, issueNumber, diffStat, installationId }) {
    const title = truncate(issue?.title || `Fix issue #${issueNumber}`, 240)
    try {
      return await github.createPull(
        repo,
        {
          title,
          head: branch,
          base: baseBranch,
          body: `Closes #${issueNumber}\n\n${diffStat || ''}`,
        },
        installationId,
      )
    } catch (error) {
      // A concurrent run may have created the same branch's PR (HTTP 422).
      if (error instanceof GitHubError && error.status === 422) {
        const existing = await github.findOpenPull(repo, branch, installationId)
        if (existing) return existing
      }
      throw error
    }
  }

  function assertSessionSucceeded(result) {
    if (!result || typeof result !== 'object') throw new Error('agent session returned no result')
    if (result.timedOut) throw new Error('agent session timed out')
    if (result.turnError) throw new Error(`agent turn failed: ${truncate(String(result.turnError), 160)}`)
  }

  function tokensOf(result) {
    const usage = result?.usage
    const input = Number.isFinite(usage?.input) ? usage.input : 0
    const output = Number.isFinite(usage?.output) ? usage.output : 0
    const total = Number.isFinite(usage?.total) ? usage.total : input + output
    return { input, output, total }
  }

  function shortSha(sha) {
    return String(sha ?? '').slice(0, 7)
  }

  function reviewKey(repo, reviewId) {
    return `review:${repo}#${reviewId}`
  }

  function safeSegment(value) {
    return String(value).replace(/[^A-Za-z0-9._-]/g, '_') || '_'
  }

  function describeError(error) {
    if (error instanceof GitHubError) {
      const route = error.route ? ` ${error.method ?? ''} ${error.route}`.trimEnd() : ''
      return error.status > 0
        ? `GitHub API ${error.status}${route === '' ? '' : ` (${route})`}`
        : 'GitHub request failed'
    }
    const message = error instanceof Error ? error.message : String(error)
    const redacted = String(message)
      .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '[redacted]')
      .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '[redacted]')
      .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//[redacted]@')
    return truncate(redacted.trim(), 300) || 'unknown error'
  }

  // --------------------------------------------------------------- register

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: config.usageRoutePath,
        handler: usageHandler,
      }),
    'bigfatfish-bot: usage route',
  )

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: '/bigfatfish/repos', handler: reposHandler }),
    'bigfatfish-bot: whitelist route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/bigfatfish/usage/reset',
        handler: resetUsageHandler,
      }),
    'bigfatfish-bot: usage reset route',
  )

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: '/bigfatfish/model', handler: modelHandler }),
    'bigfatfish-bot: model route',
  )

  // Own signed ingress instead of the optional `dsh-webhook-github` package:
  // the profile cannot resolve that package or schemastery from this linked
  // bundle's realpath, and this endpoint needs no other Harness service.
  const ingress = createIngress({
    host: config.ingressHost,
    port: config.ingressPort,
    path: config.ingressPath,
    source: WEBHOOK_SOURCE,
    secret,
    maxBodyBytes: config.maxBodyBytes,
    logger,
    onDelivery: (delivery) => {
      void ruleRun(delivery)
    },
  })
  await ingress.start()
  ctx.effect(() => () => ingress.dispose(), 'bigfatfish-bot: webhook ingress')

  // Optional loopback OpenAI-compatible relay with a prepaid CNY ledger, used
  // by whitelisted repositories' agent tests (see lib/relay.js).
  if (config.relayEnabled) {
    relay = createRelay({
      host: config.relayHost,
      port: config.relayPort,
      apiKey: config.relayKey,
      priceInputCnyPerM: config.relayPriceInputCnyPerM,
      priceOutputCnyPerM: config.relayPriceOutputCnyPerM,
      initialCreditCny: config.relayInitialCreditCny,
      statePath: join(homedir(), '.dsh', 'bigfatfish-bot', 'relay-credit.json'),
      provider: config.relayProvider,
      model: config.relayModel,
      logger,
      llm: ctx.llm,
      currentSelection: () => ctx.agentDefaultModel.currentSelection(),
    })
    await relay.start()
    ctx.effect(() => () => relay.dispose(), 'bigfatfish-bot: model relay')
  }

  logger.info(
    `[bigfatfish] ready: app ${config.appSlug} (${config.appId}), ` +
      `${config.allowedRepos.length} allowed repo(s), usage at ${config.usageRoutePath}`,
  )
}
