/**
 * BigFatFish bot — per-repository project memory.
 *
 * Memory lives outside every session workspace:
 *   ~/.dsh/bigfatfish-bot/memory/<owner>/<repo>/*.md
 *
 * Only regular `.md` files are accepted (no symlinks, no subdirectories, no
 * path traversal). This store survives workspace and session cleanup, so the
 * bot can carry knowledge from one PR to the next.
 *
 * @module bigfatfish-bot/lib/memory
 */

import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/
const DEFAULT_MAX_FILE_BYTES = 256 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_FILES = 500
const MAX_LIST = 200

function safeSegment(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9_.-]/g, '_')
}

/**
 * @param {{ logger?: any, maxFileBytes?: number, maxTotalBytes?: number, maxFiles?: number }} [options]
 */
export function createMemoryStore({
  logger,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
} = {}) {
  const rootDir = path.join(homedir(), '.dsh', 'bigfatfish-bot', 'memory')

  function repoDirFor(repo) {
    const text = String(repo ?? '').trim()
    if (!REPO_PATTERN.test(text)) throw new Error('memory: repo must look like owner/repo')
    const [owner, name] = text.split('/')
    return path.join(rootDir, safeSegment(owner), safeSegment(name))
  }

  function assertName(name) {
    const text = String(name ?? '').trim()
    if (!NAME_PATTERN.test(text) || text === '.' || text === '..' || text.includes('/') || text.includes('\\')) {
      throw new Error('memory: name must be a plain file name ending in .md (for example notes.md)')
    }
    return text
  }

  async function ensureRepoDir(repo) {
    const dir = repoDirFor(repo)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    return dir
  }

  /** List regular .md files (newest first). */
  async function list(repo) {
    const dir = repoDirFor(repo)
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const files = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      try {
        const info = await stat(path.join(dir, entry.name))
        files.push({ name: entry.name, size: info.size, updatedAt: info.mtimeMs })
      } catch {
        /* skip vanished file */
      }
    }
    files.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
    return files.slice(0, MAX_LIST)
  }

  /** Read one memory file as UTF-8 text. */
  async function read(repo, name) {
    const fileName = assertName(name)
    const dir = repoDirFor(repo)
    const file = path.join(dir, fileName)
    let info
    try {
      info = await stat(file)
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`memory: ${fileName} does not exist`)
      throw error
    }
    if (!info.isFile()) throw new Error(`memory: ${fileName} is not a regular file`)
    if (info.size > maxFileBytes) throw new Error(`memory: ${fileName} is too large (${info.size} bytes)`)
    return await readFile(file, 'utf8')
  }

  /** Write or append one memory file; returns {name, bytes, created}. */
  async function write(repo, name, content, mode = 'overwrite') {
    const fileName = assertName(name)
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('memory: content must be a non-empty string')
    }
    const dir = await ensureRepoDir(repo)
    const file = path.join(dir, fileName)
    let existing = null
    try {
      existing = await readFile(file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (existing !== null) {
      const info = await stat(file).catch(() => null)
      if (info && !info.isFile()) throw new Error(`memory: ${fileName} is not a regular file`)
    }
    const next =
      mode === 'append' && existing !== null ? `${existing.trimEnd()}\n\n${content.trim()}\n` : `${content.trim()}\n`
    const bytes = Buffer.byteLength(next, 'utf8')
    if (bytes > maxFileBytes) throw new Error(`memory: ${fileName} would exceed ${maxFileBytes} bytes`)
    const files = await list(repo)
    const others = files.filter((entry) => entry.name !== fileName)
    const total = others.reduce((sum, entry) => sum + entry.size, 0) + bytes
    if (others.length + 1 > maxFiles) throw new Error(`memory: repository has more than ${maxFiles} memory files`)
    if (total > maxTotalBytes) throw new Error(`memory: repository memory would exceed ${maxTotalBytes} bytes`)
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, next, { mode: 0o600 })
    await rename(tmp, file)
    await unlink(tmp).catch(() => {})
    logger?.info?.(`memory: wrote ${repo}/${fileName} (${bytes} bytes)`)
    return { name: fileName, bytes, created: existing === null }
  }

  /** Compact file list for prompts. */
  async function summary(repo) {
    try {
      const files = await list(repo)
      return files.map((file) => ({ name: file.name, size: file.size }))
    } catch (error) {
      logger?.warn?.(`memory: could not list ${repo}: ${error?.message ?? error}`)
      return []
    }
  }

  return { rootDir, repoDirFor, list, read, write, summary }
}

export const MEMORY_NAME_PATTERN = NAME_PATTERN
export const MEMORY_REPO_PATTERN = REPO_PATTERN
