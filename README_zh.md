<!-- README_zh.md shadows package.json. -->

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
    <img src="assets/banner.svg" alt="Coopanion" width="806">
  </picture>
</p>

<p align="center">
  <a href="README.md">English</a> ｜
  简体中文
</p>

<p align="center">
  <a href="https://github.com/suyu5757-lab/coopanion-personal-usage/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/suyu5757-lab/coopanion-personal-usage?color=00a870"></a>
  <a href="https://github.com/suyu5757-lab/coopanion-personal-usage/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/suyu5757-lab/coopanion-personal-usage/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Windows 10 / 11" src="https://img.shields.io/badge/Windows-10%20%2F%2011-1f6feb">
  <img alt="macOS 13+" src="https://img.shields.io/badge/macOS-13%2B-1f6feb">
  <img alt="Linux x64" src="https://img.shields.io/badge/Linux-x64-1f6feb">
  <a href="LICENSE"><img alt="AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-8b8b8f"></a>
</p>

<p align="center">
  <a href="https://coo.palailab.org">官网</a> ｜
  <a href="#安装">安装</a> ｜
  <a href="#快速上手">快速上手</a> ｜
  <a href="#日常使用">日常使用</a> ｜
  <a href="#常见问题">常见问题</a> ｜
  <a href="https://github.com/suyu5757-lab/coopanion-personal-usage/releases">更新记录</a> ｜
  <a href="docs/DEVELOPMENT.md">参与开发</a>
</p>

Coopanion 是一个桌宠。桌宠 **Coo** 待在屏幕底边，可以用气泡和你聊天、听你说话、在底边走动，经你同意后还能操作电脑。支持 Windows、macOS 和 Linux。

**语言**：应用和新手引导有简体中文、繁體中文、English、日本語、한국어、Français、Deutsch、Español (Latinoamérica)、Português (Brasil)、Italiano、Русский 11 种语言。新装时跟随系统语言，系统语言不在其中时用英文；从旧版本升级的保留原来的语言。在「习惯」页的「语言」里修改。Coo 用应用语言和你说话。

![1790222143546](image/README/1790222143546.png)

<p align="center"><img src="image/README/pet-desktop-zh.png" alt="Coo" width="640"></p>

## 功能

- **多家模型**：DeepSeek、通义千问、Kimi、智谱 GLM、豆包、MiniMax、阶跃星辰、百度千帆、OpenRouter、OpenAI、Anthropic、Gemini、xAI。选一家，贴上 API Key 就能用；也可以登录 ChatGPT 账号，使用它的 ChatGPT 套餐。
- **聊天**：按说话键说话，或者打字，Coo 在气泡里回复。语音在本机用 FunASR 或 Whisper 识别，按应用语言选。
- **社交边界**：Coo 的默认运行约定会引导它尊重明确的拒绝联系，翻找他人物品前先征求同意，对电气风险给出谨慎建议，并在需要当前信息时核对来源、不靠猜测作答。仍会继续提供安全、实际的帮助。
- **记忆**：记得聊过的内容，也知道你戳了它、摸了它的头。它对你的了解写在工作区的 `PARTNER.md`，这份文件每次整份读进提示词。Core 模式下，Persona 工作区写入会经过动作授权，记录目标与文件哈希，写后读取核对并保存工作区历史。可在高级设置中将 `companion.workspaceAppendPath` 设为用分号分隔的精确相对路径列表，仅跳过列出文件 `append_file` 的逐次审批；编辑、覆盖、删除、命令和其他路径仍需批准。未决写入会显示在「动作回执」页，同一路径在核对前不能重试。长期写入、来源屏障和删除任务保存在应用私有 SQLite 数据库。首次启动时会导入旧队列和遗忘文件，并保留原文件。明确更正可用 `memory_correct` 关联旧来源，旧记录仍可用于查询历史。个人用户事件只会随时间降低软召回排序；之后的用户消息与其来源匹配度足够高时，可以提高激活权重并从该次消息重新计时。明确遗忘屏障始终优先。被忘记的来源会从历史读取中屏蔽；远端删除和画像重建完成前不提供画像。同一记忆库存在遗忘屏障时，不提供缺少可核验来源的汇总记忆。汇总记忆即使没有父文档，只要声明的全部来源均已核验且未被遗忘，仍可读取。高级模式的 Hindsight 面板分别显示本地排队、远端处理中、操作完成、来源读取核验、未解决失败、删除和来源屏蔽状态。已经进入活动对话的文本无法从该对话中撤回。工作区改动保留版本历史。
  Recall 的主结果与来源事实使用独立预算，可在高级设置中分别限制。召回诊断区分服务端截断、来源校验和上下文省略。单次 Recall 达到期限不会停用后续轮次的记忆读取。
  语义召回缺少必要细节时，Coo 可以用原文短语查找用户发言。该补充路径最多检查 2048 个文档条目、读取 1024 个用户来源，并发读取最多四个。模型最多收到六条、合计 8000 字符的摘录，排除已遗忘来源和当前提问，并标明截断。
