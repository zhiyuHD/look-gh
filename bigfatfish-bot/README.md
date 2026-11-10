# BigFatFish Bot

DSH Host 插件：经 GitHub App webhook 盯着白名单仓库的 issues，维护者批准后由 DSH
自动改代码、开 PR、读 review；内置会话沙箱、每日额度、同会话续聊，以及一个给
agent 项目测试用的本地 DeepSeek 中转站。左侧栏提供「今日用量」页面。

## 组成

- `cordis.patch.yml`：规则插件行、自定义 agent preset（最小工具集）、
  `bot-sandbox` 权限预设（workspace-write + approval never）。
- `index.js` + `lib/`：事件分发、GitHub API、git、DSH 会话（同一 issue 复用同一
  会话）、每日额度与用量存储、签名 webhook 入口（`node:http`，HMAC-SHA256）、
  模型工具（`bff_*`）、本地中转站。
- `client.js`：左侧栏入口 + 今日处理/ token 用量页面（`/bigfatfish/usage`）。
- `locale/`、`icon.svg`：插件清单显示元信息。

## 入口链路

```
GitHub App webhook
  -> https://your-webhook.example        (Let's Encrypt, Caddy)
  -> Caddy: rewrite / -> /github
  -> http://127.0.0.1:5562/github
  -> 本插件 (HMAC 验签, 202, 幂等分发)
```

GitHub 里配置的 webhook URL 保持 `https://your-webhook.example` 不变。

## 项目化记忆（跨会话，独立于工作区）

- 每个仓库有独立的记忆目录：`~/.dsh/bigfatfish-bot/memory/<owner>/<repo>/`。
- 只允许普通 `.md` 文件；单文件 ≤256KB、单仓库总量 ≤4MB、最多 500 个文件；
  禁止路径穿越、符号链接、非 `.md` 后缀。
- 工具：`bff_memory_list()`、`bff_memory_read({name})`、`bff_memory_write({name,content,mode?})`；
  写入只在实现/评审阶段允许，triage/问答只读。
- 每次新会话 prompt 会列出该仓库已有记忆文件，并引导模型**先读取相关记忆**、完成实现/评审后
  **把本次学到的知识写入记忆**；extra repo 通过 `repo` 参数使用各自的记忆。
- 记忆**不会**随工作区/会话清理删除，也不在 clone 目录里：它是宿主侧独立存储。

## 分支由模型自己选；每次处理完清理工作区

- 初始**不会**替模型 checkout/pull 任何分支：克隆/拉取后停在仓库默认分支。
- 模型在实现/评审阶段第一步调用 **`bff_checkout({ branch, base? })`**：
  - 远程已有该分支 → 拉取并 reset 到 `origin/<branch>`；
  - 远程没有 → 从 `base`（默认仓库默认分支）新建。
- 之后的 `bff_commit` / `bff_push` / `bff_create_pr` 必须使用 `bff_checkout` 选定的分支；
  PR 的 base 默认是仓库默认分支，也可以在 `bff_create_pr({base})` 指定。
- **默认每个 job 结束都保留** clone、workspace 和会话，供后续批准、review、评论续聊
  （同一 issue/PR 的会话会继续 resume）。
- 只有模型判断**整个任务彻底结束**（不会再等批准/评审/后续评论）时，才调用
  **`bff_done({reason})`**；宿主在会话结束后才执行清理：
  - 归档该会话（DSH 的“删除”语义：从活跃列表移除，日志保留）；
  - 清除 issue 的会话映射；
  - 删除克隆目录并移除 workspace 注册；
  - 结果写入 `~/.dsh/bigfatfish-bot/cleanup.log`。
- 普通回复、等待批准、PR 等 review、review 改完可能还有评论——模型不会调用 bff_done，
  因此这些轮次工作区都保留。
- 回复由模型通过工具 **`bff_reply({body})`** 发表；最后一条 assistant 消息不再自动当作
  GitHub 回复。宿主只负责追加 PR/commit 链接和标记。
- `bff_reply` 会拉取该 issue/PR 最新的人类评论并在工具结果里返回 `recentComments`；
  宿主还会在最终评论末尾自动附上「最近的人类回复」摘要（最多 3 条，排除 bot 和纯 /approve）。
- 模型可在长任务的里程碑用 **`bff_progress({message})`** 汇报进度（最多 8 次/任务，
  间隔 ≥10 秒）；进度直接发到 issue/PR，最终结果仍由 `bff_reply` 发表。
