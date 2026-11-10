# BigFatFish Bot — 实现契约（v1）

> 所有实现者必须先读本文件。文件所有权见第 1 节，不得越界写文件。
> 目标环境：DSH Desktop 0.2.2-rc.1（Electron Host + Web GUI），入口
> `https://your-webhook.example` -> Caddy -> `127.0.0.1:5562`。

## 0. 功能需求（摘要）

1. 白名单仓库（配置 `allowedRepos`）+ issue/评论中 @`bigfatfish-bot` → 回一条系统 ack（固定文案，零 token）。
2. 非白名单仓库被 @ → 回「仓库不支持」。
3. Owner/Collaborator（依据 payload 的 `author_association`）在 issue 评论批准 → 启动 DSH 会话改代码、跑测试、提交、推送、开 PR；issue 回复正文取该会话最后一条 assistant 文本。
4. PR review：`changes_requested`/`commented` 且有内容 → 启动 DSH 会话改代码并推同一分支，PR 回复正文取会话最后一条 assistant 文本；`approved` → 只回固定文案。
5. 每仓库每自然日（默认 Asia/Shanghai）最多启动 5 个「实现会话」（issue 计数；comment/review/PR 不计）；超限回「该仓库今日已达到上限（5/5）」。
6. 左侧栏入口 + 页面：显示今日每个仓库处理的 issue、状态、PR 链接、tokens 消耗。
7. 每个白名单仓库一个独立 DSH 工作区：`/path/to/look-gh/<owner>/<repo>`。

## 1. 文件所有权（不得写别人的文件）

| 所有者 | 文件 |
|---|---|
| Lead | `CONTRACT.md`、`bigfatfish-bot/package.json`、`bigfatfish-bot/cordis.patch.yml`、`bigfatfish-bot/README.md`、安装/集成/测试 |
| host-core | `bigfatfish-bot/index.js`、`bigfatfish-bot/lib/decisions.js`、`bigfatfish-bot/lib/github.js` |
| host-runtime | `bigfatfish-bot/lib/git.js`、`bigfatfish-bot/lib/session.js`、`bigfatfish-bot/lib/prompts.js`、`bigfatfish-bot/lib/usage-store.js` |
| client-ui | `bigfatfish-bot/client.js`、`bigfatfish-bot/locale/en.json`、`bigfatfish-bot/locale/zh.json`、`bigfatfish-bot/icon.svg` |
| verifier | 服务器 Caddy 配置；`bigfatfish-bot/scripts/send-webhook.mjs`；只读验证 |

只写自己的文件；需要改契约时先报告 Lead。

## 2. 共享常量（decisions.js 导出，index.js 使用）

```js
export const MARKERS = {
  ack: '<!-- bigfatfish:ack -->',
  unsupported: '<!-- bigfatfish:unsupported -->',
  started: '<!-- bigfatfish:started -->',
  limit: '<!-- bigfatfish:limit -->',
  failed: '<!-- bigfatfish:failed -->',
  approved: '<!-- bigfatfish:approved -->',
  reviewDone: '<!-- bigfatfish:review-done -->',
}
```

固定回帖文案（中文，必须带对应 marker）：

- ack：`👋 收到。Owner/Collaborator 回复 \`/approve\` 或「同意」后开始处理。` + `\n\n` + MARKERS.ack
- unsupported：`⚠️ 仓库不在支持列表（仓库不支持），请联系维护者。` + marker
- limit：`⛔ 该仓库今日已达到上限（5/5），请明天再试。` + marker
- started：`🛠 已收到批准，开始处理，完成后会在此回复结果。` + marker
- failed：`❌ 自动处理失败：<简短原因>。可再次回复 /approve 重试。` + marker
- approved：`👍 已收到 approve，等待维护者合并。` + marker
- reviewDone（无 DSH 文本时兜底）：`✅ 已按 review 更新（commit <shortSha>）。` + marker
- issueDone（无 DSH 文本时兜底）：`✅ 已创建 PR：<url>` + marker

DSH 文本回复格式：`<DSH 最后一条 assistant 文本（截断 maxReplyChars）>\n\n<链接行>\n<marker>`。
链接行：issue 用 `PR: <url>`，review 用 `Commit: <url>`。

## 3. 配置（Config，schemastery）

