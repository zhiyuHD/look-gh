/**
 * BigFatFish bot — minimal GitHub App REST client.
 *
 * Uses only `node:crypto`, `node:fs/promises` and the global `fetch`. Secrets
 * (the App private key, JWTs and installation tokens) never leave this module:
 * logs carry the HTTP status and route only, never headers or bodies.
 */
import { createSign } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const API_BASE = 'https://api.github.com'
const USER_AGENT = 'bigfatfish-bot'
const API_VERSION = '2022-11-28'
const REQUEST_TIMEOUT_MS = 60_000
const MAX_PAGES = 10
const PAGE_SIZE = 100
/** Installation tokens are cached until five minutes before `expires_at`. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000
/** App JWTs live nine minutes; refresh one minute early. */
const JWT_LIFETIME_MS = 8 * 60 * 1000

/** Error thrown for any non-2xx GitHub REST response or transport failure. */
export class GitHubError extends Error {
  /**
   * @param {string} message human readable summary.
   * @param {{ status?: number, body?: unknown, route?: string, method?: string, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'GitHubError'
    this.status = options.status ?? 0
    this.body = options.body ?? null
    this.route = options.route
    this.method = options.method
  }
}

function base64url(value) {
  return Buffer.from(value).toString('base64url')
}

/**
 * Create one GitHub client. Tokens, JWTs and the private key stay inside this
 * closure; callers only receive the public request helpers.
 * @param {{ appId: string | number, privateKeyPath: string, logger?: any }} options
 */
export function createGitHubClient({ appId, privateKeyPath, logger }) {
  let privateKeyPromise
  let jwtCache

  /** @returns {Promise<string>} PEM private key, read once. */
  function readPrivateKey() {
    privateKeyPromise ??= readFile(privateKeyPath, 'utf8').catch((error) => {
      privateKeyPromise = undefined
      throw error
    })
    return privateKeyPromise
  }

  /** @returns {Promise<string>} RS256 App JWT. */
  async function appJwt() {
    if (jwtCache !== undefined && Date.now() < jwtCache.expiresAt) return jwtCache.value
    const privateKey = await readPrivateKey()
    const issuedAt = Math.floor(Date.now() / 1000)
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const payload = base64url(JSON.stringify({ iat: issuedAt - 60, exp: issuedAt + 540, iss: appId }))
    const unsigned = `${header}.${payload}`
    const signer = createSign('RSA-SHA256')
    signer.update(unsigned)
    signer.end()
    const value = `${unsigned}.${signer.sign(privateKey, 'base64url')}`
    jwtCache = { value, expiresAt: Date.now() + JWT_LIFETIME_MS }
    return value
  }

  /**
   * One raw REST exchange. Never logs headers or bodies.
   * @param {string} method HTTP method.
   * @param {string} route path starting with `/`.
   * @param {unknown} body JSON body, or `undefined`.
   * @param {{ authorization: string }} auth authorization header value.
   */
  async function send(method, route, body, auth) {
    const headers = {
      accept: 'application/vnd.github+json',
      'user-agent': USER_AGENT,
      'x-github-api-version': API_VERSION,
      ...auth,
    }
    if (body !== undefined) headers['content-type'] = 'application/json'
    let response
    try {
      response = await fetch(`${API_BASE}${route}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      logger?.warn?.(`[bigfatfish] github ${method} ${route} transport failure`)
      throw new GitHubError(`github ${method} ${route} transport failure`, {
        route,
        method,
        cause: error,
      })
    }
    const text = response.status === 204 ? '' : await response.text()
    let parsed = null
    if (text !== '') {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
    }
    if (!response.ok) {
      logger?.warn?.(`[bigfatfish] github ${method} ${route} -> ${response.status}`)
      throw new GitHubError(`github ${method} ${route} failed with status ${response.status}`, {
        status: response.status,
        body: parsed,
        route,
        method,
      })
    }
    return parsed
  }

  /** One installation-authenticated request. */
  async function request(installationId, method, route, body) {
    const token = await getInstallationToken(installationId)
    return send(method, route, body, { authorization: `token ${token}` })
  }

  const tokenCache = new Map()

  /**
   * Cached installation access token, refreshed in the last five minutes.
   * @param {number} installationId GitHub App installation id.
   * @returns {Promise<string>}
   */
  async function getInstallationToken(installationId) {
    const key = String(installationId)
    const cached = tokenCache.get(key)
    if (cached !== undefined && Date.now() < cached.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return cached.token
    }
    const jwt = await appJwt()
    const json = await send(
      'POST',
      `/app/installations/${encodeURIComponent(key)}/access_tokens`,
      undefined,
      { authorization: `Bearer ${jwt}` },
    )
    const token = json?.token
    if (typeof token !== 'string' || token === '') {
      throw new GitHubError('github installation token response had no token', {
        status: 500,
        route: '/app/installations/:id/access_tokens',
        method: 'POST',
      })
    }
    const expiresAt = Date.parse(json?.expires_at)
    tokenCache.set(key, {
      token,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 55 * 60 * 1000,
    })
    return token
  }

  /** Page through one list route, up to {@link MAX_PAGES} pages. */
  async function listPaged(installationId, route) {
    const separator = route.includes('?') ? '&' : '?'
    const items = []
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const rows = await request(
        installationId,
        'GET',
        `${route}${separator}per_page=${PAGE_SIZE}&page=${page}`,
      )
      if (!Array.isArray(rows) || rows.length === 0) break
      items.push(...rows)
      if (rows.length < PAGE_SIZE) break
    }
    return items
  }

  function repoRoute(repo) {
    return `/repos/${repo}`
  }

  return {
    /** GET /app (App JWT). */
    async getApp() {
      const jwt = await appJwt()
      return send('GET', '/app', undefined, { authorization: `Bearer ${jwt}` })
    },

    getInstallationToken,

    request,

    /**
     * POST an issue comment.
     * @param {string} repo `owner/repo`.
     * @param {number} number issue number.
     * @param {string} body markdown body.
     * @param {number} installationId installation id.
     */
    async commentIssue(repo, number, body, installationId) {
      return request(installationId, 'POST', `${repoRoute(repo)}/issues/${number}/comments`, { body })
    },

    /** GET one issue. */
    async getIssue(repo, number, installationId) {
      return request(installationId, 'GET', `${repoRoute(repo)}/issues/${number}`)
    },

    /** GET repository metadata (default branch, owner, ...). */
    async getRepo(repo, installationId) {
      return request(installationId, 'GET', repoRoute(repo))
    },

    /** All issue comments (at most 10 pages of 100). */
    async listIssueComments(repo, number, installationId) {
      return listPaged(installationId, `${repoRoute(repo)}/issues/${number}/comments`)
    },

    /**
     * Create a pull request.
     * @param {string} repo `owner/repo`.
     * @param {{ title: string, head: string, base: string, body?: string }} pull
     * @param {number} installationId installation id.
     */
    async createPull(repo, { title, head, base, body }, installationId) {
      return request(installationId, 'POST', `${repoRoute(repo)}/pulls`, { title, head, base, body })
    },

    /**
     * First open pull request whose head matches `head`.
     * `head` may already be `owner:branch`; a plain branch name gets the
     * repository owner prefixed automatically.
     * @returns {Promise<any | null>}
     */
    async findOpenPull(repo, head, installationId) {
      const owner = String(repo).split('/')[0]
      const headParam =
        typeof head === 'string' && head.includes(':') ? head : `${owner}:${String(head)}`
      const rows = await request(
        installationId,
        'GET',
        `${repoRoute(repo)}/pulls?head=${encodeURIComponent(headParam)}&state=open&per_page=${PAGE_SIZE}`,
      )
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null
    },

    /** GET one pull request. */
    async getPull(repo, number, installationId) {
      return request(installationId, 'GET', `${repoRoute(repo)}/pulls/${number}`)
    },

    /** All submitted reviews of one pull request. */
    async listReviews(repo, number, installationId) {
      return listPaged(installationId, `${repoRoute(repo)}/pulls/${number}/reviews`)
    },

    /** All inline review comments of one pull request. */
    async listReviewComments(repo, number, installationId) {
      return listPaged(installationId, `${repoRoute(repo)}/pulls/${number}/comments`)
    },

    /** POST a pull request conversation comment (issues comment endpoint). */
    async commentPull(repo, number, body, installationId) {
      return request(installationId, 'POST', `${repoRoute(repo)}/issues/${number}/comments`, { body })
    },

    /** GET /users/:login (App JWT). */
    async getUser(login) {
      const jwt = await appJwt()
      return send('GET', `/users/${encodeURIComponent(String(login))}`, undefined, {
        authorization: `Bearer ${jwt}`,
      })
    },
  }
}
