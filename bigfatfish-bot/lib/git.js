/**
 * Git plumbing for BigFatFish bot.
 *
 * All GitHub traffic goes through `https://github.com/<repo>.git` with the App
 * installation token supplied as `GH_TOKEN` to a throwaway `GIT_ASKPASS`
 * script. The token is therefore never written to disk, never part of a
 * command line (visible in `ps`), and never written to a log line.
 *
 * @module bigfatfish-bot/lib/git
 */

import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** `GIT_ASKPASS` helper: username is fixed, password comes from `GH_TOKEN`. */
const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  Username*) printf '%s\\n' x-access-token ;;
  *) printf '%s\\n' "$GH_TOKEN" ;;
esac
`

const STDOUT_LIMIT = 256 * 1024
const STDERR_LIMIT = 32 * 1024
const STDERR_SUMMARY_LIMIT = 2000

const DEFAULT_AUTHOR = {
  name: 'bigfatfish-bot',
  email: 'bigfatfish-bot@users.noreply.github.com',
}

/**
 * Failure of one git invocation.
 *
 * `message` carries a short stderr summary so callers can surface the reason
 * without needing the raw capture; `stderr` keeps the full (already limited)
 * capture for diagnostics. Neither the token nor the environment is attached.
 */
export class GitError extends Error {
  constructor(message, { args = [], cwd, code = null, signal = null, stderr = '', stdout = '' } = {}) {
    super(message)
    this.name = 'GitError'
    this.args = args
    this.cwd = cwd
    this.code = code
    this.signal = signal
    this.stderr = stderr
    this.stdout = stdout
  }
}

/** Collapse the tail of stderr into one bounded summary line. */
function summarizeStderr(stderr) {
  const text = String(stderr ?? '').trim()
  if (!text) return ''
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const summary = lines.slice(-8).join(' | ')
  return summary.length > STDERR_SUMMARY_LIMIT ? `…${summary.slice(-STDERR_SUMMARY_LIMIT)}` : summary
}

function failureMessage(args, { code, signal, stderr }) {
  const summary = summarizeStderr(stderr)
  const status = code === null || code === undefined ? `signal ${signal ?? 'unknown'}` : `exit ${code}`
  return `git ${args.join(' ')} failed (${status})${summary ? `: ${summary}` : ''}`
}

/** Normalize `author` (`'Name <mail>'`, `{ name, email }`, or nothing). */
function normalizeAuthor(author) {
  if (typeof author === 'string') {
    const text = author.trim()
    const matched = /^(.*?)\s*<([^>]+)>\s*$/.exec(text)
    if (matched) {
      return { name: matched[1].trim() || DEFAULT_AUTHOR.name, email: matched[2].trim() }
    }
    return { name: text || DEFAULT_AUTHOR.name, email: DEFAULT_AUTHOR.email }
  }
  if (author && typeof author === 'object') {
    const name = typeof author.name === 'string' && author.name.trim() ? author.name.trim() : DEFAULT_AUTHOR.name
    const email = typeof author.email === 'string' && author.email.trim() ? author.email.trim() : DEFAULT_AUTHOR.email
    return { name, email }
  }
  return DEFAULT_AUTHOR
}

function requireRepoDir(repoDir) {
  if (typeof repoDir !== 'string' || repoDir.trim().length === 0) {
    throw new TypeError('git: `repoDir` must be a non-empty string')
  }
  return path.resolve(repoDir)
}

/** Spawn one git process and capture bounded output. */
function spawnGit(args, { cwd, env, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let child

    const fail = (error) => {
      if (settled) return
      settled = true
      if (error && (error.name === 'AbortError' || signal?.aborted)) {
        reject(new GitError(`git ${args.join(' ')} aborted`, { args, cwd, stderr: '' }))
        return
      }
      reject(
        new GitError(`failed to run git ${args.join(' ')}: ${error?.message ?? String(error)}`, {
          args,
          cwd,
          stderr: '',
        }),
      )
    }

    const done = (code, signalName) => {
      if (settled) return
      settled = true
      resolve({ code, signal: signalName, stdout, stderr })
    }

    try {
      child = spawn('git', args, { cwd, env, signal, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      fail(error)
      return
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (stdout.length < STDOUT_LIMIT) stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk
    })
    child.on('error', fail)
    child.on('close', done)
  })
}

/** Build the per-call git runner; the token only ever names an askpass script. */
function createRunner(logger) {
  async function run(args, { cwd, token, signal }) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    let askpassDir
    let execArgs = args
    if (typeof token === 'string' && token.length > 0) {
      // A fresh 0700 directory per call; the script holds no secret itself and
      // is removed as soon as the process has exited.
      askpassDir = await mkdtemp(path.join(tmpdir(), 'bigfatfish-askpass-'))
      const scriptPath = path.join(askpassDir, 'askpass.sh')
      await writeFile(scriptPath, ASKPASS_SCRIPT, { mode: 0o700 })
      await chmod(scriptPath, 0o700)
      env.GIT_ASKPASS = scriptPath
      env.GH_TOKEN = token
      env.GIT_ASKPASS_REQUIRE = 'force'
      // Never fall back to a stored credential helper: the installation token
      // must be the only credential used, and nothing may be persisted.
      execArgs = ['-c', 'credential.helper=', ...args]
    }
    logger?.info?.(`git ${args.join(' ')} (cwd: ${cwd})`)
    try {
      return await spawnGit(execArgs, { cwd, env, signal })
    } finally {
      if (askpassDir !== undefined) {
        await rm(askpassDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }
  return run
}

/** Create the git operations used by the issue/review pipelines. */
export function createGit(logger) {
  const run = createRunner(logger)

  async function tryRun(args, options) {
    return await run(args, options)
  }

  async function mustRun(args, options) {
    const result = await run(args, options)
    if (result.code !== 0) {
      // Copy only non-secret fields: `options.token` must never land on an
      // error object that a caller (or a logger) may serialize.
      throw new GitError(failureMessage(args, result), {
        args,
        cwd: options.cwd,
        code: result.code,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
      })
    }
    return result
  }

  async function refExists(cwd, ref, signal) {
    const result = await tryRun(['rev-parse', '--verify', '--quiet', ref], { cwd, signal })
    return result.code === 0
  }

  /** Best-effort origin default branch name (`main`, `master`, …). */
  async function resolveDefaultBranch(cwd, signal) {
    const symbolic = await tryRun(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
      cwd,
      signal,
    })
    if (symbolic.code === 0) {
      const ref = symbolic.stdout.trim()
      if (ref.startsWith('origin/')) return ref.slice('origin/'.length)
    }
    for (const candidate of ['main', 'master']) {
      if (await refExists(cwd, `origin/${candidate}`, signal)) return candidate
    }
    return null
  }

  async function cloneOrFetch({ dir, repoFullName, defaultBranch, token, signal }) {
    const url = `https://github.com/${repoFullName}.git`
    let isRepo = false
    try {
      await stat(path.join(dir, '.git'))
      isRepo = true
    } catch {
      isRepo = false
    }

    if (!isRepo) {
      logger?.info?.(`cloning https://github.com/${repoFullName}.git into ${dir}`)
      await mustRun(['clone', '--depth', '50', '--no-single-branch', url, dir], {
        cwd: path.dirname(dir),
        token,
        signal,
      })
      // Clone already records this URL; re-assert it so credentials never ride
      // along inside the remote URL.
      await mustRun(['remote', 'set-url', 'origin', url], { cwd: dir, signal })
      return
    }

    const origin = await tryRun(['remote', 'get-url', 'origin'], { cwd: dir, signal })
    if (origin.code !== 0) {
      await mustRun(['remote', 'add', 'origin', url], { cwd: dir, signal })
    }
    if (typeof defaultBranch === 'string' && defaultBranch.trim().length > 0) {
      await mustRun(['fetch', 'origin', defaultBranch.trim()], { cwd: dir, token, signal })
    } else {
      await mustRun(['fetch', 'origin'], { cwd: dir, token, signal })
    }
  }

  /**
   * Clone the repository on first use, otherwise fetch the default branch.
   * @param {{ repoDir: string, repoFullName: string, defaultBranch?: string, token?: string, signal?: AbortSignal }} options
   */
  async function ensureRepo({ repoDir, repoFullName, defaultBranch, token, signal }) {
    const dir = requireRepoDir(repoDir)
    if (typeof repoFullName !== 'string' || !repoFullName.includes('/')) {
      throw new TypeError('git.ensureRepo: `repoFullName` must look like "owner/repo"')
    }
    await mkdir(dir, { recursive: true })
    await cloneOrFetch({ dir, repoFullName, defaultBranch, token, signal })
    logger?.info?.(`repo ready at ${dir}`)
  }

  /**
   * Reset the working copy onto a fresh branch cut from `origin/<baseBranch>`.
   * @param {{ repoDir: string, branch: string, baseBranch?: string, token?: string, signal?: AbortSignal }} options
   */
  async function checkoutFresh({ repoDir, branch, baseBranch, token, signal }) {
    const dir = requireRepoDir(repoDir)
    if (typeof branch !== 'string' || branch.trim().length === 0) {
      throw new TypeError('git.checkoutFresh: `branch` must be a non-empty string')
    }
    const wanted = branch.trim()
    await mustRun(['fetch', 'origin'], { cwd: dir, token, signal })

    let base = typeof baseBranch === 'string' && baseBranch.trim().length > 0 ? baseBranch.trim() : null
    if (base === null) base = await resolveDefaultBranch(dir, signal)
    if (base !== null) await tryRun(['fetch', 'origin', base], { cwd: dir, token, signal })

    const startRef = base === null ? 'origin/HEAD' : `origin/${base}`
    if (!(await refExists(dir, startRef, signal))) {
      throw new GitError(
        `git.checkoutFresh: base ref '${startRef}' not found in ${dir} (base branch: ${base ?? 'unknown'})`,
        { args: ['checkout', '-B', wanted, startRef], cwd: dir },
      )
    }
    await mustRun(['checkout', '-B', wanted, startRef], { cwd: dir, token, signal })
    await mustRun(['reset', '--hard'], { cwd: dir, signal })
    await mustRun(['clean', '-fd'], { cwd: dir, signal })
    logger?.info?.(`checked out fresh branch ${wanted} from ${startRef}`)
  }

  /**
   * Check out an existing remote branch (review pipeline), falling back to the
   * origin default branch when the branch has disappeared.
   * @param {{ repoDir: string, branch: string, token?: string, signal?: AbortSignal }} options
   */
  async function checkoutExisting({ repoDir, branch, token, signal }) {
    const dir = requireRepoDir(repoDir)
    if (typeof branch !== 'string' || branch.trim().length === 0) {
      throw new TypeError('git.checkoutExisting: `branch` must be a non-empty string')
    }
    const wanted = branch.trim()
    await mustRun(['fetch', 'origin'], { cwd: dir, token, signal })

    const remoteRef = `origin/${wanted}`
    if (!(await refExists(dir, remoteRef, signal))) {
      await tryRun(['fetch', 'origin', `+refs/heads/${wanted}:refs/remotes/origin/${wanted}`], {
        cwd: dir,
        token,
        signal,
      })
    }

    if (await refExists(dir, remoteRef, signal)) {
      await mustRun(['checkout', '-B', wanted, remoteRef], { cwd: dir, token, signal })
    } else {
      const base = await resolveDefaultBranch(dir, signal)
      if (base === null) {
        throw new GitError(`git.checkoutExisting: branch '${wanted}' and origin default branch not found`, {
          args: ['checkout', '-B', wanted, remoteRef],
          cwd: dir,
        })
      }
      logger?.warn?.(`branch '${wanted}' missing on origin; falling back to '${base}'`)
      await tryRun(['fetch', 'origin', base], { cwd: dir, token, signal })
      await mustRun(['checkout', '-B', wanted, `origin/${base}`], { cwd: dir, token, signal })
    }
    await mustRun(['reset', '--hard'], { cwd: dir, signal })
    await mustRun(['clean', '-fd'], { cwd: dir, signal })
    logger?.info?.(`checked out existing branch ${wanted}`)
  }

  /**
   * Stage everything and commit when the tree changed.
   * @param {{ repoDir: string, message?: string, author?: string | { name?: string, email?: string }, signal?: AbortSignal }} options
   * @returns {Promise<{ committed: boolean, sha: string | null }>}
   */
  async function commitAll({ repoDir, message, author, signal }) {
    const dir = requireRepoDir(repoDir)
    const { name, email } = normalizeAuthor(author)
    await mustRun(['add', '-A'], { cwd: dir, signal })
    const status = await mustRun(['status', '--porcelain'], { cwd: dir, signal })
    if (status.stdout.trim().length === 0) {
      logger?.info?.('no changes to commit')
      return { committed: false, sha: await headSha({ repoDir: dir, signal }) }
    }
    const text =
      typeof message === 'string' && message.trim().length > 0
        ? message.trim()
        : 'chore: automated changes by bigfatfish-bot'
    await mustRun(['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-m', text], {
      cwd: dir,
      signal,
    })
    const sha = (await mustRun(['rev-parse', 'HEAD'], { cwd: dir, signal })).stdout.trim() || null
    logger?.info?.(`committed ${sha ?? '(unknown)'}`)
    return { committed: true, sha }
  }

  /**
   * Push the current `HEAD` to `origin/<branch>`.
   *
   * The first attempt is a plain push. A branch that survived a previous failed
   * attempt can be non-fast-forward, so a rejected push is retried once with
   * `--force-with-lease` (the lease keeps a human's newer push safe).
   * @param {{ repoDir: string, branch: string, token?: string, signal?: AbortSignal }} options
   */
  async function push({ repoDir, branch, token, signal }) {
    const dir = requireRepoDir(repoDir)
    if (typeof branch !== 'string' || branch.trim().length === 0) {
      throw new TypeError('git.push: `branch` must be a non-empty string')
    }
    const wanted = branch.trim()
    try {
      await mustRun(['push', 'origin', wanted], { cwd: dir, token, signal })
    } catch (error) {
      const stderr = error instanceof GitError ? error.stderr : ''
      if (!/rejected|non-fast-forward|fetch first|stale info/i.test(stderr)) throw error
      logger?.warn?.(`push of ${wanted} was rejected; retrying with --force-with-lease`)
      await mustRun(['push', '--force-with-lease', 'origin', wanted], { cwd: dir, token, signal })
    }
    logger?.info?.(`pushed ${wanted}`)
  }

  /**
   * Short summary of the change set: uncommitted diff first, then the last
   * commit's shortstat (the usual call site is right after `commitAll`).
   * @param {{ repoDir: string, signal?: AbortSignal }} options
   * @returns {Promise<string>} e.g. `3 files changed, 12 insertions(+)` or `''`
   */
  async function diffStat({ repoDir, signal }) {
    const dir = requireRepoDir(repoDir)
    const working = await tryRun(['diff', '--shortstat', 'HEAD'], { cwd: dir, signal })
    const workingLine = working.code === 0 ? working.stdout.trim() : ''
    if (workingLine) return workingLine
    const committed = await tryRun(['show', '--shortstat', '--pretty=format:', 'HEAD'], { cwd: dir, signal })
    if (committed.code !== 0) return ''
    return committed.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' ')
  }

  /**
   * Current `HEAD` commit sha, or `null` when the repository has no commit.
   * @param {{ repoDir: string, signal?: AbortSignal }} options
   * @returns {Promise<string | null>}
   */
  async function headSha({ repoDir, signal }) {
    const dir = requireRepoDir(repoDir)
    const result = await tryRun(['rev-parse', 'HEAD'], { cwd: dir, signal })
    if (result.code !== 0) return null
    return result.stdout.trim() || null
  }

  /** Fetch all remote branches (used by the agent's branch-selection tool). */
  async function fetchOrigin({ repoDir, token, signal }) {
    const dir = requireRepoDir(repoDir)
    // Explicit refspec: works even for older single-branch/shallow clones.
    await mustRun(
      ['fetch', '--depth', '50', 'origin', '--prune', '+refs/heads/*:refs/remotes/origin/*'],
      { cwd: dir, token, signal },
    )
  }

  /** Whether `origin/<branch>` exists locally after a fetch. */
  async function remoteBranchExists({ repoDir, branch, signal }) {
    const dir = requireRepoDir(repoDir)
    if (typeof branch !== 'string' || branch.trim() === '') return false
    return await refExists(dir, `origin/${branch.trim()}`, signal)
  }

  /** Check out (or create) one branch at an explicit start ref, cleanly. */
  async function checkoutBranch({ repoDir, branch, startRef, token, signal }) {
    const dir = requireRepoDir(repoDir)
    const wanted = String(branch ?? '').trim()
    const start = String(startRef ?? '').trim()
    if (wanted === '' || start === '') throw new TypeError('git.checkoutBranch: branch and startRef are required')
    await mustRun(['checkout', '-B', wanted, start], { cwd: dir, token, signal })
    await mustRun(['reset', '--hard'], { cwd: dir, signal })
    await mustRun(['clean', '-fd'], { cwd: dir, signal })
    logger?.info?.(`checked out ${wanted} from ${start}`)
  }

  /** Current branch name, or `null` for a detached HEAD. */
  async function currentBranch({ repoDir, signal }) {
    const dir = requireRepoDir(repoDir)
    const result = await tryRun(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, signal })
    if (result.code !== 0) return null
    const name = result.stdout.trim()
    return name === '' || name === 'HEAD' ? null : name
  }

  return {
    ensureRepo,
    checkoutFresh,
    checkoutExisting,
    fetchOrigin,
    remoteBranchExists,
    checkoutBranch,
    currentBranch,
    commitAll,
    push,
    diffStat,
    headSha,
  }
}
