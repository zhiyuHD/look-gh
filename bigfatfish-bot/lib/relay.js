/**
 * BigFatFish bot — tiny local OpenAI-compatible relay.
 *
 * Lets a whitelisted repository's test suite call an LLM without the repository
 * ever holding the owner's DeepSeek credential: the relay is bound to loopback,
 * accepts an OpenAI-shaped `/v1/chat/completions` request, performs the call
 * through the harness `llm` service (the owner's configured route/model), and
 * deducts a prepaid CNY credit from a small persisted ledger.
 *
 * Credit is a blunt budget guard, not billing: price per million tokens is
 * configuration, and an exhausted ledger answers HTTP 402 until the owner
 * tops it up via `POST /bigfatfish/relay/topup` or by editing the state file.
 *
 * @module bigfatfish-bot/lib/relay
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const MAX_BODY_BYTES = 4 * 1024 * 1024

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function openAiError(response, status, message, type = 'invalid_request_error', code = undefined) {
  sendJson(response, status, { error: { message, type, code, param: null } })
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && part.type === 'text' && typeof part.text === 'string') return part.text
      if (part && part.type === 'image_url') return '[image]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

async function readBody(request) {
  const declared = request.headers['content-length']
  if (declared !== undefined && Number(declared) > MAX_BODY_BYTES) throw new Error('body too large')
  const chunks = []
  let size = 0
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

function messagesOf(body) {
  const systemParts = []
  const messages = []
  for (const item of Array.isArray(body.messages) ? body.messages : []) {
    const role = item?.role
    const text = textOfContent(item?.content)
    if (role === 'system' || role === 'developer') {
      if (text !== '') systemParts.push(text)
    } else if (role === 'assistant') {
      if (text !== '') messages.push({ role: 'assistant', text })
    } else if (role === 'tool' || role === 'function') {
      if (text !== '') messages.push({ role: 'user', text: `[${role} result]\n${text}` })
    } else {
      if (text !== '') messages.push({ role: 'user', text })
    }
  }
  return { system: systemParts.join('\n\n'), messages }
}

/** Convert relay messages into the harness request shape. */
function toRequestMessages(items, provider, model) {
  return items.map((item) => {
    const content = [{ type: 'text', text: item.text }]
    if (item.role === 'assistant') {
      return { id: randomUUID(), role: 'assistant', content, source: { kind: 'model', provider, model } }
    }
    return { role: 'user', content }
  })
}

function finishReasonOf(chunk) {
  const kind = chunk?.reason?.kind
  if (kind === 'stop') return 'stop'
  if (kind === 'max-tokens') return 'length'
  if (kind === 'tool-calls') return 'tool_calls'
  return kind ?? 'stop'
}

/**
 * @param {{
 *   host: string, port: number, apiKey: string,
 *   priceInputCnyPerM: number, priceOutputCnyPerM: number, initialCreditCny: number,
 *   statePath: string, provider?: string, model?: string,
 *   logger?: any, llm: any, currentSelection: () => { provider: string, model: string },
 * }} options
 */
