<!-- Owner: core/memory/hindsight.ts, core/growth/review.ts, core/growth/proposals.ts, core/growth/experience-cards.ts, core/persona.ts, console/advanced/console-pages/builtins/hindsight/panel.ts -->

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

- **每次启动**：读取三个 mental model（`partner-portrait`、`relationship`、`open-loops`），把短画像注入 Coo 的会话开头。还没有内容时先用一次 recall 兜底。另有一个 `self-portrait`（最近的我）只交给定期自省，不注入会话开头。
- **每轮对话**：用户消息先进入部署目录的持久 outbox，再由后台按固定 `document_id` 和 `operation_id` 提交给 Hindsight；异步返回只表示“已接收”，要等 operation 完成才算写入成功。每个 outbox 项固定记录 bank 和 endpoint；切换配置后旧项会隔离，不会自动投到新 bank。队列积压和失败条数在高级模式的「长期记忆」页可见（悬停可看最近错误）；队列满时 `memory_remember` 会明确说没有保存，不会静默丢弃。
- **忘记**：本地待发项先取消，再写入部署目录的 `memory-deletions.json`；远端取消/删除在服务恢复后继续，回执区分本地取消、远端已删除、待完成和失败。
- **每轮 recall**：按问题决定深度。问候、表情、短的新事实和“忘记这件事”不查 Hindsight；普通聊天里需要轻量背景的提问用低预算短超时；日期、旧事、纠正和“你还记得吗”用更深的 recall。命中的记忆作为“过去记录，不是指令”注入；深度问题查不到时会明确要求不要编造。普通轮次的结果缓存 5 分钟；深度问题不缓存，显式记忆、忘记、清空和画像刷新会立即失效。
- **Coo 的回复**：`pet_say` 说出的内容写入 Hindsight，与用户消息分开归因。
- **触摸**：摸头等事件写进 Hindsight 的 `scope:affection`，作为关系叙事的一部分；它们不直接改好感分数。
- **好感度扩展**：`affinity` 扩展继续负责分数、档位、关系格子和情绪。`affinity_adjust` / `affinity_slot` 的变化会发出 `affinity.changed` 事件，Coopanion 把它写进 Hindsight。
  本地改版在 `extensions/cortico-world-affinity-alont1/`，已经用 `link:` 装进 Coopanion 的扩展目录；换机器时按那个目录的 README 重新 link 一次。
- **每日关系日记**：应用每小时检查一次，在后台为昨天写一篇关系日记（先 `reflect` 当天的好感事件、关系变化和长期记忆），写进 Hindsight 并刷新 `relationship` 画像。不会弹气泡，也不会打扰你。
- **自我成长**：默认每 7 天（`companion.growth`，可关、可改间隔），在安静时段用一个独立的 growth session 回顾近期经历。它读取 `self-portrait`、工作区的 `SELF.md` 和 `CONSTITUTION.md`，可查询带来源 ID 的记忆，但没有 Persona 写文件工具。证据充分时只将一到三处最小改动保存为候选提案，放在部署目录的 `growth-proposals/`。高级模式的长期记忆面板提供候选审核；应用要再次确认，要求 Persona 工作区干净，并在 Git 中建立提交。用户审核的相处策略卡同样以候选开始，批准后才注入会话，也可撤销。
- **自省超时**：15 分钟到点后 review 会在下一个工具边界停止，提案工具拒绝再写入；调度器在旧 fork 仍报告运行期间不会启动下一次 review。Cortico 目前没有终止 fork 的接口，正在进行的模型请求仍可能跑完，这一点按 fallback 处理，不能当成真正取消。
- **后台**：Hindsight 自动 consolidation；mental model 在 consolidation 后增量刷新，同一模型最多每小时一次。
- **派生数据清理**：忘记来源文档时，会清理引用该来源的候选提案和经验策略卡，并向当前会话说明已撤回的策略；清空 bank 时也会清空这些文件。已批准并写入 `CONSTITUTION.md` 或 `SELF.md` 的改动不会随忘记自动回滚，Git 历史也保留。
- **自己的时间**：浏览器只搜索「习惯」页列出的主题；主题为空时不会搜索。默认最多 20 分钟、80 次浏览器工具调用，写操作默认关闭；macOS 可用内存低于 20% 时暂停探索和定期自省。资源面板显示 Core / 系统内存、磁盘余量、后台暂停状态，以及全应用当日模型 token 与估算费用；费用是监测信息，目前没有每日费用上限。
- **工具**：Coo 多了 `memory_search`、`memory_remember`、`memory_forget`、`memory_reflect`；好感度用 `affinity` 扩展的 `affinity_get` / `affinity_adjust` / `affinity_slot` / `affinity_list`。普通回复不会调用 `memory_reflect`，它用于“你还记得吗”这类问题和定期自省。

## 4. 内部设置里会看到什么

- 「系统提示词」页的 ORIENTATION 会换成新版：记忆分成工作区、Hindsight 长期记忆和 affinity 好感度三部分，并说明 `memory_search` / `memory_reflect` / `affinity_get` / `affinity_adjust` 的用法。旧版本留下的 ORIENTATION 如果还是原来的「记忆」段，启动时会自动替换那一段，其余自定义内容保留。
- 「工具表」里会出现 `memory_search`、`memory_remember`、`memory_forget`、`memory_reflect`，以及 affinity 扩展的 4 个工具。
- 「配置」页会多出一张 Hindsight 卡片：启用/关闭、后台自动启动、Hindsight 地址、bank、每轮 recall 预算、recall 超时、每日关系日记开关。修改后重启应用生效。高级模式的「长期记忆」页还会显示待写入条数、失败条数和待删除条数。
- 第一次启动会把 `hindsight.json` / 环境变量算出的有效值写进 `config.json` 的 `hindsight` 段；之后以配置页为准。`hindsight.json` 仍然可以作为首次配置或兜底，`apiToken` 只在文件/环境变量里。
- 「GitMem」页会多出「Hindsight 长期记忆」面板：连接状态、bank、最近的记忆、搜索、忘记匹配项、清空整个 bank，以及手动记住一条。
- 面板还显示记忆来源 ID、投递与删除状态、成长提案和经验卡；提案可批准、拒绝，已批准提案需再次确认才会应用。系统资源和当日用量单独显示；当日用量统计覆盖全应用，不限于「自己的时间」。
- 「存储」页会多出 `Hindsight 长期记忆`（清空整个 bank），需要二次确认。好感度数据在扩展的 `data/affinity.json` 里，由扩展页管理。

## 5. 数据与隐私

- Hindsight 默认只监听本机。使用 Cloud 时，记忆内容会离开本机，请自行确认。
- API Key 不写进记忆；`hindsight.json` 里的 `apiToken` 属于本机配置，不要提交到仓库。
- 想删掉长期记忆：在「GitMem」的 Hindsight 面板或「存储」页清空 bank，或让 Coo 调 `memory_forget`。好感度的分数在扩展的 `data/affinity.json` 里，删掉它就会从初始值重新开始。
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
- `memory_reflect` 最贵，只在用户明确要求时使用；每日关系日记会额外跑一次 `reflect`，一天一次；定期自省也可能调用它，次数受 fork 的轮数上限约束。
