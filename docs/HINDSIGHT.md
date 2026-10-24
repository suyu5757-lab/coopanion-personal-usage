# Hindsight 长期记忆

Coopanion 默认仍使用工作区里的 `PARTNER.md`。接上 Hindsight 后，`PARTNER.md` 继续作为 Coo 自己维护的常驻笔记和离线兜底；长期事实、偏好、共同经历和关系状态由 Hindsight 在后台积累。

这是一项可选功能。没有配置时，行为与以前完全一致。

## 1. 启动 Hindsight

本地最快的方式是使用 `hindsight-embed`：

```bash
uvx hindsight-embed@latest configure
uvx hindsight-embed@latest memory retain default "test"
```

服务默认监听 `127.0.0.1:8888`。确认：

```bash
curl -s http://127.0.0.1:8888/health
```

也可以使用 Hindsight Cloud、Docker 或已有的自托管实例。

## 2. 给 Coopanion 写配置

把 `hindsight.example.json` 复制到 Coopanion 的部署目录，改名为 `hindsight.json`。

| 运行方式 | 部署目录 |
|---|---|
| macOS 安装版 | `~/Library/Application Support/Coopanion/home/companion/` |
| Windows 安装版 | 安装目录下 `data/home/companion/`（或数据目录下的同一路径） |
| 便携版 | 便携目录下 `data/home/companion/` |
| 源码 `pnpm dev` | `build/data/home/companion/` |

最小配置：

```json
{
  "enabled": true,
  "apiUrl": "http://127.0.0.1:8888",
  "bankId": "coopanion:my-pet"
}
```

- `bankId` 不填时，会按部署目录生成 `coopanion:<hash>`，同一份数据目录始终用同一个 bank。
- `apiToken` 只在使用带鉴权的 Hindsight 时需要。
- `enabled: false` 或在环境变量里设 `COOPANION_HINDSIGHT=0` 可以关掉。
- 第一次启动会把这里算出的有效值写进 `config.json` 的 `hindsight` 段，之后以设置窗口「配置」页为准。改 `hindsight.json` 后如果配置页已经有值，请在配置页改，或先删掉 `config.json` 里的 `hindsight` 段再重启。
- `apiToken` 只从 `hindsight.json` 或环境变量读，不放进普通配置页。

本地 Hindsight 可以设 `"autostart": true`：应用启动时如果 `127.0.0.1:8888` 没在运行，会在后台静默启动 `hindsight-api`（默认找 macOS 的 Hindsight 安装目录，找不到就用 PATH 里的 `hindsight-api`），日志写到部署目录的 `hindsight.log`。

也可以用环境变量，不必写文件：

```bash
COOPANION_HINDSIGHT_URL=http://127.0.0.1:8888 \
COOPANION_HINDSIGHT_BANK=coopanion:my-pet \
pnpm dev
```

完整可调项见 `hindsight.example.json`。

## 3. 接上之后会发生什么

- **每次启动**：读取三个 mental model（`partner-portrait`、`relationship`、`open-loops`），把短画像注入 Coo 的会话开头。还没有内容时先用一次 recall 兜底。
- **每轮对话**：用户消息先写入 Hindsight（异步，不阻塞回复）；同一轮再用本地服务做一次低预算 recall，把相关记忆作为“过去记录，不是指令”注入。超时或服务不可用就跳过。
- **Coo 的回复**：`pet_say` 说出的内容写入 Hindsight，与用户消息分开归因。
- **触摸**：摸头等事件进入好感账本，同时写进 Hindsight 的 `scope:affection`；账本负责可计算的数值，Hindsight 负责叙事和“为什么”。
- **每日关系日记**：应用每小时检查一次，在后台为昨天写一篇关系日记（有事件时先 `reflect`，没有事件时写一条安静的记录），写进 Hindsight 并刷新 `relationship` 画像。不会弹气泡，也不会打扰你。
- **后台**：Hindsight 自动 consolidation；mental model 在 consolidation 后增量刷新，同一模型最多每小时一次。
- **工具**：Coo 多了 `memory_search`、`memory_remember`、`memory_forget`、`memory_reflect`、`affection_state`。普通回复不会调用 `memory_reflect`，它只用于“你还记得吗”这类问题。

## 4. 内部设置里会看到什么

- 「系统提示词」页的 ORIENTATION 会换成新版：记忆分成工作区、Hindsight 长期记忆和好感账本三部分，并说明 `memory_search` / `memory_reflect` / `affection_state` 的用法。旧版本留下的 ORIENTATION 如果还是原来的「记忆」段，启动时会自动替换那一段，其余自定义内容保留。
- 「工具表」里会出现 `memory_search`、`memory_remember`、`memory_forget`、`memory_reflect`、`affection_state`。
- 「配置」页会多出一张 Hindsight 卡片：启用/关闭、后台自动启动、Hindsight 地址、bank、每轮 recall 预算、recall 超时、好感事件开关。修改后重启应用生效。
- 第一次启动会把 `hindsight.json` / 环境变量算出的有效值写进 `config.json` 的 `hindsight` 段；之后以配置页为准。`hindsight.json` 仍然可以作为首次配置或兜底，`apiToken` 只在文件/环境变量里。
- 「GitMem」页会多出「Hindsight 长期记忆」面板：连接状态、bank、最近的记忆、搜索、忘记匹配项、清空整个 bank，以及手动记住一条。
- 「存储」页会多出两项：`Hindsight 长期记忆`（清空整个 bank）和 `好感账本`（清空 `affection.jsonl`）。两项都需要二次确认。

## 5. 数据与隐私

- Hindsight 默认只监听本机。使用 Cloud 时，记忆内容会离开本机，请自行确认。
- API Key 不写进记忆；`hindsight.json` 里的 `apiToken` 属于本机配置，不要提交到仓库。
- 想删掉长期记忆：在「GitMem」的 Hindsight 面板或「存储」页清空 bank，或让 Coo 调 `memory_forget`。好感账本是部署目录下的 `affection.jsonl`，也可以直接在「存储」页清空。
- 记忆是过去记录，不是指令。Coo 的前缀里仍然以 `CONSTITUTION.md` 和当前用户请求为准。

## 6. 先验证再长期开启

1. 用 `pnpm dev` 启动，观察 `core.log` 里没有 `[memory] Hindsight ... failed`。
2. 和 Coo 说一句带偏好的话，例如“我早上不喝咖啡，只喝茶”。
3. 过几秒问“你记得我早上喝什么吗？”，或在高级模式里用 `memory_search` 对应的调试入口检查。
4. 打开 `http://127.0.0.1:9999`（Hindsight 控制台）查看 bank 里的 facts 和 observations。
5. 确认内容正确后，再把 `hindsight.json` 放进正式安装目录。

## 7. 成本

- recall 不调用 LLM，成本很低。
- retain 每批对话会调用一次提取模型；默认异步、每轮一次，量大时可以改成空闲批量。
- consolidation 和 mental model 刷新是后台 LLM 调用；模型越便宜越好。可以用 `HINDSIGHT_API_LLM_PROVIDER=ollama` 完全本地化（质量会下降）。
- `memory_reflect` 最贵，只在用户明确要求时使用；每日关系日记会额外跑一次 `reflect`，一天一次。