- **自我成长**：定期回顾默认关闭；开启且长期记忆可用时，会在安静时回顾并留下带来源的人设提案或体验卡候选。技能候选需关联候选建立后发生的真实任务回执，并由你确认该任务未用于候选来源；只有回执核验完成后才能批准，未知结果不算成功。批准技能不会扩大动作权限。每项候选都要你审核；不会自动修改 Persona 或启用体验卡。
- **操作电脑**：可查看屏幕和窗口。Core 授权的 CUA 输入仅限经过核验的 macOS TextEdit 后台窗口；后台专用模式的窗口列表只显示进程身份核验通过的受支持窗口。每次移动指针、点击、拖拽、滚动、输入文字和按键都要单独批准。整屏输入、切换前台和通过 CUA 操作浏览器均不可用。
- **Codex**：可选的本机执行助手，支持只读复核、后台任务、结果验收、停止与续接；在高级模式 World 页启用并配置允许目录。见 [Codex 模块](packages/cortico-world-codex/README.md)。
- **opencode**：把写代码、修 bug、跑测试这类活交给本机的 opencode。Core 每次只批准一条命令或一次文件写入，核对文件内容并写入统一动作回执；结果未解决时会显示在「动作回执」页，核对前不能重试。opencode 只能在你允许的目录里工作。默认关闭，在高级模式的 World 页启用。
- **自己的时间**：每日 API 费用上限尚未接入，功能默认关闭。开启后，她可以在独立浏览器里探索「习惯」页填写的网页主题；主题留空时不会搜索或打开浏览器。每段最多 20 分钟、80 次浏览器工具调用；浏览器写操作默认关闭，系统内存不足时会暂停后台探索和定期自省。可在「习惯」页关闭或修改主题。
- **视频预览**：用编辑清单和本机素材渲染竖屏 MP4、核验成片，并返回预览首帧；写入 MP4、SRT 或待上传副本前，Core 会针对目标路径和文件摘要请求一次授权，并记录写后核验结果。
- **状态气泡**：想事情、看文件、搜索、写入、操作电脑时，头顶用各不相同的小图标和动画显示在做什么，也会显示文件名；气泡点击穿透。默认开启，可在「习惯」关闭。
- **形象**：Coo，或者 **DeepSeek 大肥鱼**（全动态的鲸鱼娘，八套厂商配色，女仆装、冬装、店员装、工装和睡裙五套服装）。其他形象包在装扮页从 zip 或文件夹导入；按形象 API 2 写的包在之后的版本里照常加载（见[形象包兼容承诺](packages/cortico-world-desktop-pet/README.md#形象包兼容承诺)）。
- **装扮**：Coo 的配色（含灯、杯、铸、心、冬五种「性相」配色）、帽子、耳饰、眼镜、颈饰，以及大小和走动频率。
- **扩展**：在扩展页安装 QQ 机器人、画室、小游戏等 World。

每个版本的改动见 [Releases](https://github.com/suyu5757-lab/coopanion-personal-usage/releases)。

当前功能版：**v0.4.0**。本次个人版仅提供 Apple 芯片 Mac 安装包，其他平台的旧版本见 Releases。完整变更见 [更新日志](CHANGELOG.md) 与 [发布说明](docs/releases/v0.4.0.md)。

## 安装

需要以下系统之一：

- Windows 10 / 11（64 位）
- macOS 13 及以上（Apple 芯片和 Intel 都可以）
- 64 位 Linux 桌面（X11，或 Wayland 下的 XWayland）；语音识别要 glibc 2.32 及以上（Ubuntu 22.04、Debian 12 起）

另外需要一家模型服务的 API Key，按用量付费，见[费用与隐私](#费用与隐私)；或者一个有套餐的 ChatGPT 账号。应用语言是简体中文时引导把 DeepSeek 排在第一，其他语言把 OpenAI 排在第一。安装不需要管理员权限。

### Windows：下载安装包

1. 打开[最新发布](https://github.com/suyu5757-lab/coopanion-personal-usage/releases/latest)，下载 `Coopanion-Setup-版本号.exe`。
2. 双击运行，安装界面跟随系统语言。安装包没有数字签名，Windows 可能弹出「Windows 已保护你的电脑」，点 **更多信息** → **仍要运行**。
3. 选安装位置（默认 `C:\Users\你的用户名\Coopanion`），点安装。装好后自动启动，桌面上有图标。

> [!NOTE]
> 程序和它的数据都在安装目录里，开始菜单里没有它，从桌面图标打开。

### Windows：一行命令

打开 PowerShell，粘贴下面这行并回车：

```powershell
irm https://raw.githubusercontent.com/suyu5757-lab/coopanion-personal-usage/main/installer/install.ps1 | iex
```

它会下载最新的安装包并运行，装完删掉下载的文件。

图形界面安装失败时（杀毒软件可能中途拦下安装），下载的安装包会保留并打印路径。可以用它静默重装：`Coopanion-Setup-版本号.exe /S`，或先把 Coopanion 加进杀毒软件的白名单。

### Windows：便携版

不想安装、要放在移动硬盘里，或者想同时养几只，用便携版：

1. 在[最新发布](https://github.com/suyu5757-lab/coopanion-personal-usage/releases/latest)下载 `Coopanion-版本号-win-x64-portable.zip`，解压到任意文件夹。
2. 运行文件夹里的 `Coopanion.exe`。

便携版的数据在这个文件夹的 `data` 里，除了你打开「开机自动启动」时写的启动项，不往系统里写东西。把整个文件夹复制一份就是另一只，记忆和设置各管各的。同时最多开 5 只（安装版和便携版加在一起），再开时会提示端口都被占用。

便携版不会自动更新，有新版本时设置窗口的版本号下面会出现下载链接。升级时把新版解压到一个新文件夹，再把旧文件夹里的 `data` 整个复制过去。

### macOS

1. 打开[最新发布](https://github.com/suyu5757-lab/coopanion-personal-usage/releases/latest)。Apple 芯片下载 `Coopanion-版本号-mac-arm64.dmg`，Intel 下载 `…-mac-x64.dmg`。
   不确定是哪种：苹果菜单 →「关于本机」，「芯片」一栏写 Apple M 系列就是 Apple 芯片。
2. 双击 dmg，把 Coopanion 拖进「应用程序」。
3. 应用没有 Apple 开发者签名，第一次打开会被拦下：先双击打开一次，在提示里点「完成」；再到「系统设置 → 隐私与安全性」，页面底部点「仍要打开」并输入密码。之后就能正常打开。
4. 图标在屏幕顶部的菜单栏里。程序坞里没有，打开设置窗口时才出现。

> [!NOTE]
> 数据在 `~/Library/Application Support/Coopanion`。第一次用到时系统会分别询问麦克风（语音输入）、输入监控（说话键）、录屏与系统录音和辅助功能（操作电脑）。不想让 Coo 操作电脑，后两项不给即可。改了「输入监控」「辅助功能」「录屏」后要重启 Coopanion。应用没有 Apple 开发者签名,更新后 macOS 不把这几项授权算给新版本:开关开着却提示没有权限时,用「−」把 Coopanion 移出那个列表,再把 `/Applications/Coopanion.app` 加回来并重启。

### Linux

1. 打开[最新发布](https://github.com/suyu5757-lab/coopanion-personal-usage/releases/latest)，下载 `Coopanion-版本号-linux-x64.deb`（Debian / Ubuntu）或 `Coopanion-版本号-linux-x64.AppImage`（其他发行版）。
2. deb：`sudo apt install ./Coopanion-版本号-linux-x64.deb`，然后从应用菜单打开。
   AppImage：`chmod +x Coopanion-*.AppImage` 后运行。Ubuntu 22.04 及以后要先装 `libfuse2`（`sudo apt install libfuse2t64`）。
3. 桌宠是透明置顶窗口，需要桌面开启窗口合成（GNOME、KDE 默认开启）。Wayland 下通过 XWayland 运行。

> [!NOTE]
> 数据在 `~/.config/Coopanion`。托盘图标需要桌面支持状态栏图标（GNOME 要装 AppIndicator 扩展）；没有托盘时右键 Coo 也能进设置。
> 操作电脑要用 `xdotool` 和 `zenity`，deb 会自动安装；Wayland 下截屏还需要 `grim`、`spectacle`、`scrot` 或 ImageMagick 之一。

## 快速上手

1. **启动**：Coo 落到屏幕底边，任务栏（Mac 是菜单栏，Linux 是状态栏）多出一个图标，不弹窗口。
2. **引导**：第一次启动时 Coo 在气泡里带你完成设置，直接在气泡里点选或填写：
   1. 你希望它怎么称呼你，以及你从哪里知道 Coopanion（可以选「不告诉你」；开着匿名使用统计时，回答随统计发出）；
   2. 它的性子：小小的、好奇的 / 黏人的、贪心的 / 靠谱的、干练的 / 活泼的、陪伴的 / 安静的、沉默的，GitHub 版还有 DeepSeek 大肥鱼。点一项，Coo 换上对应的配色、用那种性子说一句；选定的那份成为它的人设，以后由 Coo 自己修改，配色在装扮页更换。人设改过之后重看引导不再出现这一步；
   3. 走动频率：不乱动 / 多待着 / 常走动；
   4. 选模型服务（拿不准就选排第一的那家），贴上 API Key，当场测试连接；
   5. 下载语音识别模型（FunASR 约 230 MB；应用语言是法、德、西、葡、意、俄语时是 Whisper，约 360 MB；从 ModelScope 下载），然后教你怎么说话；
   6. 按钮、菜单和设置在哪，以及人设在设置窗口的「系统提示词」页。

   引导结束后，可以直接和 Coo 商量它的性格、说话方式和称呼，它能自己把人设写进提示词。

   Coo 的人设跟着应用语言，11 种语言都有；其余提示词在简体或繁体中文时是中文，其他语言是英文，简体中文和英文以外的语言还会告诉 Coo 用应用语言和你说话。没改过的人设会随语言换成同一份人设的该语言版，Coo 从下一个 session 起读到；改过的保持原样。

   气泡右上角的 × 可以随时结束引导，之后在设置窗口「开始」页点「使用向导」重来。Key 选了「稍后再填」也没关系，Coo 过一阵会再问；没接通模型时每次跟它说话，它也会先问要不要去接通。
3. **说第一句话**：快速按一下**左 Alt**（Mac 是**左 Option**），紧接着按住，说「你好」，松开发送。第一次会询问麦克风权限，选允许。

<details>
<summary><b>怎么拿到 API Key？</b></summary>

以 DeepSeek 为例：

1. 打开 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys)，注册并登录；
2. 充值（按用量计费）；
3. 「API Keys」→「创建 API key」，复制 `sk-` 开头的字符串，贴进 Coo 的气泡或「开始」页。

其他几家，在气泡或「开始」页选中后点「去 … 申请」。下表按应用语言是简体中文时的顺序排列：

| 服务                   | 申请 Key                                                                                                                                                                         | 默认模型                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| DeepSeek               | [platform.deepseek.com](https://platform.deepseek.com/api_keys)                                                                                                                  | `deepseek-flash`                                                           |
| 通义千问（阿里云百炼） | 国内 [bailian.console.aliyun.com](https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key)，国际 [modelstudio.console.alibabacloud.com](https://modelstudio.console.alibabacloud.com/ap-southeast-1/model/settings/api-key) | `qwen3.8-flash`                                                            |
| Kimi（月之暗面）       | 国内 [platform.kimi.com](https://platform.kimi.com/console/api-keys)，国际 [platform.kimi.ai](https://platform.kimi.ai/console/api-keys)                                          | `kimi-k3`                                                                  |
| 智谱 GLM               | 国内 [bigmodel.cn](https://bigmodel.cn/usercenter/proj-mgmt/apikeys)，国际（Z.ai）[z.ai](https://z.ai/manage-apikey/apikey-list)                                                  | `glm-5.3-flash`（国内平台连不上就换成 `glm-5.3`）                          |
| 豆包（火山方舟）       | [ark.volcengine.com](https://ark.volcengine.com/region:cn-beijing/apikey)                                                                                                        | `doubao-seed-2-1-lite-260915`（要先在方舟控制台「开通管理」里开通）        |
| MiniMax                | 国内 [platform.minimax.cn](https://platform.minimax.cn/user-center/basic-information/interface-key)，国际 [platform.minimax.io](https://platform.minimax.io/user-center/basic-information/interface-key) | `MiniMax-M3`                                                               |
| 阶跃星辰               | [platform.stepfun.com](https://platform.stepfun.com/interface-key)                                                                                                               | `step-3.7-flash`                                                           |
| 阶跃 Step Plan         | [platform.stepfun.com](https://platform.stepfun.com/interface-key)                                                                                                               | `step-5-preview`（扣 Step Plan 套餐额度）                                  |
| 百度千帆               | [console.bce.baidu.com](https://console.bce.baidu.com/iam/#/iam/apikey/list)                                                                                                     | `glm-5.3-flash`                                                            |
| OpenRouter             | [openrouter.ai](https://openrouter.ai/settings/keys)                                                                                                                             | `deepseek/deepseek-v4.1-flash`                                             |
| OpenAI                 | [platform.openai.com](https://platform.openai.com/settings/organization/api-keys)                                                                                                | `gpt-6-luna`                                                               |
| Anthropic              | [platform.claude.com](https://platform.claude.com/settings/keys)                                                                                                                 | `claude-haiku-5-5`                                                         |
| Gemini（Google AI Studio） | [aistudio.google.com](https://aistudio.google.com/apikey)                                                                                                                    | `gemini-3.5-flash-lite`                                                    |
| xAI                    | [console.x.ai](https://console.x.ai/team/default/api-keys)                                                                                                                       | `grok-4.3`                                                                 |

默认模型是每家快、便宜且能看图的一档。要换，在引导里改模型名，或在「开始」页的「模型」框里填。

通义千问、Kimi、智谱 GLM、MiniMax 各有国内和国际两个平台，账号和 Key 不通用。新建连接时，应用语言是简体中文用国内平台，其他语言用国际平台；「开始」页可以切换。豆包、百度千帆、阶跃星辰、阶跃 Step Plan 只收中国大陆账号，简体中文以外的语言把它们收在「更多」里。

拿真实 Key 测过的只有 DeepSeek、Anthropic 和阶跃 Step Plan，其他几家是照文档接入的。连不上请开 issue。

**ChatGPT** 不用 Key：选它，点「使用 ChatGPT 继续」，在打开的浏览器里登录（Sign in with ChatGPT）。Coo 的请求计入这个账号的 ChatGPT 套餐用量，受套餐的用量上限约束，请在 ChatGPT 的设置里留意额度。到了上限，Coo 不再说话，每隔几分钟再试，直到套餐恢复额度。连接先用套餐列出的第一个模型；登录状态存在这个连接的目录里，到期自动续。高级模式「模型」页这个连接的「ChatGPT 账号」一节可以重新登录或退出登录；删除这个连接会先退出登录，这个连接不能复制。

</details>

## 日常使用

### 和 Coo 说话

| 方式       | 怎么做                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 语音       | **快速按一下左 Alt，紧接着按住**（Mac 是左 Option）说话，松开算一句。识别中的文字显示在 Coo 头顶的灰色气泡里，点气泡里的「取消」丢掉这句。                           |
| 打字       | 鼠标停在 Coo 身上，点旁边的气泡按钮。在「习惯」页打开「双击 Coo 打开打字框」后，双击也行。在「习惯」页打开「打字键」后，在任何窗口里按这个键也能打开（默认双击左 Ctrl，按键和按法都可以在那里修改）。 |
| 麦克风按钮 | 鼠标停在 Coo 身上时出现，用来开关语音输入。按键收音时角标显示说话键（默认 `ALT×2`），一直在听时显示 AUTO。正在听时长按，这句话立即发出。           |
| 回答选项   | Coo 给出选项时，点一下或按 1–3；都不合适就在最后一格自己写。                                                                  |

你打的字、说的话和在「对话」页发的消息，都以灰色气泡叠在 Coo 头顶，最新的在最下面：语音的前面有话筒图标，「对话」页发的有双向箭头。Coo 的回复气泡消失 1 秒后它们淡出，Coo 没有回复的 8 秒后淡出；最多留 3 条、合计 6 行，再多时最早的先淡出。点一下气泡可以关掉它。在「习惯」关闭「输入气泡」后不再留下这些气泡，语音只在识别中显示。

说话键、麦克风和收音方式（按住说 / 按一下开关 / 一直听）在「语音输入」页修改。点「说话键」按钮后按下单键、组合键（如 `Ctrl + Space`）或鼠标侧键；旁边选「双击再按住」（默认）或「直接按住」。说话键不可用时不识别说话，「语音输入」页写明原因。蓝牙耳机等一打开麦克风就切到通话模式、放不出声音时，在「语音输入」页开启「按住时才打开麦克风」。

语音在本机识别，录音不上传：应用语言是中、英、日、韩文时用 **FunASR**（SenseVoiceSmall 模型，约 230 MB），法、德、西、葡、意、俄语时用 **Whisper**（small 模型，约 360 MB，一句说完才出字）。模型在引导或「语音输入」页下载一次即可。Windows 上也可以用系统自带的识别，不用下载，准确率低一些。

关闭语音输入也会释放识别模型或停止 Windows 识别进程；再次开启时重新加载引擎。

### 闹钟

可以请 Coo 在当地某个时间或若干分钟后设定闹钟。每日闹钟在夏令时切换后保持原来的当地钟点；如果当天跳过了指定钟点，这一次按跳过的时长顺延，次日恢复原定钟点。应用关闭期间错过的闹钟会在下次启动时送到。

### 和 Coo 互动

- **点一下**是戳它，**在头上来回划**是摸头，**按住拖动**是拎起来，松手可以甩出去。默认戳它会让它回应，摸头和拎起只在下次它说话时一并告诉它。在「习惯」页的「回应模式」里可以改：安静是互动都先记着、和它说话时一起回应，积极是所有互动都回应，自定义…可以勾选哪些互动让它马上回应。
- **表情和动作**：Coo 说话时会配上表情和动作。表情有开心、眨眼、喜欢、害羞、惊讶、生气、难过、犯困、思考、得意、嘟嘴、担心、认真、慌张、害怕、期待（星星眼）、大哭、疑惑；动作有点头、摇头、张望、转身、转圈、跳、坐下、睡觉、招手、鞠躬、发抖、扑腾、甩尾巴、跳舞等。换成大肥鱼时，点头和摇头是真的低头、转脸，招手举起靠近你的那只手，鞠躬时上身往前倾，甩尾巴会把尾鳍高高扬起再拍下来、溅起水花。她还有捂脸偷看、喷水、抱尾巴、游泳、抖水、吹泡泡、飘浮、蹲着画圈、敲屏幕、探头、伸懒腰、装死、拍尾鼓掌和打喷嚏十四个自己的动作。
- **右键**打开菜单：暂停 / 继续、设置、退出，以及打字、语音输入、夜间模式、音效、隐藏、装扮。
- **悬停按钮**：鼠标停在 Coo 身上时旁边的按钮，默认是打字和语音，在「习惯」页最多可选六个。
- **记住位置**：在「习惯」页打开后，下次启动 Coo 回到上次的横向位置。
- **OBS 画面**：在「习惯」页「其他」里打开「导出 OBS 画面」，在 OBS 添加「浏览器」来源，网址填写页面上给出的地址，宽高设为屏幕分辨率。浏览器来源默认每秒 30 帧，要看到 60 帧，在来源属性里勾选「使用自定义帧率」并设为 60。Coo 和气泡在画面里的位置与屏幕上一致，背景透明。
- **多块显示器**：Coo 启动时在主屏。拎到另一块屏幕松手，它就留在那块屏幕上；那块屏幕断开时回到主屏。

### 自己的时间

「自己的时间」默认关闭；每日 API 费用上限尚未接入，可在「习惯」页的「行为与互动」里开启。安静时间默认 20 分钟后开始，每次最多 20 分钟、80 次浏览器工具调用；打开「不限」后仍受调用次数限制。网页主题由你填写，最多 8 行、每行 80 字；主题留空时，在自己的时间里不会搜索或打开浏览器。浏览器窗口和登录状态独立于你的日常浏览器；密码和验证码由你自己输入。窗口默认静音，可以打开「浏览器声音」。看视频时会截取几帧，并用本机语音模型转写同期声音；模型不可用时只处理画面。

她可以打开网页、搜索、播放视频、滚动和读取评论。Browser 的 HTTP/HTTPS 请求经应用内本地代理解析到公网地址，并直接连接经核验的 IP；它不使用 macOS 系统 HTTP/HTTPS 代理。WebSocket 请求和非代理 WebRTC UDP 会被拒绝，依赖这些连接的网站可能只能部分加载。浏览器写操作默认关闭。「常规互动」只控制点赞、收藏、关注、评论、弹幕和分享；每次支持的互动都需通过 Coo 的气泡批准，并绑定当前账号、页面和控件。复制分享链接或选择分享去向也要经过一次批准并留下回执；应用不会读取剪贴板内容。若 DOM 无法定位控件且模型支持图片，`browser_screenshot` 会返回一次性 `captureId`；`browser_click` 只能对该截图中的坐标操作，且实时 DOM 必须同时提供可读标签。每次截图点击都需单独批准，结果在核对前保持未决；发送、发布、分享、复制链接、文件选择、删除、付费、登录和账号修改控件不能走此路径。ChatGPT 网页生图、保存生成图片、素材下载和素材上传各有独立开关，打开其中一项不会自动打开其他权限。每条生图提示词提交前都会展示并要求批准，同时说明可能消耗账号额度或产生费用；同一时间只允许一条未决生图任务。确认提交后会返回一次性任务 ID 和提示词 SHA-256；状态读取只核对该用户消息之后出现的助手图像，结果状态包括 `not_dispatched`、`prompt_submitted`、`generating`、`image_available`、`unknown` 和 `failed`，未知结果不得自动重试。保存图片时先将下载暂存并核验格式、大小和 SHA-256；Core 随后显示准确文件名、大小和哈希，再请求一次确认，确认后才写入素材目录。拒绝保存、浏览器窗口关闭或下次暂存时会清理临时图片。素材下载仅从当前页面选择公开图片或直接视频文件；批准前会显示来源主机、已存在的本机目录、文件名和大小上限。只接受同源重定向的公开 HTTP(S) 文件，核验文件头、类型、大小和 SHA-256 后无覆盖保存；流媒体、网站访问限制和未知结果不自动重试。素材上传前会显示账号、表单、文件路径、大小和 SHA-256，并要求批准；文件只从 `<data>/video/media` 清单选择，且不会发布作品。文字提交会区分页面确认、平台审核、已核实发布和结果未知。未决回执显示在「Persona 与记忆」页；你可以检查目标后记录观察结果，仍不明确时会继续阻止重试。最终发布由你检查表单后亲自点击；购买、充值、打赏、开通会员、私信、修改账号和填写个人信息均被拒绝。ChatGPT 和 Creator Center 的真实页面兼容性尚待在现有正式 Coopanion Browser 中分阶段验收。

系统可用内存低于 20% 时会暂停后台探索和定期自省。高级模式的长期记忆面板显示 Core / 系统内存、磁盘余量，以及全应用当日模型 token 和估算费用；这项用量显示不设每日费用上限。

对于可见的直接 HTTP(S) 生图素材，`browser_download_media` 可接收已核验的 C01 任务 ID，并再次确认所选图像属于该任务对应的助手消息。下载仍需单独通过 C02 的批准、目录选择和文件核验；仅以 `blob:` 形式提供的图像不支持此直接下载路径。

### 视频预览

在高级模式启用 Video World 后，可以让 Coo 使用 `video_list_media`、`video_render` 和 `video_prepare_upload`。Coo 可以列出 `<data>/video/media` 中的图片、视频和音频；`video_render` 从有权使用的素材生成预览，编辑清单列出素材授权、剪辑点、画布、音频和字幕。写入 MP4、SRT 或待上传副本前，Core 会显示目标路径和文件摘要并请求一次批准；共享动作账本记录授权、派发和读回结果。MP4 与可选的同名 SRT 写入 `<data>/video/renders`，待上传副本写入 `<data>/video/media/prepared/<renderId>`，渲染临时文件会清理。FFmpeg 在本机渲染；工具检查尺寸、帧率、时长、编码、像素格式和黑屏，再把元数据与首帧发给模型服务。将字幕绘制到画面需要带 `drawtext` 的 FFmpeg；否则字幕保留在 SRT 里。可在高级模式 Worlds 页的 Video 配置组填写 FFmpeg 与 ffprobe 路径。浏览器上传仍需另一次批准。

### 让 Coo 操作电脑

电脑操作默认关闭。在「习惯」页「电脑操作」一节勾选「让 Coo 操作这台电脑」，读完弹出的风险说明点「打开」，马上生效。你请 Coo 看屏幕或帮忙操作时，它也可能提出打开，并把设置窗口带到这一节。

打开后，「询问时机」控制查看或操作前是否进行通用权限询问。Core 仅接受经过核验的 macOS TextEdit 后台窗口输入；每次移动指针、点击、拖拽、滚动、输入文字和按键都会在 Coo 气泡中显示目标与内容并单独请求批准。整屏输入、切换前台和通过 CUA 操作浏览器不可用。

- 在「习惯」页「电脑操作」一节的「询问时机」里可以改，由严到松四档：
  - `ask-each-turn`：每轮查看屏幕、移动或滚动前询问；
  - `ask-before-acting`：查看屏幕不问，每轮移动或滚动前询问；
  - `ask-once`（默认）：查看屏幕不问，同意后可在「同意有效期」（默认 30 分钟）内移动或滚动；
  - `never-ask`：跳过通用权限询问；每个受支持的后台输入步骤仍需逐次批准。
- 接了几块显示器时，它一次看一块，需要时自己换到别的显示器。
- 安装 [Cua Driver](https://github.com/trycua/cua) 并授予辅助功能和屏幕录制权限后，先用 `pet_cua_window` 选择 TextEdit 窗口，再请求输入。目标窗口保持在后台，Coo 不会移动你的鼠标或抢占键盘焦点；驱动或进程身份不可用时，输入会被阻止。
- `worlds.desktop-pet.cua.backgroundOnly` 可以进一步限制通用 CUA 路径；设为 `false` 不会扩大 Coopanion Core 的 TextEdit 允许范围。
- 登录、密码、付款这类步骤交给你自己做。
- 一次唤醒最多请求模型 40 次，到上限就结束这一轮，要继续就再跟它说。上限在高级模式「Cormini」页修改，重启后生效。

不想让它操作电脑：在「习惯」页「电脑操作」一节取消勾选「让 Coo 操作这台电脑」。

电脑操作配置保存失败时，开关和询问时机会恢复到最近一次保存的值。

### 让 Coo 叫 opencode

先在本机安装并登录 opencode（`opencode auth login`），再在高级模式的 World 页启用 opencode。它的设置在高级模式的 opencode 配置组里：

- `bin`：opencode 可执行文件；在 `PATH` 里时留 `opencode` 就行。
- `workRoots`：允许工作的绝对目录，一行一个，也可以用逗号或分号分隔。没填时它不接任务。
- `askSensitive`：默认打开，写文件、跑命令、取网页和开子任务前都会问；没看清命令时不要关掉。

启用后直接跟 Coo 说要做的事，例如「把这个项目的测试修到通过」。它会先确认目录，把任务交给 opencode，然后继续和你说话；小终端出现在 Coo 旁边，显示开机、工作、等权限、完成和出错。opencode 要写文件或跑命令时，Coo 会在气泡里把原命令和路径给你，选项是允许一次、本次会话总是允许或拒绝；你不回答，任务会自己停下。任务结束后 opencode 先把总结、改过的文件和跑过的命令交给 Coo；Coo 可以看 opencode_review 的完整改动来验收，觉得可以再告诉你，不行就带 resume 让它继续改。一次只跑一个任务；要停就说停。

opencode 用它自己的模型和登录，和 Coo 的模型分开。它不会用 `--auto`，也不会替你批准。任务只在 `workRoots` 里开始。

### 托盘 / 菜单栏

程序常驻后台。关掉设置窗口不会退出；再次打开程序只会把 Coo 叫回来。

托盘图标（Mac 是菜单栏，Linux 是状态栏）的菜单里可以打开设置、显示桌宠、设置开机启动、重启和退出。Windows 上左键单击图标直接打开设置。

重启和退出会等待 Core 停止，超过 12 秒则强制结束，再等待最多 5 秒确认退出。退出时的最后一次统计上报最多等待 5 秒。选择数据文件夹后若保存失败，应用会显示文件系统错误并退出。

## 设置窗口

侧栏按钮可在完整名称和图标导航之间切换，并记住选择。悬停或用键盘聚焦图标可查看名称。Coopanion 字标折叠时，两个 o 移入 C 内，组成 Coo 标志。窄窗口默认折叠；小屏幕上展开侧栏会覆盖页面。

点托盘图标，或右键 Coo 点齿轮，打开设置窗口。默认是**普通模式**，只有和桌宠相关的页面：

| 页面       | 内容                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| 开始       | 连接模型（已连接的模型和可选择的模型服务在同一处）、在桌面上显示或隐藏桌宠、预览桌宠、界面配色与调色盘、重看引导。左栏底部显示「运行中 / 已暂停」，旁边是暂停 / 继续和关机 |
| 习惯       | 分为通用（应用语言、称呼、Coo 的名字、匿名使用统计）、行为与互动（走动、回应模式、自主配置权限、自我成长、自己的时间、悬停按钮、双击打开打字框、打字键、状态气泡、输入气泡）、显示（大小、气泡尺寸、字体尺寸、气泡速度、帧率(60/120/144/不限)、全屏时自动隐藏（Windows）、记住位置）、音效（可按类关闭）、说话声（气泡逐字念成短音节，代替打字音效；音高、语速选档或自定义）、电脑操作（开关、是否允许操作鼠标和键盘、询问时机、同意有效期）、其他（导出 OBS 画面、对话页的上下文圆环，默认关闭）几节 |
| 装扮       | 形象（Coo、DeepSeek 大肥鱼，或装上的形象包）、配色和配件，改动立即生效。形象一行最后的「导入」从 zip 或文件夹安装形象包（一次最多 128 MB），也可以直接拖到页面上。替换已有形象包需要确认。导入的形象包可以卸载：悬停卡片，点右上角的删除按钮并确认，整个包被删除，正在用的换回 Coo |
| 语音输入   | 开关、识别引擎、模型下载、说话键、麦克风、收音方式                                                          |
| 系统提示词 | Coo 的系统提示词，人设在「CONSTITUTION」一段。各段连成一份文档，除 CONSTITUTION 外首次打开时折叠，折叠状态保留到退出软件；模板变量可以插入，也可以预览当前值；高级模式下 World 的段可以跳到这个 World 的配置。Ctrl+S 保存到文件，「撤销全部改动」回到上次保存的内容；「立即应用」保存并更新当前对话的提示词，对话保留；「清空对话并重开」保存后清空当前对话，Memory 和人设保留；「完整提示词预览」展开按现在的文件拼出的整条提示词 |
| 用量与成本 | 每天的 token 用量和花费                                                                                    |
| 对话       | 当前对话的记录，Coo 发的图片也显示在这里；也可以在这里直接和 Coo 说话。在「习惯」页打开「上下文圆环」后，输入框里的圆环显示上下文用量，满时整理之前的对话；鼠标停在上面显示 token 数和上次整理的时间 |

<p align="center"><img src="image/README/habits-zh.png" alt="Habits" width="720"></p>
<p align="center"><img src="image/README/dress-zh.png" alt="Dress up" width="720"></p>

展开侧栏后，左上角显示当前版本。Windows 版和 AppImage 会在后台自动下载新版本，版本下面显示下载到了哪一步；下好后 Coo 会在气泡里问你要不要重启更新，不急的话下次退出时自动装上；下载失败时版本下面会出现手动下载的链接。Mac 版和 deb 在有新版本时，版本下面会出现下载链接，需要手动下载。更新之后，Coo 会告诉你新版本有什么变化；你在这里改了称呼、装扮、走动或电脑操作这些设置，它也会知道并回应。

左栏底部的「**高级模式**」显示全部页面（World、模型、扩展、记忆、控制台与诊断），「回到普通模式」收起。普通模式折叠侧栏时隐藏「高级模式」按钮，展开后显示。

### 换模型

在「开始」页的「连接模型」里选一家服务，填模型名（已有默认值）和 Key 就换过去了。每家（有两个平台的，每个平台）的 Key 分别保存，换回来不用重填。

<p align="center"><img src="image/README/start-zh.png" alt="Start" width="720"></p>

默认是新装时应用语言排第一的那家：简体中文是 DeepSeek 的 `deepseek-flash`，其他语言是 OpenAI 的 `gpt-6-luna`。操作电脑需要模型能看图，各家的默认模型都可以。各平台按它文档里的接口调用：Anthropic 用 Messages API，Gemini 用 Gemini API，百度千帆和智谱国际平台 Z.ai 用 Chat Completions，其余用 Responses API。高级模式的「模型」页还可以：

- 换模型、调整思考档位；
- 新建「OpenAI Responses Compatible」连接，接入其他兼容 Responses API 的服务；
- 为 DeepSeek、OpenAI、Anthropic、Gemini、xAI 以外的服务填写价目，让「用量与成本」页算出花费。

### 装扩展

高级模式的「扩展」页列出 npm 上带 `cortico-world` 关键字的 World，例如：

- QQ 机器人（`cortico-world-qq-better`）
- 画室与你画我猜（`cortico-world-canvas`）
- 植物大战僵尸（`cortico-world-pvz`）
- 杀戮尖塔（`cortico-world-sts-1`）

收录在官方索引（[Pal-AI-Lab/cortico-extensions](https://github.com/Pal-AI-Lab/cortico-extensions)）里的包还显示标签、徽标、投票和评论。投票和评论要用一次性验证码登录 GitHub，登录状态保存在扩展目录里。

安装后点「重启进程」，再到「World 总览」里启用。重装应用不会丢失扩展。

## 费用与隐私

- **费用**：Coopanion 免费。聊天的费用由你选的模型服务按用量收取，可在「用量与成本」页查看（内置价目的有 DeepSeek、OpenAI、Anthropic、Gemini 付费档、xAI）。登录 ChatGPT 时，请求计入 ChatGPT 套餐，不显示费用。
- **发给模型服务的内容**：你说的话、打的字、和 Coo 的互动、操作电脑时的截图，以及视频预览返回的首帧。只发给你配置的那一家；视频文件在本机渲染。
- **留在本机的内容**：API Key 和 ChatGPT 的登录状态、记忆、对话记录、设置、日志。语音在本机识别，只把识别出的文字发出去。
- **桌宠本地服务**：浏览器写请求和 WebSocket 连接必须来自桌宠服务自己的 HTTP 源（含端口）。桌宠窗口通过启动时交给宿主的随机凭据验证身份。
- **匿名使用统计**：发到 `survey.palailab.org`，只有使用次数、时长、设置和随机生成的安装编号，不含对话、截图、Key 和文件。字段见 [docs/TELEMETRY.md](docs/TELEMETRY.md)，可在「习惯」页关闭。
- **其他联网**：向 GitHub 查询新版本（Windows 版和 AppImage 在后台定时查询，Mac 版和 deb 在打开设置窗口时查询）；扩展页访问 npm 与 GitHub 上的官方扩展索引，投票和评论访问 GitHub；下载语音模型时访问 ModelScope（失败时用 Hugging Face）。

## 数据与卸载

| 系统    | 数据位置                                 | 卸载                                                         |
| ------- | ---------------------------------------- | ------------------------------------------------------------ |
| Windows | 安装目录下的 `data`；便携版是它所在文件夹的 `data` | 「设置 → 应用」里卸载；便携版先关掉开机自动启动，再删文件夹 |
| macOS   | `~/Library/Application Support/Coopanion` | 把「应用程序」里的 Coopanion 拖进废纸篓                      |
| Linux   | `~/.config/Coopanion`                     | deb：`sudo apt remove coopanion`；AppImage：删除文件         |

卸载不会删除数据，重装后记忆和设置还在。不再需要时，手动删掉数据目录（Windows 上删整个安装目录）。

Windows 上，程序换了目录（比如重装到别处）、旁边没有数据时，Coopanion 启动时会询问：继承之前使用的数据，还是新建一只。之前使用的数据在哪，记在 `%LOCALAPPDATA%\Coopanion\data-location.json`。

如果 `home/companion/telemetry.json`、`notice.json` 或 `alarms.json` 损坏，应用会将原文件保留为 `.bad` 文件并重建该项状态。闹钟到期时即使保存失败仍会送达，重启后可能再次送达。

数据目录里，`home` 是记忆、对话记录、设置和 API Key，`extensions` 是扩展，`logs` 是日志，`home/models` 是语音模型。

## 常见问题

<details>
<summary><b>桌宠不见了</b></summary>

右键托盘图标 →「显示桌宠」。托盘图标被折叠时，点任务栏右下角的 `^`。也可以再打开一次程序。Mac 上点菜单栏图标 →「显示桌宠」。

</details>

<details>
<summary><b>Coo 不说话 / 没反应</b></summary>

看设置窗口「开始」页标题旁的状态：

- **没有连接模型**：检查 API Key 是否完整、账户是否有余额，再点「测试连接」。通义千问、Kimi、智谱 GLM、MiniMax 的 Key 只在申请它的平台（国内或国际）上能用。豆包要先在方舟控制台开通默认模型。
- **已暂停**：点左栏底部的「继续」。

模型请求连续失败 5 次时，Coo 会在气泡里说出错误原因（如模型名不存在、Key 无效、余额不足），点「打开设置」去改。

</details>

<details>
<summary><b>它听不到我说话</b></summary>

- 确认 Coo 身旁的麦克风按钮没有被划掉；
- 先快速按一下左 Alt，再按住（两下间隔太久不算）；
- 「语音输入」页显示识别服务就绪；提示模型未下载就点「下载」。说话时电平条会跳动；
- Windows：设置 → 隐私和安全性 → 麦克风，允许桌面应用使用麦克风；
- Mac：「系统设置 → 隐私与安全性」里给 Coopanion 打开「麦克风」和「输入监控」，改完重启。

用 Windows 自带引擎时提示「没有语音识别器」，到设置 → 时间和语言 → 语言，给应用语言装上「语音识别」，或者换回 FunASR 或 Whisper。

</details>

<details>
<summary><b>需要走代理</b></summary>

Coopanion 使用系统代理（HTTP 或 HTTPS 代理；SOCKS 代理不生效），按每次请求时的系统设置走：打开或关掉代理软件不用重启 Coopanion,PAC 脚本按网站分别决定。启动 Coopanion 的环境里设置了 `HTTP_PROXY` / `HTTPS_PROXY` 时以环境变量为准。本机通信会自动绕过代理。详见[开发文档](docs/DEVELOPMENT.md)。

</details>

<details>
<summary><b>Linux 上 Coo 走过的地方留下方块残影</b></summary>

Intel 核显（Mesa 的 iris 驱动）开着快速清屏时，透明窗口里会留下旧画面。启动时设置环境变量 `INTEL_DEBUG=nofc` 关掉它，例如 deb 版运行 `INTEL_DEBUG=nofc coopanion`；有独立显卡时改用独显渲染也可以。

</details>

<details>
<summary><b>想看它在想什么</b></summary>

「对话」页有完整的记录。遇到问题时在这一页点「导出诊断」，把诊断包附在 [Issue](https://github.com/suyu5757-lab/coopanion-personal-usage/issues) 里。

</details>

## 反馈与参与

- 问题和建议请提 [Issue](https://github.com/suyu5757-lab/coopanion-personal-usage/issues)，写上系统版本、Coopanion 版本和复现步骤。
- 从源码构建或修改代码见[开发文档](docs/DEVELOPMENT.md)。

## 致谢

Coopanion 用 [Cortico](https://github.com/Pal-AI-Lab/Cortico) 组装：Cortico Core + Cormini Persona + [桌宠 World](packages/cortico-world-desktop-pet)(含电脑操作)。

## 许可

[AGPL-3.0-or-later](LICENSE)，按第 7 条附加许可：允许与 Steam 版加载的 Steamworks API 库链接。0.1.10 及之前发布的版本是 MIT。框架 Cortico 是 MIT，以子模块随附。提 PR 见 [CONTRIBUTING.md](CONTRIBUTING.md)，首次提交需要签[贡献者许可协议](CLA.md)。

DeepSeek 大肥鱼形象（`packages/cortico-world-desktop-pet/web/whale/` 的贴图）不在 AGPL 授权范围内，来源与各家标志的说明见[桌宠 World 的第三方声明](packages/cortico-world-desktop-pet/THIRD_PARTY_NOTICES.md)。随附或运行时下载的第三方组件：Electron（MIT）、Cortico（MIT）、sherpa-onnx（Apache-2.0）、FunASR 的 SenseVoiceSmall 模型（[FunASR 模型开源协议](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE)，用时下载）、OpenAI 的 Whisper small 模型（MIT，用时下载）、koffi（MIT）、jpeg-js（BSD-3-Clause）、pnpm（MIT）；各家模型服务的标志取自 [lobe-icons](https://github.com/lobehub/lobe-icons)（MIT，标志归各自公司所有，只用于标明服务）。