```yaml
appId: '123456'
appSlug: bigfatfish-bot
privateKeyPath: /path/to/secrets/github-app.pem
webhookSecretPath: /path/to/secrets/webhook-secret
webhookSecretRef: BIGFATFISH_GITHUB_WEBHOOK_SECRET
allowedRepos: ['example/your-repo']
mention: bigfatfish-bot
workspaceRoot: /path/to/look-gh
agentPreset: standard
permissionPreset: danger-full-access
branchPrefix: dsh/issue-
approvalAssociations: [OWNER, COLLABORATOR, MEMBER]
approvalKeywords: ['/approve', 同意, 批准, 可以开工, 开工, approve, lgtm]
denyKeywords: [不同意, 不批, 先别, 不要, 暂缓, hold]
dailyIssueLimit: 5
quotaTimeZone: Asia/Shanghai
maxConcurrentSessions: 2
maxQueuePerRepo: 5
sessionTimeoutMs: 1800000
maxIssueContextChars: 20000
maxReplyChars: 6000
modelProvider: ''   # 空 = agentDefaultModel.currentSelection()
modelId: ''
usageRoutePath: /bigfatfish/usage
```

Config 用 `import z from '@deepseek-ai/schemastery'` 声明；必填字段用 `.required()`，其余用 `.default(...)` 或 optional。

## 4. 模块 API 契约

### lib/decisions.js（host-core）
纯函数，无 I/O：
```js
export const MARKERS
export function todayKey(timeZone, now = Date.now()) // 'YYYY-MM-DD'，用 Intl.DateTimeFormat('en-CA', { timeZone })
export function botLogin(slug) // `${slug}[bot]`
export function isBotSender(payload) // sender.type === 'Bot' || login.endsWith('[bot]')
export function repoFullName(payload) // payload?.repository?.full_name
export function isRepoAllowed(config, repo) // 大小写不敏感
export function hasMention(text, mention) // 包含 `@${mention}` 或 `@${mention}[bot]`（大小写不敏感）
export function associationAllowed(config, assoc) // config.approvalAssociations.includes(assoc)
export function isApproval(config, text) // 命中 approvalKeywords 任一 && 不命中 denyKeywords，trim 后长度 <= 200
export function hasMarker(body, marker)
export function parseBranchIssue(branch, prefix) // number | null
export function truncate(text, max)
export function issueKey(repo, number) // `${repo}#${number}`
```
`isApproval` 规则：文本 trim 后，先 deny 再 approve；`/approve` 精确前缀也算通过。

### lib/github.js（host-core）
```js
export class GitHubError extends Error { status; body; }
export function createGitHubClient({ appId, privateKeyPath, logger })
// 返回：
{
  async getApp(),                                              // GET /app (JWT)
  async getInstallationToken(installationId),                  // 缓存到 expires_at - 5min
  async request(installationId, method, route, body?),         // route 如 '/repos/o/r/issues/1/comments'
  async commentIssue(repo, number, body, installationId),
  async getIssue(repo, number, installationId),                // returns json
  async listIssueComments(repo, number, installationId),       // 全部分页（最多 10 页）
  async createPull(repo, { title, head, base, body }, installationId),
  async findOpenPull(repo, head, installationId),              // GET /repos/:repo/pulls?head=owner:branch&state=open
  async getPull(repo, number, installationId),
  async listReviews(repo, number, installationId),
  async listReviewComments(repo, number, installationId),
  async commentPull(repo, number, body, installationId),
  async getUser(login),                                        // GET /users/:login (JWT)
}
```
实现要点：JWT = base64url(header).base64url(payload)，payload `{iat: now-60, exp: now+540, iss: appId}`，`crypto.createSign('RSA-SHA256')`；REST 用全局 `fetch`；headers：`accept: application/vnd.github+json`、`user-agent: bigfatfish-bot`、`x-github-api-version: 2022-11-28`、JWT 用 `authorization: Bearer`，installation 用 `authorization: token`。4xx 抛 GitHubError（带 status/body），日志只记 status 与 route。

### lib/git.js（host-runtime）
```js
export function createGit(logger)
// 返回：
{
  async ensureRepo({ repoDir, repoFullName, defaultBranch, token, signal }),
  async checkoutFresh({ repoDir, branch, baseBranch, token, signal }),
  async checkoutExisting({ repoDir, branch, token, signal }),
  async commitAll({ repoDir, message, author, signal }), // { committed: boolean, sha: string|null }
  async push({ repoDir, branch, token, signal }),
  async diffStat({ repoDir, signal }),   // '3 files changed, 12 insertions(+)...' or ''
  async headSha({ repoDir, signal }),
}
```
Git 调用：`spawn('git', args, { cwd, env: {...process.env, GIT_ASKPASS, GIT_TERMINAL_PROMPT:'0', GH_TOKEN: token} })`；askpass 临时脚本（0700，用后删除）：
```sh
#!/bin/sh
case "$1" in
  Username*) printf '%s\n' x-access-token ;;
  *) printf '%s\n' "$GH_TOKEN" ;;
