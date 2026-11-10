/**
 * BigFatFish bot — pure decision helpers.
 *
 * No I/O, no DSH services: every function here is deterministic so the event
 * dispatch rules can be unit-checked without a running Host.
 */

/** Comment markers used to recognize our own replies. */
export const MARKERS = {
  ack: '<!-- bigfatfish:ack -->',
  unsupported: '<!-- bigfatfish:unsupported -->',
  started: '<!-- bigfatfish:started -->',
  limit: '<!-- bigfatfish:limit -->',
  failed: '<!-- bigfatfish:failed -->',
  approved: '<!-- bigfatfish:approved -->',
  reviewDone: '<!-- bigfatfish:review-done -->',
  triageDone: '<!-- bigfatfish:triage-done -->',
  approvalRequested: '<!-- bigfatfish:approval-requested -->',
}

/**
 * Calendar day key in the configured time zone.
 * @param {string} timeZone IANA time zone name, for example `Asia/Shanghai`.
 * @param {number} [now] epoch milliseconds, defaults to `Date.now()`.
 * @returns {string} `YYYY-MM-DD`.
 */
export function todayKey(timeZone, now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(now))
}

/**
 * GitHub login of the App bot user.
 * @param {string} slug App slug.
 * @returns {string} for example `bigfatfish-bot[bot]`.
 */
export function botLogin(slug) {
  return `${slug}[bot]`
}

/**
 * Whether a webhook payload was produced by a bot account.
 * @param {any} payload GitHub webhook payload.
 * @returns {boolean}
 */
export function isBotSender(payload) {
  const sender = payload?.sender
  if (!sender || typeof sender !== 'object') return false
  if (sender.type === 'Bot') return true
  return typeof sender.login === 'string' && sender.login.endsWith('[bot]')
}

/**
 * `owner/repo` of the payload repository.
 * @param {any} payload GitHub webhook payload.
 * @returns {string | undefined}
 */
export function repoFullName(payload) {
  const full = payload?.repository?.full_name
  return typeof full === 'string' && full ? full : undefined
}

/**
 * Case-insensitive whitelist check.
 * @param {{ allowedRepos?: string[] }} config plugin config.
 * @param {string} repo `owner/repo`.
 * @returns {boolean}
 */
export function isRepoAllowed(config, repo) {
  if (typeof repo !== 'string' || repo === '') return false
  const allowed = config?.allowedRepos
  if (!Array.isArray(allowed)) return false
  const target = repo.toLowerCase()
  return allowed.some((entry) => typeof entry === 'string' && entry.toLowerCase() === target)
}

/**
 * Whether some text mentions the bot.
 * Matches `@mention` and `@mention[bot]`, case-insensitively.
 * @param {unknown} text text to inspect.
 * @param {string} mention configured mention name.
 * @returns {boolean}
 */
export function hasMention(text, mention) {
  if (typeof text !== 'string' || !text) return false
  if (typeof mention !== 'string' || !mention) return false
  const handle = mention.toLowerCase().replace(/^@/, '')
  const haystack = text.toLowerCase()
  return haystack.includes(`@${handle}`) || haystack.includes(`@${handle}[bot]`)
}

/**
 * Whether an `author_association` is allowed to approve.
 * @param {{ approvalAssociations?: string[] }} config plugin config.
 * @param {unknown} assoc payload `author_association`.
 * @returns {boolean}
 */
export function associationAllowed(config, assoc) {
  const list = config?.approvalAssociations
  return Array.isArray(list) && typeof assoc === 'string' && list.includes(assoc)
}

/**
 * Approval comment rule.
 *
 * Deny keywords win over approval keywords, `/approve` as a prefix is always an
 * approval, and only short comments count (a long design discussion that happens
 * to contain “同意” must not start a session).
 * @param {{ approvalKeywords?: string[], denyKeywords?: string[] }} config plugin config.
 * @param {unknown} text comment body.
 * @returns {boolean}
 */
export function isApproval(config, text) {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > 200) return false
  const haystack = trimmed.toLowerCase()
  const deny = config?.denyKeywords
  if (Array.isArray(deny)) {
    for (const keyword of deny) {
      if (typeof keyword !== 'string' || !keyword) continue
      if (haystack.includes(keyword.toLowerCase())) return false
    }
  }
  if (haystack.startsWith('/approve')) return true
  const approve = config?.approvalKeywords
  if (!Array.isArray(approve)) return false
  for (const keyword of approve) {
    if (typeof keyword !== 'string' || !keyword) continue
    if (haystack.includes(keyword.toLowerCase())) return true
  }
  return false
}

/**
 * Whether a comment body already carries one of our markers.
 * @param {unknown} body comment body.
 * @param {string} marker one of {@link MARKERS}.
 * @returns {boolean}
 */
export function hasMarker(body, marker) {
  return typeof body === 'string' && typeof marker === 'string' && marker !== '' && body.includes(marker)
}

/**
 * Issue number embedded in a `branchPrefix`-prefixed branch name.
 * @param {unknown} branch branch name.
 * @param {string} prefix configured branch prefix.
 * @returns {number | null}
 */
export function parseBranchIssue(branch, prefix) {
  if (typeof branch !== 'string' || !branch) return null
  if (typeof prefix !== 'string' || prefix === '' || !branch.startsWith(prefix)) return null
  const match = branch.slice(prefix.length).match(/^(\d+)(?:[^0-9].*)?$/)
  return match ? Number(match[1]) : null
}

/**
 * Hard truncation without exceeding `max` characters.
 * @param {unknown} text text to truncate.
 * @param {number} max maximum character count.
 * @returns {string}
 */
export function truncate(text, max) {
  if (typeof text !== 'string') return ''
  if (!Number.isFinite(max) || max <= 0) return ''
  return text.length > max ? text.slice(0, max) : text
}

/**
 * Stable key for one issue of one repository.
 * @param {string} repo `owner/repo`.
 * @param {number} number issue number.
 * @returns {string}
 */
export function issueKey(repo, number) {
  return `${repo}#${number}`
}
