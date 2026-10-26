# Coopanion 桌宠本地改版

这是 `cortico-world-affinity-alont1` 的本地修改版，给 Coopanion 的桌面宠物用：

- 只有一个对象：工具里的 `qq` 可以省略，默认使用 `worlds.affinity.subjectId`
- 不再把 `masterId` 固定成满分；桌宠里设 `masterId: 0`，关系分从 `startScore` 开始正常积累
- `affinity_adjust` / `affinity_feel` / `affinity_repair` / `affinity_slot` 会发出 `affinity.changed` 事件，Coopanion 会把它写进 Hindsight
- 环境提示词改成 Coo 的桌宠语气，去掉 QQ 号、群起步分和攻击性措辞
- 关系、情绪、表达方式和还没过去的事仍然由这个扩展维护；Hindsight 只做长期叙事和每日关系日记

原版说明保留在下面。

## 装到 Coopanion

```bash
cd "$HOME/Library/Application Support/Coopanion/extensions"
corepack pnpm add link:<仓库路径>/extensions/cortico-world-affinity-alont1
```

重启 Coopanion 后，控制台「扩展」页会显示这个本地版本。`config.json` 的 `worlds.affinity` 建议：

```json
{
  "enabled": true,
  "masterId": 0,
  "subjectId": 1106717738,
  "startScore": 20
}
```

`subjectId` 是桌宠里的这个人；`masterId: 0` 表示不再固定满分，关系分从 `startScore` 正常积累。

---


# cortico-world-affinity-alont1

她心里有一本账：**按 QQ 号记住关系分数**，回话前查一下对方该用什么态度。
不是助手式的"用户画像"——这是她自己的账本，她自己记。

## 为什么是"她自己记账"

Cortico 的 World 收不到消息事件：`WorldHost` 只有 `pushEvent`，没有订阅接口。
所以这套不能被动地"听到消息就涨分"，而是做成四个工具，**由她在对话里自己用**：

| 工具 | 干什么 |
|---|---|
| `affinity_get` | 感受这个人的关系、她心里的情绪、表达方式和还没过去的事；不报分数 |
| `affinity_adjust` | 调亲疏（+ 或 -），并写一句为什么；分数是账本，不报出来 |
| `affinity_feel` | 记一股情绪：多强、为什么、冲着谁、碰到哪条需要、说不说、是不是没过去 |
| `affinity_repair` | 记一次修复：他做了什么、她接不接受、这件事过去没有 |
| `affinity_slot` | 给某人定"他算她什么人"；填 `撤` 就撤掉 |
| `affinity_list` | 看她心里排前面的几个人，连同各自那格 |

代价是每次要多一次工具调用；好处是完全不碰框架源码，上游更新不会冲突。

## 两把尺子：分数，和格子

**分数是亲疏**——多熟。谁待她好就涨，冷了就掉，会自己变。

**格子是性质**——他算她的什么人。**只有她能定**，定完不会因为掉分自己变，改不改也由她。

| 格子 | 什么算这一格 |
|---|---|
| 家人 | 血缘那一种：长辈、兄弟姐妹、自己人 |
| 恋人 | 想跟这个人在一起、是唯一的那一个 |
| 闺蜜 | 最贴的那一层朋友，什么都说得出口 |
| 朋友 | 处得来、愿意搭话、愿意帮忙，但不掏心窝 |
| 搭子 | 为某件事凑在一起的 |
| 同学 | 同一个班／同一个群的 |
| 熟人 | 认识、能说两句，也就那样 |
| 不对付 | 合不来。不用装客气，也不用硬处 |
| 说不清 | 还没想好是哪一种——这一格允许长期挂着 |

**格子不是待办清单。** 空着才是常态：认到那个份上、她自己想说清"这是我什么人"的时候再填，
那才准。提示词里也是这么写的，别在旁边催她填满。

## 五个档位

| 分数 | 档位 | 她的态度 |
|---|---|---|
| 80+ | 好朋友 | 很亲近。会关心他、会惦记他，软的那面露得多一点 |
| 55+ | 朋友 | 不用装了。会主动说话、会开玩笑、愿意帮忙 |
| 35+ | 熟人 | 能聊两句了。会接梗、会搭话，但还端着 |
| 15+ | 眼熟 | 不那么冷了，但不主动。搭理他，但不热络 |
| 0+ | 陌生群友 | 客气、疏远。让你做事先懒得一下，私人问题敷衍过去 |