esac
```
`ensureRepo`：`mkdir -p`；无 `.git` 时 `git clone --depth 50 https://github.com/<repo>.git <dir>`，然后 `git remote set-url origin https://github.com/<repo>.git`；已有则 `git fetch origin <defaultBranch>`。分支：先 `git fetch origin`，实现用 `git checkout -B <branch> origin/<base>` + `git reset --hard` + `git clean -fd`；review 用 `git checkout -B <branch> origin/<branch>`（不存在则回退 base）。提交用参数 `-c user.name=... -c user.email=...` 或 `git config user.name/email`（仓库级）。token 永不写盘、不进日志。

### lib/session.js（host-runtime）
```js
export async function runAgentSession(ctx, config, opts)
// opts: { repoDir, title, prompt, deliveryId, ruleId }
// 返回 { sessionId, replyText, usage: { input, output, total }, turnError, timedOut }
```
实现（与官方 dsh-webhook 同版本一致）：
```js
const preset = await ctx.agentPresets.resolve(config.agentPreset)
ctx.permissionPresets.resolve(config.permissionPreset)
const scope = await ctx.agentPresets.acquireScope(preset.id)
try {
  const workspace = await ctx.workspaceRegistry.create(repoDir, title)
  const sessionId = `bigfatfish-${crypto.randomUUID()}`
  const agentOptions = config.modelProvider && config.modelId
    ? { provider: config.modelProvider, model: config.modelId }
    : { ...ctx.agentDefaultModel.currentSelection() }
  const handle = await ctx.agents.create({
    sessionId,
    meta: { cwd: workspace.path, agentPreset: preset.id },
    agentOptions,
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, preset.id) },
  })
  await workspace.attachSession(sessionId)
  ctx.permissionPresets.set(handle.agent.session, config.permissionPreset)
  ctx.sessionTitle.rename(handle.agent.session, title)
  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text: opts.prompt }],
    source: { kind: 'webhook', provider: 'github', source: 'bigfatfish-github',
              deliveryId: opts.deliveryId, ruleId: opts.ruleId, form: 'notice',
              summary: 'github webhook handled by bigfatfish-bot' },
  }))
  // whenIdle + timeout(sessionTimeoutMs)：超时调用 handle.agent.cancel({ kind: 'hook', reason: 'timeout' })，再等一次 whenIdle
  // 读取 handle.agent.session.snapshotEvents()
  // usage: 汇总 assistant/message 的 data.usage
  // replyText: 最后一条 assistant/message 的 text 块内容（trim，截断 maxReplyChars）
  // turnError: 最后 turn/end 的 reason.kind === 'error' ? 摘要 : null
} finally { await scope[Symbol.asyncDispose]?.() }
```
`createUserMessage` 从 `@deepseek-ai/dsh-llm` 导入。不要 dispose agent（保留在 UI 中）。

### lib/prompts.js（host-runtime）
```js
export function buildIssuePrompt({ repo, issue, comments, branch, baseBranch, maxChars })
export function buildReviewPrompt({ repo, pull, review, reviews, reviewComments, branch, baseBranch, maxChars })
```
要求：
- 明确 cwd 是 repoDir（会话 cwd）、分支名；
- 把 issue/PR/review 文本放进 `untrusted_json` 代码块，声明不可信；
- 要求：直接实现、跑相关测试、不要 `git commit`/`git push`/不要访问 GitHub、不要 `ask_user_question`、不要输出计划；
- 最后一条 assistant 回复会原样发到 GitHub：要求简短 Markdown（中文优先，列表/要点），不要包含密钥、内部推理、大段日志；
- 截断到 maxChars。

