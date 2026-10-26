Owner: `index.mjs`, `ENV_PROMPT.md`, `ENV_PROMPT.en.md`

# Codex World

Coopanion v0.4.0 内置的可选执行助手，默认关闭。Coo 负责对话、任务选择和结果验收，Codex 在后台执行已授权任务；OpenCode 独立保留。

先安装并登录本机 Codex CLI。在高级模式 World 页启用 `codex`，配置 `bin` 为 CLI 可执行文件，`workRoots` 为允许的绝对目录（每行一个），`taskMinutes` 为 1–240 分钟。多个根目录时任务必须提供 `dir`。Windows 请指定可直接执行的 Codex 二进制文件；尚未验证 Windows 的本机任务执行。

- `codex_task`：任务描述、目录、`readOnly` 和 `resume`；立即返回编号。只读诊断使用 `readOnly: true`。
- `codex_status`：当前任务状态；完成事件自动送达，无需忙轮询。
- `codex_review`：总结、文件修改、命令、错误和会话编号；据此验收。
- `codex_stop`：停止当前进程组；不自动回滚修改。

同一时间运行一个任务。续接限定上次任务的目录、沙箱模式和会话编号。路径检查解析符号链接；拒绝范围外目录。默认使用 workspace-write，显式只读使用 read-only；不申请交互授权。任务失败、超时或取消均作为失败回报，结束时保存最近一次结果。

旧的同名扩展由内置 World 优先替代，已有 `worlds.codex` 配置保持原值，不删除扩展源码或记录。执行器的 CLI 配置与 Hindsight 按本机和工作目录决定；共享记忆不提供额外授权。不得使用额度重置券。

## English

Optional bundled World, disabled by default. Install and sign in to Codex CLI separately, enable the World and configure `bin`, `workRoots` (one absolute directory per line) and `taskMinutes`. Coo delegates authorized work and reviews completion events. OpenCode remains independent.

Use `readOnly: true` for diagnosis. One task runs at a time; resume requires the same directory, sandbox and recorded session. Cancellation stops the process group without rolling back edits. Canonical directory checks reject symlink escapes. Failed, timed-out and cancelled tasks are never reported as successful. Existing same-name extension configuration is preserved; the bundled definition takes precedence.

Run `pnpm run test:codex` on macOS/Linux for process and event regressions without contacting a model. Windows task execution remains unverified.
