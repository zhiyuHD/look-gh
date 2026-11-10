# BigFatFish Bot (`look-gh`)

一个运行在 **DeepSeek Harness (DSH)** 上的 GitHub Issue AI 机器人：在 issue/PR 评论里 @ 机器人，它会自行判断是回答问题还是改代码，走审批、实现、提交、开 PR 的完整流程。

## 目录

- [`bigfatfish-bot/`](bigfatfish-bot/) — DSH Cordis 插件源码（Host 端 + 侧边栏 Client 端）
- [`bigfatfish-bot/README.md`](bigfatfish-bot/README.md) — 安装、配置、功能和运行说明
- [`CONTRACT.md`](CONTRACT.md) — 最初设计与接口契约

## 主要特性

- GitHub App webhook 签名入口，无额外 npm 依赖
- 白名单仓库 + 每仓库每日 issue 额度
- triage：问题直接回答；需要改代码时先请求 Owner/Collaborator 批准
- AI 自己决定 commit / PR 内容，用插件提供的 `bff_*` 工具提交
- 严格 bwrap 沙箱：工作区可写，宿主敏感目录不可见；Go / Cargo 工具链可用
- 分支由模型自选；创建 PR 后必须等 review 完成才能结束
- 按仓库的项目记忆（仅 `.md`，跨会话保留）
- 侧边栏：用量、白名单、重置次数、会话模型、项目记忆等
- 可选的本地模型中转站

## 快速开始

1. 按 [`bigfatfish-bot/README.md`](bigfatfish-bot/README.md) 安装为 DSH bundle；
2. 修改 `bigfatfish-bot/cordis.patch.yml`：填入你的 GitHub App `appId`、私钥与 webhook secret 路径、工作区目录；
3. 在 GitHub App 设置里配置 webhook URL 和事件（issues、issue_comment、pull_request_review）；
4. 在 DSH 侧边栏添加白名单仓库；
5. 在 issue 里 @ 你的机器人。

## 安全提示

本仓库只包含示例配置。**不要把 GitHub App 私钥、webhook secret、API token 提交进仓库**；实际部署时使用环境变量或仓库外的 secrets 文件。
