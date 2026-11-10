/**
 * Per-repository, per-day accounting for BigFatFish bot sessions.
 *
 * The store is a single JSON document kept outside the profile:
 *
 * ```json
 * { "days": { "YYYY-MM-DD": { "repos": { "owner/repo": { "count": 0, "issues": [], "reviews": [] } } } } }
 * ```
 *
 * Only the last 7 days are retained. Writes are serialized, atomic (write to
 * `<file>.tmp-<pid>-<n>` then `rename`), and the file/directory are created
 * 0600/0700 so the counters are private to the user.
 *
 * `snapshot()` is synchronous and returns the shape shared with the Web client
 * (CONTRACT.md §6).
 *
 * @module bigfatfish-bot/lib/usage-store
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const RETAIN_DAYS = 7
const DEFAULT_LIMIT = 5
const DEFAULT_TIME_ZONE = 'Asia/Shanghai'
const EMPTY_TOKENS = Object.freeze({ input: 0, output: 0, total: 0 })

/**
 * `'YYYY-MM-DD'` in `timeZone` (CONTRACT.md §4: `Intl.DateTimeFormat('en-CA')`).
 * Duplicated locally instead of importing decisions.js so this module has no
 * cross-file dependency and can be smoke-tested on its own.
 * @param {string} timeZone
 * @param {number} [now]
 * @returns {string}
 */
function todayKey(timeZone, now = Date.now()) {
  const zone = typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone : DEFAULT_TIME_ZONE
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now)
  } catch {
    // Invalid time zone: fall back to UTC so accounting never throws.
    return new Date(now).toISOString().slice(0, 10)
  }
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function countOf(value) {
  return isNumber(value) && value > 0 ? Math.floor(value) : 0
}

function copyTokens(tokens) {
  const source = tokens && typeof tokens === 'object' ? tokens : {}
  return {
    input: countOf(source.input),
    output: countOf(source.output),
    total: countOf(source.total),
  }
}

function addTokens(target, tokens) {
  const source = tokens && typeof tokens === 'object' ? tokens : {}
  target.input += countOf(source.input)
  target.output += countOf(source.output)
  target.total += countOf(source.total)
  return target
}

