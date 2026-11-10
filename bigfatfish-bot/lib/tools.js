import path from 'node:path'

/**
 * BigFatFish bot — model-facing tools for an unattended repository session.
 *
 * The bot agent decides *whether* a change is worth committing and a pull
 * request worth opening, and it writes the commit message / PR title / PR body.
 * The plugin only exposes narrowly scoped tools for those actions instead of
 * letting the model drive `git` and `gh` directly:
 *
 * - `bff_commit({ message })`  stage everything and commit on the job branch
 * - `bff_push()`               push the job branch with a fresh installation token
 * - `bff_create_pr({ title, body })` push if needed, then open the PR
 * - `bff_request_approval({ summary })` triage only: ask the owner/collaborator to approve
 * - `bff_finish({ summary })`  optional explicit end-of-turn summary
 *
 * Tools are registered globally but activated only for agents whose session id
 * starts with `bigfatfish-`; their execution resolves the per-session job from
 * the map the pipeline owns. Tool failures are plain thrown errors and are
 * reported back to the model by the executor.
 *
 * @module bigfatfish-bot/lib/tools
 */

const JOB_PREFIX = 'bigfatfish-'
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function textResult(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}

function truncateText(value, max) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length <= max ? text : text.slice(0, max)
}

function defineTool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return textResult(value)
      },
    },
    execute,
  }
}

/**
 * Register the four bot tools.
 * @param {any} ctx plugin context (`ctx.tools`)
 * @param {{
 *   sessionJobs: Map<string, any>,
 *   github: any,
 *   git: any,
 *   getAllowedRepos: () => string[],
 *   ensureExcludes: (repoDir: string) => Promise<void>,
 *   sandboxBash: { run(options: any): Promise<any> },
 *   memory: { list(repo: string): Promise<any[]>, read(repo: string, name: string): Promise<string>, write(repo: string, name: string, content: string, mode?: string): Promise<any> },
 *   logger?: any,
 * }} services
 * @returns {() => void} disposer for all registrations
 */
