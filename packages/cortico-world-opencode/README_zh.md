# `packages/cortico-world-opencode/src/definition.ts` 与 `src/world.ts`

# cortico-world-opencode

Coo 可以通过 Agent Client Protocol 将编码任务交给本机的 `opencode`。在 Coopanion Core 装配中，Core 会在每条命令和文件写入派发前进行一次性确认，授权绑定到允许使用的工作区，并写入动作回执。Core 按 `fs/write_text_file` 收到的确切文件内容核对授权，再读取文件验证结果。World 单独使用时，`opencode_answer` 仍用于回复 ACP 权限请求。

## 配置

在高级设置的 World 总览中启用该 World。配置位于 `worlds.opencode`：

| 配置项 | 含义 |
|---|---|
| `bin` | `opencode` 可执行文件；默认从 `PATH` 查找 |
| `workRoots` | 任务可以启动的绝对目录，以换行、逗号或分号分隔 |
| `taskMinutes` | 单个任务的最长运行时间 |
| `permissionMinutes` | 权限请求等待确认的最长时间 |
| `askSensitive` | 要求 opencode 在写入、执行命令或获取网页前询问 |

`opencode` 必须已完成登录（`opencode auth login`）。World 不会传入 `--auto`。

## 行为

由 Coopanion Core 授权时，World 提供 `opencode_task`、`opencode_stop`、`opencode_status` 和 `opencode_review`；单独使用 World 时也提供 `opencode_answer`。任务会在选定目录启动 `opencode acp` 子进程，异步发送一次提示并立即返回。任务结束后发送 `opencode.result` 或 `opencode.failed`。结果事件包含摘要、带行数的改动文件和运行命令；`opencode_review` 显示每项改动的新旧文本。Coo 会检查结果，并接受完成内容或在同一会话中按指定问题继续处理。World 也会通知应用显示 opencode 头像状态。

Core 模式下，ACP 文件写入权限请求会先让 ACP 继续到受控文件回调；Core 在实际 `fs/write_text_file` 回调处确认路径和内容摘要。命令则在执行前由 Core 确认。确认后仅允许一次派发；文件写入会进行读回验证，命令以 ACP 报告的完成状态记录结果。未经确认的写入和命令会被取消。

## 测试

`pnpm --dir packages/cortico-world-opencode test` 运行该 World 的测试。测试使用脚本化 ACP 代理；World、子进程、JSON-RPC 行协议和临时工作目录都是真实组件，测试宿主记录 World 发送的事件。