function mergeTokens(base, patch) {
  const next = copyTokens(base)
  if (patch && typeof patch === 'object') {
    if (isNumber(patch.input)) next.input = countOf(patch.input)
    if (isNumber(patch.output)) next.output = countOf(patch.output)
    if (isNumber(patch.total)) next.total = countOf(patch.total)
  }
  return next
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

/** Keep the 7 most recent day keys ending at (and including) `current`. */
function pruneDays(days, current) {
  const keys = Object.keys(days).sort()
  const index = keys.indexOf(current)
  const keep = new Set(
    index >= 0 ? keys.slice(Math.max(0, index - (RETAIN_DAYS - 1))) : keys.slice(-RETAIN_DAYS),
  )
  let changed = false
  for (const key of keys) {
    if (!keep.has(key)) {
      delete days[key]
      changed = true
    }
  }
  return changed
}

/** Guard a value loaded from disk into the expected in-memory state. */
function normalizeLoadedState(parsed) {
  if (!parsed || typeof parsed !== 'object' || !parsed.days || typeof parsed.days !== 'object') {
    return { days: {} }
  }
  const days = {}
  for (const [date, bucket] of Object.entries(parsed.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const repos = {}
    const rawRepos = bucket && typeof bucket === 'object' && bucket.repos && typeof bucket.repos === 'object'
      ? bucket.repos
      : {}
    for (const [repo, entry] of Object.entries(rawRepos)) {
      if (!entry || typeof entry !== 'object') continue
      const triageSessions = {}
      if (entry.triageSessions && typeof entry.triageSessions === 'object') {
        for (const [issueNumber, sessionId] of Object.entries(entry.triageSessions)) {
          if (/^\d+$/.test(issueNumber) && typeof sessionId === 'string' && sessionId !== '') {
            triageSessions[issueNumber] = sessionId
          }
        }
      }
      repos[repo] = {
        count: countOf(entry.count),
        triageSessions,
        issues: safeArray(entry.issues)
          .filter((issue) => issue && typeof issue === 'object')
          .map((issue) => ({ ...issue, tokens: copyTokens(issue.tokens) })),
        reviews: safeArray(entry.reviews)
          .filter((review) => review && typeof review === 'object')
          .map((review) => ({ ...review, tokens: copyTokens(review.tokens) })),
      }
    }
    days[date] = { repos }
  }
  return { days }
}

/**
 * Create a usage store.
 * @param {{ filePath: string, limit?: number, timeZone?: string, logger?: any }} options
 */
export function createUsageStore({ filePath, limit, timeZone, logger } = {}) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new TypeError('createUsageStore: `filePath` must be a non-empty string')
  }
  const storePath = path.resolve(filePath)
  const dirPath = path.dirname(storePath)
  const dailyLimit =
    typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT
  const zone = typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone : DEFAULT_TIME_ZONE

  let state = { days: {} }
  let currentDate = todayKey(zone)
  let updatedAt = Date.now()
  let initialized = false
  let initPromise = null
  let queue = Promise.resolve()
  let writeCounter = 0

  /** Run one operation after every previously enqueued operation settled. */
  function enqueue(operation) {
    const next = queue.then(operation)
    queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /** Roll the current day and drop out-of-window days (in memory). */
  function roll() {
    const date = todayKey(zone)
    if (date !== currentDate) currentDate = date
    return pruneDays(state.days, currentDate)
  }

  function dayRepos() {
    if (!state.days[currentDate] || typeof state.days[currentDate] !== 'object') {
      state.days[currentDate] = { repos: {} }
    }
    const day = state.days[currentDate]
    if (!day.repos || typeof day.repos !== 'object') day.repos = {}
    return day.repos
  }

  function repoEntry(repo) {
    const repos = dayRepos()
    if (!repos[repo] || typeof repos[repo] !== 'object') {
      repos[repo] = { count: 0, issues: [], reviews: [] }
    }
    const entry = repos[repo]
    if (!Array.isArray(entry.issues)) entry.issues = []
    if (!Array.isArray(entry.reviews)) entry.reviews = []
    if (!entry.triageSessions || typeof entry.triageSessions !== 'object') entry.triageSessions = {}
    entry.count = countOf(entry.count)
    return entry
  }

  /** Atomic, mode-preserving persistence. */
  async function save() {
    await mkdir(dirPath, { recursive: true, mode: 0o700 })
    await chmod(dirPath, 0o700).catch(() => {})
    const tmpPath = `${storePath}.tmp-${process.pid}-${writeCounter++}`
    const payload = `${JSON.stringify(state, null, 2)}\n`
    try {
      await writeFile(tmpPath, payload, { mode: 0o600 })
      await chmod(tmpPath, 0o600).catch(() => {})
      await rename(tmpPath, storePath)
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => {})
      throw error
    }
    updatedAt = Date.now()
  }

  async function ensureInit() {
    await init()
  }

  /**
   * Load the store (creating the directory/file if needed). Idempotent: later
   * calls await the same initialization.
   */
  async function init() {
    if (initialized) return
    if (initPromise === null) {
      initPromise = enqueue(async () => {
        await mkdir(dirPath, { recursive: true, mode: 0o700 })
        await chmod(dirPath, 0o700).catch(() => {})
        let loaded = { days: {} }
        try {
          const text = await readFile(storePath, 'utf8')
          loaded = normalizeLoadedState(JSON.parse(text))
        } catch (error) {
          if (error && error.code !== 'ENOENT') {
            logger?.warn?.(`usage store: could not read ${storePath}, starting empty (${error.message ?? error})`)
          }
          loaded = { days: {} }
        }
        state = loaded
        currentDate = todayKey(zone)
        roll()
        await save()
        initialized = true
        logger?.info?.(`usage store ready at ${storePath} (date ${currentDate})`)
      }).catch((error) => {
        // Allow a later call to retry after a transient filesystem failure.
        initPromise = null
        throw error
      })
    }
    await initPromise
  }

  function snapshotIssues(issues) {
    return safeArray(issues)
      .map((issue, index) => ({ issue, index }))
      .sort(
        (a, b) =>
          countOf(b.issue.startedAt) - countOf(a.issue.startedAt) ||
          b.index - a.index,
      )
      .map(({ issue }) => {
        const copy = { ...issue }
        copy.tokens = copyTokens(issue.tokens)
        return copy
      })
  }

  function snapshotReviews(reviews) {
    return safeArray(reviews)
      .map((review, index) => ({ review, index }))
      .sort(
        (a, b) =>
          countOf(b.review.startedAt) - countOf(a.review.startedAt) ||
          b.index - a.index,
      )
      .map(({ review }) => {
        const copy = { ...review }
        copy.tokens = copyTokens(review.tokens)
        return copy
      })
  }

  /**
   * Current-day view shared with `/bigfatfish/usage` and the Web client.
   * Synchronous: it only folds the in-memory state.
   */
  function snapshot() {
    roll()
    const repos = []
    const totals = { issues: 0, reviews: 0, tokens: { ...EMPTY_TOKENS } }
    const day = state.days[currentDate]
    const rawRepos = day && day.repos && typeof day.repos === 'object' ? day.repos : {}

    for (const [repo, entry] of Object.entries(rawRepos)) {
      const issues = snapshotIssues(entry.issues)
      const reviews = snapshotReviews(entry.reviews)
      const tokens = { ...EMPTY_TOKENS }
      for (const issue of issues) addTokens(tokens, issue.tokens)
      for (const review of reviews) addTokens(tokens, review.tokens)
      totals.issues += issues.length
      totals.reviews += reviews.length
      addTokens(totals.tokens, tokens)
      repos.push({
        repo,
        count: countOf(entry.count),
        limit: dailyLimit,
        tokens,
        issues,
        reviews,
      })
    }

    repos.sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo))
    return {
      date: currentDate,
      timeZone: zone,
      limit: dailyLimit,
      updatedAt,
      totals,
      repos,
    }
  }

  /**
   * Reserve one implementation session for `repo` today.
   * @param {string} repo `owner/repo`
   * @param {{ number: number, title?: string }} issue
   * @returns {Promise<{ allowed: boolean, count: number, record?: object }>}
   */
  async function beginIssue(repo, issue = {}) {
    await ensureInit()
    return enqueue(async () => {
      const pruned = roll()
      const entry = repoEntry(repo)
      if (entry.count >= dailyLimit) {
        if (pruned) await save()
        logger?.warn?.(`usage: ${repo} reached the daily limit (${entry.count}/${dailyLimit})`)
        return { allowed: false, count: entry.count }
      }
      entry.count += 1
      const record = {
        number: issue.number ?? null,
        title: typeof issue.title === 'string' ? issue.title : '',
        status: 'running',
        startedAt: Date.now(),
        tokens: { ...EMPTY_TOKENS },
        error: null,
      }
      entry.issues.push(record)
      await save()
      return { allowed: true, count: entry.count, record: { ...record, tokens: { ...record.tokens } } }
    })
  }

  const ISSUE_PATCH_FIELDS = ['status', 'prUrl', 'extraPrs', 'branch', 'sessionId', 'error', 'finishedAt']

  /**
   * Merge the outcome of one issue session into its newest record.
   * @param {string} repo
   * @param {number} number
   * @param {{ status?: string, prUrl?: string, branch?: string, sessionId?: string, error?: string | null, tokens?: object, finishedAt?: number }} patch
   * @returns {Promise<object | null>} the updated record (copy), or null when unknown
   */
  async function finishIssue(repo, number, patch = {}) {
    await ensureInit()
    return enqueue(async () => {
      roll()
      const entry = state.days[currentDate]?.repos?.[repo]
      const issues = safeArray(entry?.issues)
      let record = null
      for (const candidate of issues) {
        if (candidate && (candidate.number === number || candidate.number === Number(number))) record = candidate
      }
      if (record === null) {
        logger?.warn?.(`usage: finishIssue(${repo}#${number}) found no record`)
        return null
      }
      for (const field of ISSUE_PATCH_FIELDS) {
        if (patch[field] !== undefined) record[field] = patch[field]
      }
      if (patch.tokens !== undefined) record.tokens = mergeTokens(record.tokens, patch.tokens)
      if (record.finishedAt === undefined) record.finishedAt = Date.now()
      if (record.status === 'running') record.status = 'done'
      await save()
      return { ...record, tokens: copyTokens(record.tokens) }
    })
  }

  /**
   * Record one review-triggered session (reviews never consume the issue quota).
   * @param {string} repo
   * @param {{ pullNumber: number, reviewId: number }} review
   * @returns {Promise<{ record: object }>}
   */
  async function beginReview(repo, review = {}) {
    await ensureInit()
    return enqueue(async () => {
      roll()
      const entry = repoEntry(repo)
      const record = {
        pullNumber: review.pullNumber ?? null,
        reviewId: review.reviewId ?? null,
        status: 'running',
        startedAt: Date.now(),
        tokens: { ...EMPTY_TOKENS },
        commitSha: null,
      }
      entry.reviews.push(record)
      await save()
      return { record: { ...record, tokens: { ...record.tokens } } }
    })
  }

  const REVIEW_PATCH_FIELDS = ['status', 'commitSha', 'error', 'finishedAt']

  /**
   * Merge the outcome of one review session into its record.
   * @param {string} repo
   * @param {number} reviewId
   * @param {{ status?: string, commitSha?: string, error?: string | null, tokens?: object, finishedAt?: number }} patch
   * @returns {Promise<object | null>} the updated record (copy), or null when unknown
   */
  async function finishReview(repo, reviewId, patch = {}) {
    await ensureInit()
    return enqueue(async () => {
      roll()
      const entry = state.days[currentDate]?.repos?.[repo]
      const reviews = safeArray(entry?.reviews)
      const record = reviews.find(
        (candidate) => candidate && (candidate.reviewId === reviewId || candidate.reviewId === Number(reviewId)),
      )
      if (record === undefined) {
        logger?.warn?.(`usage: finishReview(${repo}/${reviewId}) found no record`)
        return null
      }
      for (const field of REVIEW_PATCH_FIELDS) {
        if (patch[field] !== undefined) record[field] = patch[field]
      }
      if (patch.tokens !== undefined) record.tokens = mergeTokens(record.tokens, patch.tokens)
      if (record.finishedAt === undefined) record.finishedAt = Date.now()
      if (record.status === 'running') record.status = 'done'
      await save()
      return { ...record, tokens: copyTokens(record.tokens) }
    })
  }

  /**
   * Remember the DSH session that triaged/answered one issue, so a later
   * approval or review continues the same conversation.
   */
  async function recordIssueSession(repo, number, sessionId) {
    await ensureInit()
    return enqueue(async () => {
      roll()
      const entry = repoEntry(repo)
      if (typeof sessionId === 'string' && sessionId !== '') {
        entry.triageSessions[String(number)] = sessionId
        await save()
      }
    })
  }

  /**
   * Session id previously used for one issue of one repository (triage/answer
   * session first, then a recorded implementation session).
   * @returns {Promise<string | null>}
   */
  async function findIssueSession(repo, number) {
    await ensureInit()
    return enqueue(async () => {
      roll()
      const entry = state.days[currentDate]?.repos?.[repo]
      const triaged = entry?.triageSessions?.[String(number)]
      if (typeof triaged === 'string' && triaged !== '') return triaged
      const issues = safeArray(entry?.issues)
      let found = null
      for (const candidate of issues) {
        if (candidate && (candidate.number === number || candidate.number === Number(number))) {
          if (typeof candidate.sessionId === 'string' && candidate.sessionId !== '') found = candidate.sessionId
        }
      }
      return found
    })
  }

  /** Forget the session mapping for one issue (its session is archived). */
  async function clearIssueSession(repo, number) {
    await ensureInit()
    return enqueue(async () => {
      roll()
      const entry = state.days[currentDate]?.repos?.[repo]
      if (!entry) return false
      let changed = false
      if (entry.triageSessions && Object.prototype.hasOwnProperty.call(entry.triageSessions, String(number))) {
        delete entry.triageSessions[String(number)]
        changed = true
      }
      for (const issue of safeArray(entry.issues)) {
        if (issue && (issue.number === number || issue.number === Number(number)) && issue.sessionId !== undefined) {
          issue.sessionId = null
          changed = true
        }
      }
      if (changed) await save()
      return changed
    })
  }

  /** Reset today's usage counter and records for one repository. */
  async function resetRepo(repo) {
    await ensureInit()
    return enqueue(async () => {
      roll()
      const entry = repoEntry(repo)
      entry.count = 0
      entry.issues = []
      entry.reviews = []
      entry.triageSessions = {}
      await save()
      return true
    })
  }

  return {
    init,
    snapshot,
    beginIssue,
    finishIssue,
    beginReview,
    finishReview,
    findIssueSession,
    recordIssueSession,
    clearIssueSession,
    resetRepo,
  }
}
