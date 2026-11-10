/**
 * BigFatFish bot — strict read/write sandbox for model shell commands.
 *
 * The stock `workspace-write` sandbox only fences writes; it still leaves the
 * whole host filesystem readable and the network open. For unattended,
 * untrusted repository work the bot therefore executes `bff_bash` through a
 * narrower bwrap profile: only Nix/system read-only roots are mounted, while
 * /home, /root, /mnt, /var, /srv and /opt are replaced by empty tmpfs. The
 * session workspace is the only writable host path, and /tmp is a private
 * tmpfs. Command output is captured and bounded.
 *
 * @module bigfatfish-bot/lib/sandbox-bash
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const STDOUT_LIMIT = 256 * 1024
const STDERR_LIMIT = 64 * 1024

function readOnlyBind(args, source) {
  if (existsSync(source)) args.push('--ro-bind', source, source)
}

/** Locate the newest Nix Go store bin dir (Go is installed through the user profile). */
function nixGoBinDir() {
  try {
    const candidates = readdirSync('/nix/store')
      .filter((name) => /-go-\d+(?:\.\d+)*$/.test(name))
      .sort()
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const dir = `/nix/store/${candidates[index]}/bin`
      if (existsSync(`${dir}/go`)) return dir
    }
  } catch {
    /* no readable store */
  }
  return undefined
}

function buildArgs({ workspace, command, workdir }) {
  const args = []
  // System roots needed by compilers, shells and TLS; everything else is hidden.
  readOnlyBind(args, '/nix/store')
  readOnlyBind(args, '/run/current-system')
  readOnlyBind(args, '/etc')
  readOnlyBind(args, '/bin')
  readOnlyBind(args, '/usr')
  readOnlyBind(args, '/lib')
  readOnlyBind(args, '/lib64')

  // Mask the host's private surfaces. The workspace is bound back below.
  for (const hidden of ['/home', '/root', '/mnt', '/var', '/srv', '/opt']) {
    args.push('--tmpfs', hidden)
  }
  args.push('--tmpfs', '/tmp')
  args.push('--bind', workspace, workspace)
  args.push('--dev', '/dev')
  args.push('--unshare-pid', '--proc', '/proc', '--die-with-parent')
  args.push('--clearenv')

  const pathEntries = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(
      (entry) =>
        entry === '/run/current-system/sw/bin' ||
        entry === '/bin' ||
        entry === '/usr/bin' ||
        entry.startsWith('/nix/store/'),
    )
  const goDir = nixGoBinDir()
  if (goDir !== undefined && !pathEntries.includes(goDir)) pathEntries.push(goDir)
  const safePath = pathEntries.join(path.delimiter)
  const env = {
    PATH: safePath || '/run/current-system/sw/bin:/bin',
    HOME: '/tmp',
    TMPDIR: '/tmp',
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
    TERM: process.env.TERM ?? 'xterm-256color',
    TZ: process.env.TZ ?? 'Asia/Shanghai',
    SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt',
  }
  for (const [key, value] of Object.entries(env)) args.push('--setenv', key, value)

  args.push('--chdir', workdir, '/bin/sh', '-c', command)
  return args
}

/**
 * @param {{ logger?: any }} [options]
 */
export function createSandboxBash({ logger } = {}) {
  /**
   * Run one shell command in the strict bot sandbox.
   * @returns {Promise<{ exitCode: number|null, stdout: string, stderr: string, timedOut: boolean }>}
   */
  async function run({ command, workspace, workdir, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
    if (typeof command !== 'string' || command.trim() === '') {
      throw new Error('bff_bash: command must be a non-empty string')
    }
    if (typeof workspace !== 'string' || workspace.trim() === '') {
      throw new Error('bff_bash: workspace is required')
    }
    const root = path.resolve(workspace)
    const cwd = path.resolve(workdir ?? root)
    const rel = path.relative(root, cwd)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('bff_bash: workdir must stay inside the session workspace')
    }
    if (!existsSync(cwd)) throw new Error(`bff_bash: workdir does not exist: ${cwd}`)

    const args = buildArgs({ workspace: root, command, workdir: cwd })
    return await new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      let child
      const finish = (result) => {
        if (settled) return
        settled = true
        resolve(result)
      }
      const fail = (error) => {
        if (settled) return
        settled = true
        reject(error)
      }
      try {
        child = spawn('bwrap', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          // bwrap needs to be locatable on PATH; the sandboxed command itself
          // gets a cleared environment via `--clearenv` + `--setenv`.
          env: process.env,
        })
      } catch (error) {
        fail(new Error(`bff_bash: could not start bwrap: ${error?.message ?? error}`))
        return
      }
      const append = (target, chunk, limit) => {
        if (target.length >= limit) return target
        const text = chunk.toString('utf8')
        return target + text.slice(0, limit - target.length)
      }
      child.stdout?.on('data', (chunk) => {
        stdout = append(stdout, chunk, STDOUT_LIMIT)
      })
      child.stderr?.on('data', (chunk) => {
        stderr = append(stderr, chunk, STDERR_LIMIT)
      })
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
        finish({ exitCode: null, stdout, stderr: `${stderr}\n[bff_bash: timed out after ${timeoutMs}ms]`, timedOut: true })
      }, timeoutMs)
      const onAbort = () => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
        finish({ exitCode: null, stdout, stderr: `${stderr}\n[bff_bash: aborted]`, timedOut: true })
      }
      signal?.addEventListener?.('abort', onAbort, { once: true })
      child.on('error', (error) => {
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        fail(new Error(`bff_bash: bwrap failed: ${error?.message ?? error}`))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        finish({ exitCode: code, stdout, stderr, timedOut: false })
      })
    })
  }

  return { run }
}