export function createRelay(options) {
  const {
    host,
    port,
    apiKey,
    priceInputCnyPerM,
    priceOutputCnyPerM,
    initialCreditCny,
    statePath,
    logger,
    llm,
    currentSelection,
  } = options
  if (typeof llm?.stream !== 'function') throw new Error('relay: the harness llm service is unavailable')

  let server = null
  let closed = false
  let ledger = {
    creditCny: initialCreditCny,
    spentCny: 0,
    inputTokens: 0,
    outputTokens: 0,
    requests: 0,
    updatedAt: 0,
  }
  let queue = Promise.resolve()

  function enqueue(operation) {
    const next = queue.then(operation)
    queue = next.then(() => undefined, () => undefined)
    return next
  }

  async function load() {
    try {
      const parsed = JSON.parse(await readFile(statePath, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        ledger = {
          creditCny: Number.isFinite(parsed.creditCny) ? parsed.creditCny : initialCreditCny,
          spentCny: Number.isFinite(parsed.spentCny) ? parsed.spentCny : 0,
          inputTokens: Number.isFinite(parsed.inputTokens) ? parsed.inputTokens : 0,
          outputTokens: Number.isFinite(parsed.outputTokens) ? parsed.outputTokens : 0,
          requests: Number.isFinite(parsed.requests) ? parsed.requests : 0,
          updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0,
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') logger?.warn?.(`relay: could not read ledger (${error?.message ?? error})`)
    }
  }

  async function save() {
    await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 })
    const tmp = `${statePath}.tmp-${process.pid}`
    try {
      await writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 })
      await chmod(tmp, 0o600).catch(() => {})
      await rename(tmp, statePath)
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {})
      throw error
    }
  }

  function snapshot() {
    return {
      creditCny: Math.round(ledger.creditCny * 1e6) / 1e6,
      spentCny: Math.round(ledger.spentCny * 1e6) / 1e6,
      inputTokens: ledger.inputTokens,
      outputTokens: ledger.outputTokens,
      requests: ledger.requests,
      priceInputCnyPerM,
      priceOutputCnyPerM,
      updatedAt: ledger.updatedAt,
    }
  }

  /** Observe an owner edit of the state file (manual top-up) before charging. */
  async function refreshFromDisk() {
    try {
      const parsed = JSON.parse(await readFile(statePath, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        if (Number.isFinite(parsed.creditCny) && parsed.creditCny > ledger.creditCny) {
          ledger.creditCny = parsed.creditCny
          ledger.updatedAt = Date.now()
          await save()
        }
      }
    } catch {
      /* absent file is fine */
    }
  }

  function charge(inputTokens, outputTokens) {
    const cost =
      (inputTokens / 1e6) * priceInputCnyPerM + (outputTokens / 1e6) * priceOutputCnyPerM
    ledger.creditCny = Math.round((ledger.creditCny - cost) * 1e6) / 1e6
    ledger.spentCny = Math.round((ledger.spentCny + cost) * 1e6) / 1e6
    ledger.inputTokens += inputTokens
    ledger.outputTokens += outputTokens
    ledger.requests += 1
    ledger.updatedAt = Date.now()
    return cost
  }

  async function handleChat(request, response, body) {
    const auth = request.headers.authorization ?? ''
    if (apiKey !== '' && auth !== `Bearer ${apiKey}`) return openAiError(response, 401, 'invalid relay api key', 'authentication_error')
    let bodyValue
    try {
      bodyValue = JSON.parse(body)
    } catch {
      return openAiError(response, 400, 'body is not valid JSON')
    }
    const { system, messages } = messagesOf(bodyValue)
    if (messages.length === 0) return openAiError(response, 400, 'messages must contain at least one message')

    await refreshFromDisk()
    if (ledger.creditCny <= 0) {
      return openAiError(response, 402, 'BigFatFish relay credit is exhausted; ask the owner to top up', 'insufficient_quota', 'credit_exhausted')
    }

    const selection = currentSelection?.() ?? {}
    const provider = (typeof options.provider === 'string' && options.provider) || selection.provider
    const model = (typeof options.model === 'string' && options.model) || selection.model
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
      return openAiError(response, 503, 'relay has no configured model route', 'server_error')
    }
    const requestMessages = toRequestMessages(messages, provider, model)
    const wantsStream = bodyValue.stream === true
    const id = `chatcmpl-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    const controller = new AbortController()
    request.on('close', () => controller.abort())

    let text = ''
    let usage = { inputTokens: 0, outputTokens: 0 }
    let finish = 'stop'
    let streamStarted = false

    try {
      const stream = llm.stream({
        provider,
        model,
        system: system === '' ? undefined : system,
        messages: requestMessages,
        temperature: Number.isFinite(bodyValue.temperature) ? bodyValue.temperature : undefined,
        maxTokens: Number.isFinite(bodyValue.max_tokens) ? bodyValue.max_tokens : undefined,
        signal: controller.signal,
        purpose: 'relay',
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          text += chunk.text
          if (wantsStream && !streamStarted) {
            response.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-store',
              connection: 'keep-alive',
            })
            streamStarted = true
          }
          if (wantsStream) {
            response.write(
              `data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }],
              })}\n\n`,
            )
          }
        } else if (chunk?.type === 'usage' && chunk.usage) {
          usage = {
            inputTokens: Number.isFinite(chunk.usage.inputTokens) ? chunk.usage.inputTokens : usage.inputTokens,
            outputTokens: Number.isFinite(chunk.usage.outputTokens) ? chunk.usage.outputTokens : usage.outputTokens,
          }
        } else if (chunk?.type === 'finish') {
          const kind = chunk?.reason?.kind
          if (kind === 'error' || kind === 'aborted') {
            const failure = chunk?.reason?.failure
            throw new Error(failure?.message ? `model call failed: ${failure.message}` : `model call ${kind}`)
          }
          finish = finishReasonOf(chunk)
        }
      }
    } catch (error) {
      logger?.warn?.(`relay: upstream call failed: ${error?.message ?? error}`)
      if (wantsStream && streamStarted) {
        response.write(`data: ${JSON.stringify({ error: { message: 'upstream call failed', type: 'server_error' } })}\n\n`)
        response.end('data: [DONE]\n\n')
        return
      }
      return openAiError(response, 502, 'upstream model call failed', 'server_error')
    }

    const measured = await enqueue(async () => {
      const cost = charge(usage.inputTokens, usage.outputTokens)
      ledger.updatedAt = Date.now()
      await save()
      return { cost, snapshot: snapshot() }
    })
    const totalTokens = usage.inputTokens + usage.outputTokens
    logger?.info?.(
      `relay: ${usage.inputTokens}+${usage.outputTokens} tokens, charged ¥${measured.cost.toFixed(6)}, left ¥${measured.snapshot.creditCny.toFixed(4)}`,
    )

    if (wantsStream) {
      if (!streamStarted) {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
        streamStarted = true
      }
      response.write(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: finish }],
          usage: { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: totalTokens },
        })}\n\n`,
      )
      response.end('data: [DONE]\n\n')
      return
    }

    sendJson(response, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: finish,
        },
      ],
      usage: {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: totalTokens,
      },
      'x_bigfatfish_credit_cny': measured.snapshot.creditCny,
    })
  }

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://relay.local')
    try {
      if (url.pathname === '/v1/models' && request.method === 'GET') {
        const auth = request.headers.authorization ?? ''
        if (apiKey !== '' && auth !== `Bearer ${apiKey}`) return openAiError(response, 401, 'invalid relay api key', 'authentication_error')
        const selection = currentSelection?.() ?? {}
        const model = (typeof options.model === 'string' && options.model) || selection.model
        return sendJson(response, 200, {
          object: 'list',
          data: [{ id: model, object: 'model', created: 0, owned_by: 'bigfatfish-relay' }],
        })
      }
      if (url.pathname === '/bigfatfish/relay' && request.method === 'GET') {
        return sendJson(response, 200, snapshot())
      }
      if (url.pathname === '/bigfatfish/relay/topup' && request.method === 'POST') {
        const body = await readBody(request)
        const value = JSON.parse(body)
        const cny = Number(value?.cny)
        if (!Number.isFinite(cny) || cny <= 0) return openAiError(response, 400, 'cny must be a positive number')
        await enqueue(async () => {
          ledger.creditCny = Math.round((ledger.creditCny + cny) * 1e6) / 1e6
          ledger.updatedAt = Date.now()
          await save()
        })
        return sendJson(response, 200, snapshot())
      }
      if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
        const body = await readBody(request)
        return await handleChat(request, response, body)
      }
      return openAiError(response, 404, 'not found')
    } catch (error) {
      logger?.warn?.(`relay: request failed: ${error?.message ?? error}`)
      if (!response.headersSent) return openAiError(response, 500, 'relay failed', 'server_error')
      response.end()
    }
  }

  return {
    async start() {
      if (server !== null) return
      await load()
      server = createServer((request, response) => {
        void handle(request, response)
      })
      server.on('clientError', (error, socket) => {
        logger?.warn?.(`relay: client error: ${error?.message ?? error}`)
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      })
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          resolve()
        })
      })
      logger?.info?.(`relay listening on http://${host}:${port}/v1 (credit ¥${ledger.creditCny.toFixed(2)})`)
    },
    async dispose() {
      if (closed) return
      closed = true
      const active = server
      server = null
      if (active === null) return
      await new Promise((resolve) => {
        active.close(() => resolve())
        active.closeAllConnections?.()
      })
    },
    snapshot,
    async topUp(cny) {
      return enqueue(async () => {
        ledger.creditCny = Math.round((ledger.creditCny + cny) * 1e6) / 1e6
        ledger.updatedAt = Date.now()
        await save()
        return snapshot()
      })
    },
  }
}