### lib/usage-store.js（host-runtime）
```js
export function createUsageStore({ filePath, limit, timeZone, logger })
// await store.init()
// store.snapshot() -> 见 §6
// await store.beginIssue(repo, { number, title }) -> { allowed, count, record? }
// await store.finishIssue(repo, number, patch)
// await store.beginReview(repo, { pullNumber, reviewId }) -> { record }
// await store.finishReview(repo, reviewId, patch)
```
- JSON 文件：`{ days: { 'YYYY-MM-DD': { repos: { '<repo>': { count, issues: [...], reviews: [...] } } } } }`，保留最近 7 天。
- 原子写：写 `<file>.tmp-<pid>` 后 `rename`；串行化写操作；文件权限 0600，目录 0700。
- 日期滚动：每次操作/`snapshot()` 前用 `todayKey` 检查当前日期；跨日自动新天。
- `beginIssue`：若 `count >= limit` 返回 `{allowed:false,count}`；否则 `count++` 并 push `{number,title,status:'running',startedAt,tokens:{input:0,output:0,total:0}}`。
- `finishIssue`：merge patch（status/done|failed/prUrl/branch/sessionId/tokens/error/finishedAt）。
- review 不占 count，记录在 `reviews: [{pullNumber, reviewId, status, startedAt, finishedAt, commitSha, tokens}]`。

## 5. DSH 服务用法（已核实，不要猜）

- `ctx.webhookRuntime.register(rule)`：`rule = { id, kind: 'github', async run(delivery, signal) }`；`delivery = { kind, source, deliveryId, event: { name, payload }, receivedAt }`。返回 disposer，用 `ctx.effect(() => ctx.webhookRuntime.register(...))` 持有。
- `ctx.webServer.register({ kind: 'exact', path, handler(request, response) })`：裸 webServer 精确路由；返回 disposer，用 `ctx.effect` 持有。
- `ctx.credentials.set(ref, value)`：ref 必须是 POSIX 标识符（如 `BIGFATFISH_GITHUB_WEBHOOK_SECRET`）。
- `ctx.logger.info/warn/error`。
- Client：`ctx.locale.register(NS, { zh, en })`、`ctx.locale.bind(NS)`；
  `ctx.slots.inject('slot名', () => ctx.slots.register({...}, Component))`；
  `main`（keyed）：`{ name:'main', key:'bigfatfish-usage', locale: NS, inject: () => ({ t }) }`；
  `sidebar.panellist`（list）：`{ name:'sidebar.panellist', id:'bigfatfish-usage', order:20, label:()=>t('nav'), locale:NS }`。
  客户端模块格式见模板：`window.__ModuleLoader__.load({ id: 'bigfatfish-bot', factory(require) { ... return { inject: ['slots','locale'], apply(ctx) {} } } })`。

## 6. 数据形状（/bigfatfish/usage 与 client 共用）

```json
{
  "date": "2026-11-07",
  "timeZone": "Asia/Shanghai",
  "limit": 5,
  "updatedAt": 1762444800000,
  "totals": { "issues": 3, "reviews": 1, "tokens": { "input": 1000, "output": 500, "total": 1500 } },
  "repos": [
    {
      "repo": "example/your-repo",
      "count": 2,
      "limit": 5,
      "tokens": { "input": 900, "output": 400, "total": 1300 },
      "issues": [
        { "number": 12, "title": "Add hello", "status": "done", "startedAt": 1762444000000,
          "finishedAt": 1762444100000, "prUrl": "https://github.com/.../pull/3", "branch": "dsh/issue-12",
          "sessionId": "bigfatfish-...", "tokens": { "input": 500, "output": 200, "total": 700 }, "error": null }
      ],
      "reviews": [
        { "pullNumber": 3, "reviewId": 123, "status": "done", "startedAt": 0, "finishedAt": 0,
          "commitSha": "abc1234", "tokens": { "input": 0, "output": 0, "total": 0 } }
      ]
    }
  ]
}
```

## 7. index.js（host-core）职责

- `export const inject = ['webhookRuntime','agents','agentPresets','permissionPresets','sessionTitle','workspaceRegistry','agentDefaultModel','credentials','webServer']`
- `export const Config`（按 §3）
- `export function apply(ctx, config)`：
  1. 读 `webhookSecretPath` → `ctx.credentials.set(config.webhookSecretRef, value)`（失败则抛错让插件显示失败）。
  2. 创建 github client、git、usage store（`await store.init()` 允许 apply 返回 Promise）。
  3. 注册 `/bigfatfish/usage` 路由（GET，JSON，no-store）。
  4. 注册规则（`id: 'bigfatfish-github'`）。