**`masterId`（默认 0 = 不设）固定在满分**，不进这套涨跌——骂她也不会掉。
`masterId` 那一格由插件写成「家人」，**只报不改**：她能看见，但改不动，也不占她自己给别人定的格子。

## 装

```bash
cd "<Cortico 根目录>"
corepack pnpm add --ignore-workspace ./plugins/cortico-world-affinity-alont1
```

然后**重启 Cortico**（扩展只在启动时加载）。控制台「扩展」页应该出现
`cortico-world-affinity-alont1`，状态是「已加载」。

## 开

装完默认是关的（`enabled: false`）。开两处：

1. **`deployments/<部署名>/config.json`** 里加一段：

   ```json
   {
     "worlds": {
       "affinity": { "enabled": true, "masterId": 100000001 }
     }
   }
   ```

   `masterId` 建议显式写：插件默认是 0，空着的话她会认为"主人"是 0 号。

2. **`bots/<bot 名>/index.ts`** 的 `declares` 里加上 `'affinity'`——不声明的话控制台里是灰卡。

   ```ts
   declares: ['terminal', 'qq', 'affinity'],
   ```

   然后重启。启动日志里应该能看到 `World: affinity`。

> 第 2 步要改仓内 bot 的源码。改不动或不方便的话，也可以只做第 1 步试试——
> 装配层会给未启用的 World 也建实例，但**控制台上不一定能配**。

## 用

她不需要你教。`ENV_PROMPT.md` 已经告诉她：回话前先 `affinity_get` 感受关系，发生值得记的事就
`affinity_feel`（只调远近用 `affinity_adjust`），事情过去了用 `affinity_repair`，认下某个人的性质就
`affinity_slot`。你要做的只是正常聊天。

看账本：

```bash
cat "deployments/<部署名>/data/affinity.json"
```

长这样：

```json
{
  "version": 1,
  "people": {
    "100000001": { "score": 100, "msgs": 12, "best": 100, "note": "", "slot": "家人", "slotAt": "2026-01-01T00:00:00.000Z" },
    "100000002": { "score": 11.2, "msgs": 81, "best": 11.2, "note": "+0.8 跟我讲了他今天的事", "slot": "搭子" }
  }
}
```

## 调

控制台「好感度」配置页（或 `config.json` 的 `worlds.affinity` 段）：

| 旋钮 | 默认 | 说明 |
|---|---|---|
| `masterId` | 0 | 主人。满分且永不掉分。改完重启生效 |
| `startScore` | 20 | 第一次见到某人给多少分 |
| `gainPerMessage` | 0.6 | 每句话加分（有来有回才算一次互动） |
| `dailyGainCap` | 12 | 每日加分上限，防刷 |
| `lossFat` | 3.0 | 说她胖掉多少——死穴，掉得最狠 |
| `lossInsult` | 1.5 | 骂她掉多少 |
| `friendFloor` | 55 | 到过这个分数就保底，疏远也掉不破 |
| `groupStartScore` | — | 键是群号、值是分数。名单里的人一进那个群就按这个分起步 |
| `emotionHalfLifeMinutes` | 90 | 被夸或挨骂之后，那股劲多久减一半 |

改 `startScore`、`gainPerMessage` 这类是**热生效**的；`masterId` 要重启。

## 改

改完源码**重启生效**（扩展用 link 方式装入，不拷贝）：

```bash
# 改完跑一下类型检查
cd "<Cortico 根目录>/plugins/cortico-world-affinity-alont1"
npx tsc --noEmit
```

## 排错

**扩展页显示「加载失败」**
看控制台报的原因。常见：`cortico.api` 版本不匹配、或 `"type": "module"` 漏了。

**装了但聊天时她不查**
`worlds.affinity.enabled` 是不是 `true`？启动日志里有没有 `World: affinity`？

**她说"主人是 0"**
`worlds.affinity.masterId` 没配。插件默认是 0。

**她查错了人**
QQ 号在消息正文里的形状是 `昵称(123456789)`。如果她不认识，把 `ENV_PROMPT.md`
里那句说明写得更直白一点。

**分涨得太快 / 太慢**
调 `gainPerMessage` 和 `dailyGainCap`。
