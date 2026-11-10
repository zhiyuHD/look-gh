/**
 * BigFatFish bot — per-session guard for untrusted repositories.
 *
 * The webhook issue text is attacker-controlled input for an autonomous agent,
 * so the session gets three independent layers:
 *
 * 1. the `bot-sandbox` permission preset (workspace-write + approval `never`),
 *    which confines bash/fs writes to the session workspace (kernel bwrap);
 * 2. a per-agent tool allowlist (`ctx.tools.guard`) so host-mutating, network
 *    and delegation tools are never callable from this agent;
 * 3. path/command checks for the tools that remain, so the agent cannot read
 *    files outside the checked-out repository or reach the network/package
 *    managers through bash.
 *
 * Guards are monotonic denials registered on one agent's scoped context; they
 * are removed with that agent. This module is intentionally dependency-free so
 * it can be unit-tested without a Host.
 *
 * @module bigfatfish-bot/lib/guard
 */

import { isAbsolute, resolve as resolvePath, relative as relativePath } from 'node:path'
import { tmpdir } from 'node:os'

/** Tools this agent may call at all. Everything else is denied. */
export const BOT_ALLOWED_TOOLS = Object.freeze([
  'bash',
  'bff_bash',
  'read',
  'read_image',
  'write',
  'edit',
  'glob',
  'grep',
  'todo_write',
  'bff_commit',
  'bff_push',
  'bff_create_pr',
  'bff_request_approval',
  'bff_add_extra_repo',
  'bff_checkout',
  'bff_done',
  'bff_reply',
  'bff_progress',
  'bff_memory_list',
  'bff_memory_read',
  'bff_memory_write',
  'bff_finish',
])

/** Tool arguments that carry a filesystem path we must contain. */
const PATH_ARGUMENTS = Object.freeze(['file_path', 'path', 'target', 'destination', 'source'])

/**
 * Commands that reach the network, escalate privileges, change the host, or
 * install code. Bash file access is already write-confined by bwrap; this list
 * protects the read/network side that the kernel sandbox does not cover.
 */
const DENY_COMMAND_PATTERNS = Object.freeze([
  { re: /(^|[\s;&|()`])(curl|wget|nc|ncat|netcat|socat|telnet|ftp|sftp|scp|ssh|rsync|aria2c|links|lynx)\b/i, reason: 'network command' },
  { re: /\bgit\s+(commit|add|push|fetch|pull|clone|remote|submodule|archive|tag|reset|checkout|switch)\b/i, reason: 'git state-changing command' },
  { re: /(^|[\s;&|()`])(npm|pnpm|yarn|bun|pip|pip3|apt|apt-get|dnf|yum|brew|nix|nix-shell|nix-env|rustup|gem)\b/i, reason: 'package manager / installer' },
  { re: /\bcargo\s+(install|publish|login|logout|owner|yank)\b/i, reason: 'cargo install/publish' },
  { re: /(^|[\s;&|()`])(sudo|doas|su|pkexec|systemctl|service|mount|umount|docker|podman|kubectl|chroot|unshare|setpriv)\b/i, reason: 'privileged/system command' },
  { re: /\bprintenv\b/i, reason: 'environment dump' },
  { re: /(\$HOME|~\/|~[a-z]|%USERPROFILE%)/i, reason: 'home-directory reference' },
  { re: /(\/home\/|\/root\/|\/etc\/|\/var\/|\/proc\/|\/sys\/|\.ssh|\.dsh|\.credentials|\.secrets|github-app\.pem|DSH_HOME|DSH_PROFILE)/i, reason: 'sensitive path' },
  { re: /\bcd\s+\/(\s|$|;|&|\|)/, reason: 'change into filesystem root' },
  { re: /\b(rm|chmod|chown)\s+-[a-z]*[rf][a-z]*\s+\/(\s|$)/i, reason: 'destructive root command' },
])

/** Reason some bash text is refused, or `undefined` when it passes. */
export function checkBashCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') return 'empty command'
  for (const { re, reason } of DENY_COMMAND_PATTERNS) {
    if (re.test(command)) return `BigFatFish 沙箱拒绝该命令（${reason}）`
  }
  return undefined
}

/** Resolve a tool-provided path against the workspace without throwing. */
function normalizeTarget(value, workspace) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const text = value.trim()
  try {
    return isAbsolute(text) ? resolvePath(text) : resolvePath(workspace, text)
  } catch {
    return undefined
  }
}

/** True when `target` is inside `root` (or is `root`). */
export function isInside(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string') return false
  const rel = relativePath(resolvePath(root), resolvePath(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Whether a path may be read/written by the bot: workspace or the temp dir. */
export function isAllowedPath(workspace, target) {
  return isInside(workspace, target) || isInside(tmpdir(), target)
}

function firstPathArgument(args) {
  if (args === null || typeof args !== 'object') return undefined
  for (const key of PATH_ARGUMENTS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/**
 * Build the guard function for one session.
 * @param {{ workspace: string }} options
 * @returns {(execution: { name: string, arguments?: unknown }) => string | undefined}
 */
export function createBotGuard({ workspace }) {
  const root = resolvePath(workspace)
  return function botGuard(execution) {
    const name = typeof execution?.name === 'string' ? execution.name : ''
    if (!BOT_ALLOWED_TOOLS.includes(name)) {
      return `工具 ${name || '(unknown)'} 在 BigFatFish 自动处理会话中被禁用`
    }
    const args = execution?.arguments
    const record = args !== null && typeof args === 'object' ? args : {}

    // Sandbox escalation is never available to an unattended session.
    if (record.sandbox_permissions !== undefined || record.justification !== undefined) {
      return 'BigFatFish 自动处理会话不允许申请提权'
    }

    if (name === 'bash' || name === 'bff_bash') {
      const verdict = checkBashCommand(record.command)
      if (verdict !== undefined) return verdict
      if (record.workdir !== undefined) {
        const workdir = normalizeTarget(record.workdir, root)
        if (workdir === undefined || !isAllowedPath(root, workdir)) {
          return 'bash workdir 必须位于会话工作区或临时目录内'
        }
      }
      return undefined
    }

    const rawPath = firstPathArgument(record)
    if (rawPath !== undefined) {
      const target = normalizeTarget(rawPath, root)
      if (target === undefined || !isAllowedPath(root, target)) {
        return `路径越界：${rawPath} 不在 BigFatFish 会话工作区内`
      }
    }
    return undefined
  }
}

/**
 * Install the guard on one agent's scoped context.
 * @param {{ tools: { guard(guard: Function): () => void } }} agentCtx
 * @param {{ workspace: string }} options
 * @returns {() => void} disposer
 */
export function installBotGuard(agentCtx, { workspace }) {
  const guard = createBotGuard({ workspace })
  return agentCtx.tools.guard(guard)
}
