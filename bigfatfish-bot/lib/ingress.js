/**
 * BigFatFish bot — signed GitHub webhook ingress.
 *
 * A tiny `node:http` endpoint that plays the role of the shipped
 * `@deepseek-ai/dsh-webhook-github` adapter without requiring that package in
 * the profile: bounded UTF-8 body intake, `X-Hub-Signature-256` HMAC-SHA256
 * verification, lossless JSON object admission, then a fire-and-forget
 * `onDelivery` call and an immediate `202`.
 *
 * @module bigfatfish-bot/lib/ingress
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024

/** Refusal whose message is safe to return without reflecting request data. */
class IngressError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'IngressError'
    this.status = status
  }
}

function respond(response, status, message) {
  if (message === undefined) {
    response.writeHead(status)
    response.end()
    return
  }
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(message)
}

/** `application/json` with at most one UTF-8 charset parameter. */
function isJsonContentType(value) {
  if (typeof value !== 'string') return false
  const parts = value.split(';').map((part) => part.trim())
  const [mediaType, parameter, ...extra] = parts
  if ((mediaType ?? '').toLowerCase() !== 'application/json') return false
  if (parameter === undefined) return true
  return extra.length === 0 && /^charset=(?:utf-8|"utf-8")$/i.test(parameter)
}

function singleHeader(request, name) {
  const values = request.headersDistinct?.[name]
  const value = values?.[0]
  if (values?.length !== 1 || value === undefined || value.trim() === '') {
    throw new IngressError(400, `missing ${name} header`)
  }
  return value
}

function declaredLength(request) {
  const raw = request.headers['content-length']
  if (raw === undefined) return undefined
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new IngressError(400, 'invalid Content-Length')
  const length = Number(raw)
  if (!Number.isSafeInteger(length)) throw new IngressError(413, 'request body is too large')
  return length
}

async function readBoundedBody(request, maxBodyBytes) {
  const declared = declaredLength(request)
  if (declared !== undefined && declared > maxBodyBytes) {
    request.resume()
    throw new IngressError(413, 'request body is too large')
  }
  const chunks = []
  let size = 0
  try {
    for await (const raw of request) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      size += chunk.byteLength
      if (size > maxBodyBytes) {
        request.resume()
        throw new IngressError(413, 'request body is too large')
      }
      chunks.push(chunk)
    }
  } catch (error) {
    if (error instanceof IngressError) throw error
    throw new IngressError(400, 'request body was aborted')
  }
  if (!request.complete) throw new IngressError(400, 'request body was aborted')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))
  } catch {
    throw new IngressError(400, 'request body is not valid UTF-8')
  }
}

/** Validate one `sha256=<hex>` signature against the raw body. */
function verifySignature(secret, body, signature) {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signature.trim())
  if (match === null) return false
  const expected = Buffer.from(match[1].toLowerCase(), 'hex')
  const actual = createHmac('sha256', secret).update(body).digest()
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function parsePayload(body) {
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new IngressError(400, 'request body is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new IngressError(400, 'GitHub webhook payload must be a JSON object')
  }
  return parsed
}

/**
 * Create one signed GitHub ingress endpoint.
 * @param {{
 *   host: string,
 *   port: number,
 *   path: string,
 *   source: string,
 *   secret: string,
 *   maxBodyBytes?: number,
 *   logger?: any,
 *   onDelivery: (delivery: any) => void,
 * }} options
 */
export function createIngress({
  host,
  port,
  path,
  source,
  secret,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  logger,
  onDelivery,
}) {
  if (typeof host !== 'string' || host.trim() === '') throw new TypeError('ingress: host must be a non-empty string')
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new TypeError('ingress: port must be a valid TCP port')
  if (typeof path !== 'string' || !path.startsWith('/') || path === '/') {
    throw new TypeError('ingress: path must be an absolute non-root pathname')
  }
  if (typeof secret !== 'string' || secret === '') throw new TypeError('ingress: secret must be non-empty')
  if (typeof onDelivery !== 'function') throw new TypeError('ingress: onDelivery must be a function')

  let server = null
  let closed = false

  async function handle(request, response) {
    try {
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST')
        throw new IngressError(405, 'method not allowed')
      }
      const pathname = new URL(request.url ?? '/', 'http://ingress.local').pathname
      if (pathname !== path) throw new IngressError(404, 'not found')
      if (!isJsonContentType(request.headers['content-type'])) {
        throw new IngressError(415, 'content type must be application/json')
      }
      const bodyText = await readBoundedBody(request, maxBodyBytes)
      const signature = singleHeader(request, 'x-hub-signature-256')
      const deliveryId = singleHeader(request, 'x-github-delivery')
      const eventName = singleHeader(request, 'x-github-event')
      if (!verifySignature(secret, bodyText, signature)) throw new IngressError(401, 'invalid webhook signature')
      const payload = parsePayload(bodyText)
      const delivery = {
        kind: 'github',
        source,
        deliveryId,
        event: { name: eventName, payload },
        receivedAt: Date.now(),
      }
      // Fire-and-forget: the provider only learns that the delivery was
      // accepted; rules must never delay the acknowledgement.
      try {
        onDelivery(delivery)
      } catch (error) {
        logger?.warn?.(`ingress: delivery handler threw: ${error?.message ?? error}`)
      }
      respond(response, 202)
    } catch (error) {
      if (error instanceof IngressError) {
        respond(response, error.status, error.message)
        return
      }
      logger?.warn?.(`ingress: request failed: ${error?.message ?? error}`)
      respond(response, 503, 'webhook ingress is unavailable')
    }
  }

  return {
    /** Bind the listener. Rejects on bind failure. */
    async start() {
      if (server !== null) return
      server = createServer((request, response) => {
        void handle(request, response)
      })
      server.on('clientError', (error, socket) => {
        logger?.warn?.(`ingress: client error: ${error?.message ?? error}`)
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      })
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          resolve()
        })
      })
      logger?.info?.(`ingress listening on http://${host}:${port}${path} (source ${source})`)
    },
    /** Stop accepting requests and close the listener. */
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
  }
}