- **创建 PR 后不能立即结束**：必须等该 PR 的 review 处理完成，才允许 `bff_finish`/`bff_done`；
  实现会话里带 PR 时调用 `bff_done` 会被直接拒绝。
- **issue 被 close 时自动归档**：插件监听 `issues.closed`，自动归档该 issue 的会话、
  清除会话映射；若该仓库没有其他进行中的 job/会话，还会删除共享 clone 并移除 workspace。
  已有其他打开 issue 的会话时只归档当前会话、保留共享工作区。
- PR 评论触发的 review 现在也接受 bot 自己开的、分支名任意的 PR（不再只认 `dsh/` 前缀）。

## 谁能触发、是否需要批准

- issue/评论 @bot 后先进入 **triage** 会话：模型判断是提问/讨论还是需要改代码。
  - 普通提问 → 直接回答，不改代码、不占每日额度。
  - 需要改代码 → 模型调用 `bff_request_approval` 并回帖请 Owner/Collaborator
    批准（标记 `bigfatfish:approval-requested`），此时不占额度。
  - **issue 由 Owner 提出 → 无需批准**，直接进入实现流程。
- 只有存在 approval-requested 标记时，Owner/Collaborator 的 `/approve` 或「同意」
  才会启动实现；实现会话会 **resume triage 的同一个 DSH 会话**。
- PR 评论的 review 流程不变（先 ack，批准后改同一 PR 分支）。

## Agent 决策的提交与 PR

Bot 会话不再由插件自动 commit/push/PR。模型通过插件提供的工具自行决定：

- `bff_commit({ message })`：提交当前改动，commit message 由模型撰写。
- `bff_push()`：把当前分支推到 GitHub（review 更新已有 PR 时用）。
- `bff_create_pr({ title, body })`：模型自行决定是否开 PR，并撰写标题/描述。
- `bff_finish({ summary })`：可选，结束本轮并给出摘要。

插件只负责把会话最后回复（或 finish 摘要）发到 GitHub，并把 `PR:` / `Commit:`
链接附在末尾。

## 同一 issue / 同一 PR = 同一 DSH 会话

同一仓库同一 issue 的实现、后续 PR 评论修改、正式 review 都会继续使用同一个
DSH Session（从 usage 记录里按 issue 找回 session id；优先复用 live agent，
否则从持久化日志 resume）。PR 分支名必须符合 `branchPrefix`（默认
`dsh/issue-`）才能定位到对应 issue。

## GitHub review 支持

- 正式 review（`changes_requested` / 有内容的 `commented`）→ 会话续聊并修改。
- PR 会话里的普通评论：维护者评论修改要求 → `@bigfatfish-bot` 收到 ack →
  回复 `/approve` 或「同意」→ 会话续聊并按 PR 评论修改、推送同一分支。
- `approved` review → 只回固定确认，不跑模型。

## 每日额度

`dailyIssueLimit`（默认 5）按仓库每自然日统计「批准后实际启动的实现会话」；
comment / review / PR 更新不计。超限回「该仓库今日已达到上限（5/5）」并拒绝启动。
可用 `usage.json` 查看/审计；额度计数持久化在
`~/.dsh/bigfatfish-bot/usage.json`。

## Extra Repo（跨两个仓库的改动）

- 实现阶段如果模型判断还需要另一个仓库（例如客户端/服务端成对修改），会调用
  `bff_add_extra_repo({repo})`；该仓库必须同时满足：
  1. 在白名单里；2. GitHub App 的安装范围包含它（同一 installation）。
- 克隆位置：主仓库工作区内的 `.bigfatfish/extra/<owner>/<repo>`（被 git exclude，
  不会混入主仓库提交）。
- 之后 `bff_commit` / `bff_push` / `bff_create_pr` 传 `repo:"owner/repo"` 即可对
  第二个仓库提交并单独开 PR；issue 回复会同时列出主 PR 和 extra PR，用量页也会
  显示额外 PR 链接。

## 侧边栏页面：模型、白名单与重置

左侧栏「BigFatFish」页面除了今日用量，还支持：

- 「会话模型」：选择 Bot 会话使用的 Provider（来自 `ctx.llm.listProviders()`）并填写模型 id，
  保存后写入 `~/.dsh/bigfatfish-bot/model.json`，对**下一次** triage/实现/review 会话生效；
  「恢复默认」删除覆盖、回到部署默认模型。Host 路由：`GET/POST /bigfatfish/model`。