- 事件处理（规则 `run`）：
  - kind/source 不符 → 忽略；按 `delivery.event.name` 分发 `issues` / `issue_comment` / `pull_request_review`。
  - sender bot / repo 为空 → 忽略。
  - 去重：内存 `Map<deliveryId, ts>`（保留 24h）。
  - `issues` opened/edited 与 `issue_comment` created/edited 的 @mention → ack（若已有 ack marker 则跳过），repo 不在白名单 → unsupported（去重）。
  - 批准：`issue_comment` created，非 bot，repo 白名单，association 允许，`isApproval`，issue 已有 ack marker，无 in-flight/无同分支 open PR → 查额度 → 入队。
  - review：`pull_request_review` `submitted`，非 bot，白名单，head 分支以 prefix 开头，state ∈ {changes_requested, commented} 且有 body 或 comments → 入队；approved → approved 文案。
- 队列：每仓库串行 FIFO（最多 `maxQueuePerRepo` 条，超出回 busy 文案）；全局并发 ≤ `maxConcurrentSessions`。
- 实现 pipeline：
  1. `usageStore.beginIssue`（额度检查+计数）；不允许 → limit 文案。
  2. `github.commentIssue(started)`。
  3. `git.ensureRepo` + `checkoutFresh`。
  4. `github.getIssue` + `listIssueComments`（截断）→ `buildIssuePrompt`。
  5. `runAgentSession`。
  6. `git.commitAll`；`git.push`；`github.createPull`（body 含 `Closes #n` + diffStat）；`github.commentIssue(DSH 文本 + PR 链接 + marker)`。
  7. `usageStore.finishIssue`（tokens、prUrl、sessionId、status）。
  8. 任一步失败：`github.commentIssue(failed 文案)`，`finishIssue(status failed, error)`，日志。
- review pipeline 类似：`beginReview` → `checkoutExisting` → `getPull/listReviews/listReviewComments` → `buildReviewPrompt` → `runAgentSession` → `commitAll/push` → `commentPull(DSH 文本 + Commit 链接 + marker)` → `finishReview`。approved 不建会话。
- 保存 usage 记录后在 `snapshot()` 立即可见。

## 8. client.js（client-ui）要求

- 模块 id `bigfatfish-bot`；`inject: ['slots','locale']`。
- 注册 locale `bigfatfish-bot`（zh/en），`t = ctx.locale.bind('bigfatfish-bot')`。
- 注册 `main` 页面 `bigfatfish-usage` + `sidebar.panellist` 入口（同 id，order 20，icon 用内联 SVG 鱼，`currentColor`）。
- 页面每 5 秒 `fetch(api('/bigfatfish/usage'))`（`api` 复制 dshmarket：`new URL(path.replace(/^\/+/,''), document.baseURI).pathname`），显示：
  - 日期 + 总 tokens/会话数；
  - 每个仓库卡片：`repo`、`n/5`、issue 行（`#num title`、状态、PR 链接、tokens）；reviews 行（PR 号、状态、tokens）；
  - 空态/错误态 + 手动刷新按钮。
- 样式只用 `--dsw-alias-*` token；组件内 `<style>` 或内联样式；卸载时清理定时器/监听。
- 文案全部走 locale。

## 9. 编码/安全约束

- 纯 ESM JavaScript，`node:` 内置模块；不新增依赖（除 package.json 已列）。
- 不写 `/home/your-user/.dsh` 的 profile 文件；数据文件只写 `/home/your-user/.dsh/bigfatfish-bot/usage.json`。
- 不打印/不持久化 token、secret、私钥内容；不把 token 写进 prompt/评论/日志。
- 不执行 `plugin_manager` 安装、不改服务器配置（除 verifier）。
- 每个文件写完后 `node --check <file>`（ESM 用 `node --check` 即可）。
- 完成后用 `send_message` 汇报：文件列表、关键决策、未决问题、自检结果。

## 10. 现有验证事实

- webhook 入口已通：Caddy `your-webhook.example` → `127.0.0.1:5562`，证书有效。
- App 私钥可用：`/path/to/secrets/github-app.pem`；webhook secret 文件已验证 HMAC。
- 测试仓库：`example/your-repo`；installation `179297570`。