export function registerBotTools(ctx, { sessionJobs, github, git, getAllowedRepos, ensureExcludes, sandboxBash, memory, logger }) {
  const when = ({ agent }) => typeof agent?.id === 'string' && agent.id.startsWith(JOB_PREFIX)

  const jobOf = (exec, tool) => {
    const job = sessionJobs.get(String(exec?.agent?.id ?? ''))
    if (job === undefined) throw new Error(`${tool}: no active BigFatFish job for this session`)
    return job
  }

  const repoState = (job, requested, tool) => {
    const name = typeof requested === 'string' && requested.trim() !== '' ? requested.trim() : job.primaryRepo
    const state = job.repos && job.repos[name]
    if (state === undefined) {
      throw new Error(
        `${tool}: 仓库 ${name} 未加入本次会话。如果确需它，请先调用 bff_add_extra_repo({repo:"${name}"})（必须已在白名单）`,
      )
    }
    return state
  }

  const commentNumber = (job) => (job.pullRequest === true ? job.pullNumber : job.issueNumber)

  const humanReplies = async (job) => {
    const number = commentNumber(job)
    if (!Number.isInteger(number)) return []
    try {
      const comments = await github.listIssueComments(job.repo, number, job.installationId)
      if (!Array.isArray(comments)) return []
      const rows = []
      for (const comment of comments) {
        const user = comment?.user
        const login = typeof user?.login === 'string' ? user.login : ''
        if (user?.type === 'Bot' || login.endsWith('[bot]')) continue
        const body = typeof comment?.body === 'string' ? comment.body.trim() : ''
        if (body === '') continue
        if (/^(\/approve|同意|批准|可以开工|开工|approve|lgtm)\s*$/i.test(body)) continue
        rows.push({
          author: login || 'unknown',
          excerpt: body.replace(/\s+/g, ' ').slice(0, 300),
          url: typeof comment?.html_url === 'string' ? comment.html_url : null,
        })
      }
      return rows.slice(-3)
    } catch (error) {
      logger?.warn?.(`bff_reply: could not load recent comments: ${error?.message ?? error}`)
      return []
    }
  }

  const requireWrite = (job, tool) => {
    if (job.allowWrite !== true) {
      throw new Error(`${tool}: 当前是分析/问答阶段，不允许改代码；需要改动请先调用 bff_request_approval`)
    }
  }

  const addExtraRepo = defineTool(
    'bff_add_extra_repo',
    'Clone one additional repository that this change or analysis genuinely needs (it must be on the repository whitelist). The clone lives inside this session workspace and is excluded from the primary commit; during triage it is read-only analysis, after approval pass repo:"owner/repo" to bff_commit / bff_push / bff_create_pr to submit to it too. Returns {repo, path, baseBranch}.',
    {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'The extra repository, as owner/repo.' },
        reason: { type: 'string', description: 'Why this repository is needed for the change.' },
      },
      required: ['repo'],
    },
    async (args, exec) => {
      const job = jobOf(exec, 'bff_add_extra_repo')
      const repo = typeof args?.repo === 'string' ? args.repo.trim() : ''
      if (!REPO_PATTERN.test(repo)) throw new Error('bff_add_extra_repo: repo must look like owner/repo')
      if (repo === job.primaryRepo) throw new Error('bff_add_extra_repo: 主仓库已经克隆，不需要重复添加')
      if (job.repos[repo] !== undefined) {
        return { repo, path: job.repos[repo].repoDir, baseBranch: job.repos[repo].baseBranch, already: true }
      }
      const allowed = getAllowedRepos().map((item) => item.toLowerCase())
      if (!allowed.includes(repo.toLowerCase())) {
        throw new Error(`bff_add_extra_repo: 仓库 ${repo} 不在白名单内，不能克隆`)
      }
      await ensureExcludes?.(job.primaryRepoDir)
      const [owner, name] = repo.split('/')
      const extraDir = path.join(job.primaryRepoDir, '.bigfatfish', 'extra', owner, name)
      const token = await github.getInstallationToken(job.installationId)
      const meta = await github.getRepo(repo, job.installationId)
      const baseBranch =
        meta && typeof meta.default_branch === 'string' && meta.default_branch !== ''
          ? meta.default_branch
          : 'main'
      await git.ensureRepo({
        repoDir: extraDir,
        repoFullName: repo,
        defaultBranch: baseBranch,
        token,
        signal: exec.signal,
      })
      job.repos[repo] = {
        repo,
        repoDir: extraDir,
        branch: null,
        baseBranch,
        installationId: job.installationId,
        committedSha: null,
        pushedSha: null,
        prUrl: null,
        prNumber: null,
        isPrimary: false,
      }
      logger?.info?.(`bff_add_extra_repo: cloned ${repo} into ${extraDir}`)
      return { repo, path: extraDir, baseBranch, reason: truncateText(args?.reason, 500) }
    },
  )

  const checkout = defineTool(
    'bff_checkout',
    'Fetch origin and check out a branch chosen by you. If origin/<branch> exists it is reset to that remote branch; otherwise a new branch is created from `base` (default: the repository default branch). Call this before bff_commit / bff_push / bff_create_pr. Returns {repo, branch, base, remote}.',
    {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Branch name to check out or create.' },
        base: { type: 'string', description: 'Base branch when creating a new branch (defaults to the repository default branch).' },
        repo: { type: 'string', description: 'Optional owner/repo from bff_add_extra_repo; defaults to the primary repository.' },
      },
      required: ['branch'],
    },
    async (args, exec) => {
      const job = jobOf(exec, 'bff_checkout')
      const state = repoState(job, args?.repo, 'bff_checkout')
      const branch = typeof args?.branch === 'string' ? args.branch.trim() : ''
      if (branch === '') throw new Error('bff_checkout: branch must be a non-empty string')
      const token = await github.getInstallationToken(state.installationId)
      await git.fetchOrigin({ repoDir: state.repoDir, token, signal: exec.signal })
      const remote = await git.remoteBranchExists({ repoDir: state.repoDir, branch, signal: exec.signal })
      let base = typeof args?.base === 'string' && args.base.trim() !== '' ? args.base.trim() : state.baseBranch
      if (remote) {
        base = state.baseBranch
        await git.checkoutBranch({ repoDir: state.repoDir, branch, startRef: `origin/${branch}`, token, signal: exec.signal })
      } else {
        if (typeof base !== 'string' || base.trim() === '') {
          const meta = await github.getRepo(state.repo, state.installationId)
          base = meta && typeof meta.default_branch === 'string' && meta.default_branch !== '' ? meta.default_branch : 'main'
        }
        await git.fetchOrigin({ repoDir: state.repoDir, token, signal: exec.signal })
        await git.checkoutBranch({ repoDir: state.repoDir, branch, startRef: `origin/${base}`, token, signal: exec.signal })
        state.baseBranch = base
      }
      state.branch = branch
      return { repo: state.repo, branch, base, remote }
    },
  )

  const commit = defineTool(
    'bff_commit',
    'Commit the current working tree on the BigFatFish job branch. Call this after editing files and before opening/updating a PR. You choose the commit message. Returns {committed, sha}.',
    {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Commit message (imperative, describe what changed).' },
        repo: { type: 'string', description: 'Optional owner/repo from bff_add_extra_repo; defaults to the primary repository.' },
      },
      required: ['message'],
    },
    async (args, exec) => {
      const job = jobOf(exec, 'bff_commit')
      requireWrite(job, 'bff_commit')
      const state = repoState(job, args?.repo, 'bff_commit')
      if (typeof state.branch !== 'string' || state.branch === '') {
        throw new Error('bff_commit: 还没有选择分支，请先调用 bff_checkout({branch})')
      }
      const message = truncateText(args?.message, 2000)
      if (message === '') throw new Error('bff_commit: message must be a non-empty string')
      // Defensive: `.bigfatfish/` (the extra-repo workspace) must never be
      // staged into the primary commit, even on a resumed older workspace.
      await ensureExcludes?.(state.repoDir)
      const result = await git.commitAll({
        repoDir: state.repoDir,
        message,
        author: job.author,
        signal: exec.signal,
      })
      state.committedSha = result.committed ? result.sha : state.committedSha
      state.hasCommit = result.committed
      return { repo: state.repo, committed: result.committed, sha: result.sha ?? null }
    },
  )

  const push = defineTool(
    'bff_push',
    'Push the BigFatFish job branch to GitHub with the App installation token. Use after bff_commit for an existing pull request. Returns {sha}.',
    {
      type: 'object',
      properties: { repo: { type: 'string', description: 'Optional owner/repo; defaults to the primary repository.' } },
      additionalProperties: false,
    },
    async (args, exec) => {
      const job = jobOf(exec, 'bff_push')
      requireWrite(job, 'bff_push')
      const state = repoState(job, args?.repo, 'bff_push')
      if (typeof state.branch !== 'string' || state.branch === '') {
        throw new Error('bff_push: 还没有选择分支，请先调用 bff_checkout({branch})')
      }
      const token = await github.getInstallationToken(job.installationId)
      await git.push({ repoDir: state.repoDir, branch: state.branch, token, signal: exec.signal })
      const sha = await git.headSha({ repoDir: state.repoDir, signal: exec.signal })
      state.pushedSha = sha
      return { repo: state.repo, pushed: true, sha }
    },
  )

  const runShell = defineTool(
    'bff_bash',
    'Run one shell command inside the strict BigFatFish sandbox. The sandbox exposes only the session workspace (read/write), a private /tmp, and read-only system roots; /home, /root, /mnt (outside the workspace), /var, /srv and /opt are hidden, and HOME is /tmp. Returns {exit_code, stdout, stderr, timed_out}. Use this for tests, builds and inspections; it is the only shell available in this session.',
    {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run (non-empty).' },
        workdir: {
          type: 'string',
          description: 'Optional working directory inside the session workspace; defaults to the primary repository root.',
        },
      },
      required: ['command'],
    },
    async (args, exec) => {
      const job = jobOf(exec, 'bff_bash')
      const command = typeof args?.command === 'string' ? args.command : ''
      if (command.trim() === '') throw new Error('bff_bash: command must be a non-empty string')
      const workdir =
        typeof args?.workdir === 'string' && args.workdir.trim() !== ''
          ? args.workdir.trim()
          : job.primaryRepoDir
      return await sandboxBash.run({
        command,
        workspace: job.primaryRepoDir,
        workdir,
        timeoutMs: job.sessionTimeoutMs,
        signal: exec.signal,
      })
    },
  )

  const memoryList = defineTool(
    'bff_memory_list',
    'List the project-memory Markdown files for this repository. Memory is independent of the workspace, survives cleanup, and is stored as .md files. Call this near the start of a session and read the relevant files before changing code.',
    {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Optional owner/repo from bff_add_extra_repo; defaults to the primary repository.' },
      },
      additionalProperties: false,
    },
    async (args, exec) => {
      const job = jobOf(exec, 'bff_memory_list')
      const state = repoState(job, args?.repo, 'bff_memory_list')
      return { repo: state.repo, files: await memory.list(state.repo) }
    },
  )

  const memoryRead = defineTool(
    'bff_memory_read',
    'Read one project-memory Markdown file for this repository. Read relevant notes before working; memory is independent of the workspace and survives cleanup.',
    {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Memory file name ending in .md.' },
        repo: { type: 'string', description: 'Optional owner/repo from bff_add_extra_repo; defaults to the primary repository.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    async (args, exec) => {
      const job = jobOf(exec, 'bff_memory_read')
      const state = repoState(job, args?.repo, 'bff_memory_read')
      const name = typeof args?.name === 'string' ? args.name : ''
      return { repo: state.repo, name, content: await memory.read(state.repo, name) }
    },
  )

  const memoryWrite = defineTool(
    'bff_memory_write',
    'Write or append one project-memory Markdown file for this repository (only .md, no secrets/personal data). Use it after implementation or review to persist knowledge that will help future sessions. Memory is independent of the workspace and is never deleted by workspace cleanup.',
    {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Memory file name ending in .md (for example build-notes.md).' },
        content: { type: 'string', description: 'Markdown notes to persist.' },
        mode: { type: 'string', enum: ['overwrite', 'append'], description: 'Default overwrite.' },
        repo: { type: 'string', description: 'Optional owner/repo from bff_add_extra_repo; defaults to the primary repository.' },
      },
      required: ['name', 'content'],
      additionalProperties: false,
    },
    async (args, exec) => {
      const job = jobOf(exec, 'bff_memory_write')
      requireWrite(job, 'bff_memory_write')
      const state = repoState(job, args?.repo, 'bff_memory_write')
      const name = typeof args?.name === 'string' ? args.name : ''
      const content = typeof args?.content === 'string' ? args.content : ''
      const mode = args?.mode === 'append' ? 'append' : 'overwrite'
      return await memory.write(state.repo, name, content, mode)
    },
  )

  const reply = defineTool(
    'bff_reply',
    'Publish your final reply on GitHub (issue comment or PR comment). The last assistant message is NOT posted automatically, so you must call this tool to reply. Write short Markdown; the host appends PR/commit links and its marker after your text. Call it once, near the end of the turn.',
    {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'Markdown body of the GitHub reply.' },
      },
      required: ['body'],
      additionalProperties: false,
    },
    async (args, exec) => {
      const job = jobOf(exec, 'bff_reply')
      const body = truncateText(args?.body, 20000)
      if (body.trim() === '') throw new Error('bff_reply: body must be a non-empty string')
      job.replyBody = body.trim()
      job.replied = true
      const recentComments = await humanReplies(job)
      job.replyContext = recentComments
      return { ok: true, chars: job.replyBody.length, recentComments }
    },
  )

  const progress = defineTool(
    'bff_progress',
    'Post an intermediate progress update on the current issue/PR (visible to watchers). Use it at meaningful milestones of a long task (problem located, implementation starting, tests running, PR created, waiting for review, blocked). Do not spam: at most 8 per task, at least 10 seconds apart. The final result must still be sent with bff_reply.',
    {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Short Markdown progress update.' },
      },
      required: ['message'],
      additionalProperties: false,
    },
    async (args, exec) => {
      const job = jobOf(exec, 'bff_progress')
      const text = truncateText(args?.message, 2000)
      if (text.trim() === '') throw new Error('bff_progress: message must be a non-empty string')
      const number = commentNumber(job)
      if (!Number.isInteger(number)) throw new Error('bff_progress: no issue/PR number for this job')
      const count = Number.isInteger(job.progressCount) ? job.progressCount : 0
      if (count >= 8) throw new Error('bff_progress: 本次任务已经汇报过 8 次进度，请直接继续工作并最终用 bff_reply 回复')
      const now = Date.now()
      if (Number.isFinite(job.lastProgressAt) && now - job.lastProgressAt < 10_000) {
        throw new Error('bff_progress: 距离上次进度汇报不足 10 秒，请稍后再报或直接继续工作')
      }
      const body = `${text.trim()}\n\n<!-- bigfatfish:progress -->`
      if (job.pullRequest === true) await github.commentPull(job.repo, number, body, job.installationId)
      else await github.commentIssue(job.repo, number, body, job.installationId)
      job.progressCount = count + 1
      job.lastProgressAt = now
      return { posted: true, count: job.progressCount }
    },
  )

  const done = defineTool(
    'bff_done',
    'Declare that the WHOLE task is finished. Only call this when no further approval, review, comment or follow-up is expected for this issue/PR; ordinary replies, requests waiting for approval, and review/comment turns must NOT call it. The host keeps the clone, workspace and session until you call this; after the session ends they are deleted.',
    {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Short reason why the task is completely finished.' },
      },
      additionalProperties: false,
    },
    async (args, exec) => {
      const job = jobOf(exec, 'bff_done')
      if (job.mode !== 'review') {
        const openedPr = Object.values(job.repos ?? {}).some((state) => state && typeof state.prUrl === 'string' && state.prUrl !== '')
        if (openedPr) {
          throw new Error('bff_done: 本会话已经创建 PR，必须等 PR review 完成；不要在实现会话里 finish/清理')
        }
      }
      job.doneRequested = true
      job.doneReason = truncateText(args?.reason, 500)
      return { ok: true, cleanup: 'after this session ends' }
    },
  )

  const createPull = defineTool(
    'bff_create_pr',
    'Open a pull request for the BigFatFish job branch. Call bff_commit first. You choose the title and the body (mention the issue with "Closes #<n>" yourself if appropriate). Pushes the branch when it was not pushed yet. Returns {url, number}.',
    {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body in Markdown.' },
        base: { type: 'string', description: 'Optional target base branch; defaults to the repository default branch chosen at checkout.' },
        repo: { type: 'string', description: 'Optional owner/repo from bff_add_extra_repo; defaults to the primary repository.' },
      },
      required: ['title', 'body'],
    },
    async (args, exec) => {
      const job = jobOf(exec, 'bff_create_pr')
      requireWrite(job, 'bff_create_pr')
      const state = repoState(job, args?.repo, 'bff_create_pr')
      if (typeof state.branch !== 'string' || state.branch === '') {
        throw new Error('bff_create_pr: 还没有选择分支，请先调用 bff_checkout({branch})')
      }
      const title = truncateText(args?.title, 240)
      if (title === '') throw new Error('bff_create_pr: title must be a non-empty string')
      const body = truncateText(args?.body, 20000)
      const token = await github.getInstallationToken(state.installationId)
      await git.push({ repoDir: state.repoDir, branch: state.branch, token, signal: exec.signal })
      const sha = await git.headSha({ repoDir: state.repoDir, signal: exec.signal })
      state.pushedSha = sha
      const base =
        typeof args?.base === 'string' && args.base.trim() !== '' ? args.base.trim() : state.baseBranch
      const pull = await github.createPull(
        state.repo,
        { title, head: state.branch, base, body },
        state.installationId,
      )
      state.prUrl = typeof pull?.html_url === 'string' ? pull.html_url : null
      state.prNumber = Number.isInteger(pull?.number) ? pull.number : null
      if (state.isPrimary === false) {
        job.extraPrs = Array.isArray(job.extraPrs) ? job.extraPrs : []
        job.extraPrs.push({ repo: state.repo, url: state.prUrl, number: state.prNumber })
      }
      return { repo: state.repo, url: state.prUrl, number: state.prNumber }
    },
  )

  const requestApproval = defineTool(
    'bff_request_approval',
    'Triage only: you decided this issue needs code changes and a pull request, so ask the repository owner/collaborator to approve first. Explain the plan in the summary. After calling this, reply to the issue asking for /approve or 同意. Do not edit files in this phase.',
    {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What you plan to change and why, for the approver.' },
      },
      required: ['summary'],
    },
    async (args, exec) => {
      const job = jobOf(exec, 'bff_request_approval')
      if (job.mode !== 'triage') throw new Error('bff_request_approval: only valid during issue triage')
      job.approvalRequested = true
      const summary = truncateText(args?.summary, 2000)
      job.finishSummary = summary === '' ? job.finishSummary : summary
      try {
        exec.concludeTurn()
      } catch (error) {
        logger?.warn?.(`bff_request_approval: could not conclude turn: ${error?.message ?? error}`)
      }
      return { requested: true }
    },
  )

  const finish = defineTool(
    'bff_finish',
    'Optional internal end-of-turn summary. It is NOT posted to GitHub; use bff_reply({body}) for the GitHub reply. If a PR was created, wait for its review before finishing the whole task.',
    {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Short summary of what was done, or why nothing was changed.' },
      },
      required: ['summary'],
    },
    async (args, exec) => {
      const job = jobOf(exec, 'bff_finish')
      job.finishSummary = truncateText(args?.summary, 6000)
      try {
        exec.concludeTurn()
      } catch (error) {
        logger?.warn?.(`bff_finish: could not conclude turn: ${error?.message ?? error}`)
      }
      return { finished: true }
    },
  )

  const disposers = [commit, push, createPull, runShell, addExtraRepo, checkout, requestApproval, finish, reply, progress, done, memoryList, memoryRead, memoryWrite].map((definition) =>
    ctx.tools.register(definition, { when }),
  )
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* already disposed */
      }
    }
  }
}