- 查看/添加/移除白名单仓库（改动写入 `~/.dsh/bigfatfish-bot/allowed-repos.json`，
  立即生效，无需重启插件；该文件优先于配置里的 `allowedRepos`）。
- 每个仓库卡片上的「重置今日次数」按钮，调用
  `POST /bigfatfish/usage/reset` 清零该仓库当天计数与记录。
- 对应 Host 路由：`GET/POST /bigfatfish/repos`、`POST /bigfatfish/usage/reset`。

## 沙箱（不可信 issue 文本）

三层防护：

1. `bot-sandbox` 权限预设：`workspace-write` 沙箱（bwrap/Landlock），文件写入
   限制在工作区与临时目录，`approval: never` 无人工可批、也不能申请提权。
2. 自定义 agent preset：只带 bash/fs/fs-search/todo/compaction，不含 web、
   subagent、workflow、skill、plugin-manager、goal、schedule、ask-user。
3. 会话守卫（`lib/guard.js`）：工具白名单、文件路径必须位于工作区或 `/tmp`、
   bash 命令阻断网络（curl/wget/ssh…）、包管理器、sudo/系统命令、敏感路径、
   git 状态修改等。被拒绝会作为工具错误返回给模型。

Go 项目例外：Go 工具链与模块下载被允许（测试需要），建议用仓库内缓存：
`GOCACHE="$PWD/.cache/go-build" GOMODCACHE="$PWD/.cache/go-mod" \
GOPATH="$PWD/.cache/gopath" GOTOOLCHAIN=local go test ./...`，必要时加
`GOPROXY=https://goproxy.cn,direct`。

Rust 项目例外：`cargo` / `rustc` 已开放（`cargo build/test/run/check/clippy/fmt` 等），
**允许 cargo 自身访问 crates.io 下载依赖**（网络只允许由工具链发起，curl/wget 仍禁止）；
建议用仓库内缓存：
`CARGO_HOME="$PWD/.cache/cargo" RUSTUP_HOME="$PWD/.cache/rustup" cargo test`。
`cargo install/publish/login` 与 `rustup` 仍被拒绝；`.cache/` 等已写入 `.git/info/exclude`，
不会被提交。

## 本地 DeepSeek 中转站（给 agent 项目测试）

- 地址：`http://127.0.0.1:5563/v1`（仅 loopback），OpenAI 兼容
  `/v1/chat/completions` 与 `/v1/models`。
- 鉴权：`Authorization: Bearer local-dev-key`（配置 `relayKey`）。
- 上游：DSH 当前配置的模型路由（`relayProvider`/`relayModel` 可固定，
  默认用部署默认模型）。
- 额度：默认 5 CNY，按 `relayPriceInputCnyPerM` / `relayPriceOutputCnyPerM`
  扣费；余额不足时返回 HTTP 402。
- 查询/充值：
  `curl http://127.0.0.1:5563/bigfatfish/relay`
   `curl -X POST http://127.0.0.1:5563/bigfatfish/relay/topup \
     -H 'content-type: application/json' -d '{"cny":5}'`
- 账本：`~/.dsh/bigfatfish-bot/relay-credit.json`（0600）。

## 配置

见 `cordis.patch.yml`。常用项：

- `allowedRepos`：白名单（`owner/repo`）。非白名单仓库被 @ 时只回「仓库不支持」。
- `dailyIssueLimit`：每仓库每日实现会话上限。
- `approvalKeywords` / `denyKeywords` / `approvalAssociations`：维护者批准判定。
- `workspaceRoot`：仓库克隆根目录（每个仓库一个独立工作区）。
- `agentPreset: bigfatfish-bot`、`permissionPreset: bot-sandbox`：沙箱会话。
- `modelProvider` / `modelId`：固定模型路由（避免使用无 key 的默认 provider）。
- `relay*`：本地中转站配置。

## 安全

- webhook secret 从 `/path/to/secrets/webhook-secret` 读取，仅用于
  HMAC 验签；不写日志、不进 prompt/评论。
- App 私钥仅 Host 读取；installation token 仅内存缓存；推送与工具都用临时
  token，不写盘、不进日志。
- 忽略 bot 自身事件；白名单外只回「仓库不支持」；每日额度硬限制。
