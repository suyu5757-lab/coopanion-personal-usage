import type { Translation } from 'cortico/core/language.ts';
import type { CoreText } from './index.ts';

const MAC = process.platform === 'darwin';

const zhHant: Translation<CoreText> = {
  settings: {
    language: { title: '語言', description: '介面和 曦 說話都使用這種語言，修改後立即生效。' },
    telemetry: { title: '匿名使用統計', description: '傳送不含對話內容的使用次數與設定，幫助改進 Coopanion。欄位見 docs/TELEMETRY.md。' },
    contextRing: { title: '上下文圓環', description: '在對話頁輸入框顯示一個圓環，表示離整理之前的對話還有多遠。' },
    roundsSoft: { title: '收尾提醒', suffix: '次', description: '單次喚醒請求模型達到此次數時，提醒 曦 完成目前任務後結束本輪。' },
    roundsHard: { title: '單次喚醒上限', suffix: '次', description: '單次喚醒最多請求模型的次數，達到後結束本輪。' },
    workspaceAppendPath: { title: '免逐次審批的追加路徑', description: '填寫 曦 Persona 工作區內一個或多個精確相對路徑，以分號分隔。僅追加到列出的檔案時免逐次審批；編輯、覆蓋、刪除、命令和其他路徑仍需審批。留空關閉。' },
    selfTime: {
      title: '自己的時間',
      description: '沒聊天一段時間後，她可以自己打開瀏覽器逛逛、看看影片。瀏覽器視窗和登入狀態都是她自己的。',
      after: '安靜多久後', afterDescription: '這段時間沒有聊天後，她會得到一段自己的時間。',
      session: '每次最多', sessionDescription: '一段自己的時間最多持續這麼久，到時瀏覽器自動關上；打開「不限」時不按時間關閉。',
      unlimited: '不限', unlimitedDescription: '打開後，一段自己的時間不會按時長自動結束，她關上瀏覽器才結束。',
      minutes: '分鐘',
      sound: '瀏覽器聲音', soundDescription: '預設靜音。打開後，她看的影片會外放。',
      topics: '允許探索的網頁主題', topicsDescription: '每行填寫一個主題；留白時暫停網頁探索。每段最多 20 分鐘、80 次瀏覽器工具呼叫；網頁始終是外部來源。',
      actions: '允許社群互動', actionsDescription: '控制按讚、收藏、關注、評論、彈幕和分享。圖片生成、圖片儲存、素材下載和上傳由下方獨立設定控制。',
      imageGeneration: '允許網頁生圖', imageGenerationDescription: '允許透過 ChatGPT 網站提交圖片提示詞。',
      imageSaving: '允許儲存生成圖片', imageSavingDescription: '允許將目前 ChatGPT 頁面的生成圖片儲存到本機素材目錄。',
      mediaUpload: '允許素材上傳', mediaUploadDescription: '允許將符合條件的素材放入網頁上傳欄位；這一步不會發布作品。',
      mediaDownload: '允許下載素材', mediaDownloadDescription: '經單次確認後，將所選的公開圖片或現有影片下載到已存在的本機資料夾。',
    },
    growth: {
      autoApply: "自動批准與套用中低風險策略",
      autoApplyDescription: "Owner 批准後仍需目標檔案寫入許可",
      title: '自我成長',
      description: "自動批准與套用中低風險策略. 等待 Owner 審核: 高.",
      every: '每隔', everyDescription: '隔這麼多天回顧一次。',
      days: '天',
    },
  },

  failure: {
    text: (n: number, status: number, reason: string) => `我連續 ${n} 次沒能從模型那裡拿到回覆。錯誤${status ? ` ${status}` : ''}：${reason}。請在設定的「開始」頁檢查模型名稱和 API Key，那裡可以測試連線。`,
    reasoningReplay: (n: number) => `我連續 ${n} 次沒能從模型那裡拿到回覆：這家服務商要求每次呼叫工具前都回傳思考內容，Coopanion 對它關掉了這一項。請把這件事回報給開發者：https://github.com/Pal-AI-Lab/Coopanion/issues`,
    open: '開啟設定',
    ok: '知道了',
  },

  update: {
    downloading: (v: string) => `發現新版本 ${v}，正在背景下載，下載好了我再告訴你。`,
    ready: (v: string) => `新版本 ${v} 下載好了。現在重新啟動更新嗎？不急的話，下次結束應用程式時會自動安裝。`,
    failed: (v: string, why: string) => `新版本 ${v} 沒能下載下來：${why}。可以到 GitHub 手動下載安裝。`,
    ok: '好', github: '前往 GitHub 下載', install: '現在重新啟動更新', later: '下次再說', gotIt: '知道了',
    trouble: '遇到問題？', githubByHand: '前往 GitHub 手動下載',
  },

  quit: '結束應用程式',

  noticeLabel: '應用程式通知',

  browserSend: {
    question: (account: string, where: string, text: string) => `要讓 曦 從帳號「${account}」在「${where}」發布這則內容嗎？\n\n${text}\n\n只傳送這一次。`,
    yes: '傳送',
    no: '不要傳送',
    unresolved: (count: number) => `上次有 ${count} 則內容無法確認有沒有送出去。到她的瀏覽器視窗看一眼，再決定要不要重送。`,
  },

  browserAction: {
    platformWrite: '按讚、收藏或追蹤', imageGeneration: '網頁生圖', imageSaving: '儲存生成圖片',
    imageGenerationDetails: (prompt: string) => `本次提交 1 條提示詞，可能使用 ChatGPT 帳號額度或產生費用。\n\n提示詞：\n${prompt}`,
    imageStaging: '暫存生成圖片並核驗',
    imageSaveDetails: (file: string, bytes: number, mime: string, digest: string) => `檔案：${file}\n大小：${bytes} 位元組\n類型：${mime}\nSHA-256：${digest}\n儲存至：本機素材目錄`,
    mediaUpload: '上傳素材',
    mediaDownload: '下載素材',
    mediaDownloadDetails: (label: string, mediaType: string, host: string, directory: string, filename: string, maxBytes: number) => `素材：${label}（${mediaType === 'image' ? '圖片' : '影片'}）\n來源主機：${host}\n儲存資料夾：${directory}\n檔案名稱：${filename}\n最大大小：${maxBytes} 位元組`,
    clipboardWrite: '複製分享連結到剪貼簿', externalShare: '對外分享',
    clipboardDetails: (account: string, target: string) => `帳號：${account}\n連結目標：${target}\n操作：複製到本機剪貼簿`,
    externalShareDetails: (account: string, target: string, destination: string) => `帳號：${account}\n分享目標：${target}\n去向：${destination}\n操作：分享一次`,
    question: (action: string, target: string, details: string) => '允許 曦 在「' + target + '」執行' + action + '嗎？\n\n' + details + '\n\n僅適用於目前頁面和列出的內容。',
    yes: '允許一次', no: '取消',
  },

  workspaceAction: {
    fileWrite: '寫入工作區檔案', commandExecution: '執行工作區命令',
    question: (action: string, target: string, details: string) => '允許 曦 在工作區「' + target + '」執行' + action + '嗎？\n\n' + details + '\n\n僅適用於這次列出的路徑和操作。',
    yes: '允許一次', no: '取消',
    appendFile: '追加工作區檔案',
    deleteFile: '刪除工作區檔案',
    always: '始終允許此類低風險寫入',
    alwaysScope: (scope: string) => `選擇「始終允許」後，將長期允許 曦 在 ${scope} 內自動建立、追加或更新 .md/.txt/.json/.jsonl 檔案；單檔不超過 64 KiB，每日最多 200 次、合計 2 MiB。可隨時在設定的工作區寫入權限中撤銷。`,
    highRisk: '這項操作不屬於低風險自動寫入，因此不提供「始終允許」。',
    pendingTitle: 'Coopanion 有工作區寫入待批准',
    pendingBody: (count: number, path: string) => `${count} 項工作區寫入等待批准，例如 ${path}。請開啟設定 → 記憶 → 工作區寫入權限處理。`,
  },

  status: {
    read: '在查看', browse: '在翻閱', memory: '記憶', find: '在尋找', search: '在搜尋', write: '在寫入', edit: '在修改', append: '在附加',
    delete: '在刪除', save: '在儲存', screen: '在查看螢幕', web: '在看網頁', windows: '在查看開啟的視窗', rightClick: '在按右鍵', doubleClick: '在點兩下', click: '在點選',
    move: '在移動滑鼠', drag: '在拖曳', scroll: '在捲動', focus: '在切換視窗', type: '在打字', key: '在按鍵', wait: '在等待',
    alarmSet: '在設定鬧鐘', alarmList: '在查看鬧鐘', alarmCancel: '在取消鬧鐘',
    quoted: (text: string) => `「${text}」`,
    seconds: (n: number) => `${n} 秒`,
    minutesLater: (n: number) => `${n} 分鐘後`,
  },

  scheme: {
    name: (figure: string, preset: string) => `${figure} · ${preset}`,
    note: (figure: string, preset: string) => `桌寵換成${figure}的「${preset}」時自動換上`,
  },

  guide: {
    sources: [['Steam', 'steam'], ['YouTube', 'youtube'], ['Reddit', 'reddit'], ['X', 'x'], ['Instagram', 'instagram'], ['TikTok', 'tiktok'], ['GitHub', 'github'], ['朋友推薦', 'friend'], ['其他地方', 'other'], ['不告訴你', 'skip']],
    hello: '你好呀！我是 曦，以後就住在你螢幕的底邊囉，庫...',
    helloReply: '你好，曦！',
    askName: '我該怎麼稱呼你？',
    nameSend: '就這樣叫',
    gotName: (name: string) => `${name}，記住囉！`,
    askSource: '你是從哪裡認識我的？',
    sourceThanks: '原來是這樣，庫...',
    askPersona: '你覺得我應該是...',
    personas: {
      coo: { label: '小小的、好奇的', line: '這是什麼？我湊過去看一眼，庫...' },
      grail: { label: '黏人的、貪心的', line: '你在吃什麼呀？也分我一口嘛，庫...' },
      forge: { label: '可靠的、幹練的', line: '要做什麼？交給我，一下就好，庫。' },
      heart: { label: '活潑的、陪伴的', line: '我來啦！今天也一直陪著你，庫！' },
      winter: { label: '安靜的、沉默的', line: '……嗯，庫。' },
      whale: { label: "曦（xī）", line: "哥，我是曦。今天想先聊什麼？" },
    },
    dressHint: { text: '配色可以在 裝扮 中替換', dress: '裝扮' },
    askRoam: '平常我該安靜一點，還是活潑一點？點一下，看看我會怎樣。',
    roam: {
      off: { label: '不亂動', level: '低', line: '那我就乖乖站著，你叫我我再動。' },
      calm: { label: '多待著', level: '中', line: '我會不時去散步一圈，大多時候待著。' },
      free: { label: '常走動', level: '高', line: '我可以到處跑來跑去，庫...！' },
    },
    roamOk: '就這樣',
    roamDone: '好，就照這個來。',
    wakeTitle: '回應模式',
    askWake: '回應模式：你戳我、摸我、把我拎起來的時候，我什麼時候回應你？',
    wake: {
      none: { label: '安靜', note: '互動先記著，等你說話時一起回應' },
      poke: { label: '預設', note: '只有被戳的時候才回應' },
      all: { label: '積極', note: '所有互動都會回應' },
    },

    askVendor: (first: string) => `要和你聊天，我得先連上模型。用哪一家的？拿不定主意就選 ${first}。`,
    vendorOk: '就用這家',
    moreVendors: '更多…',
    pickModel: (model: string) => `預設用 ${model}，便宜，還能看圖。想用別的模型，改成它的名字就好。`,
    modelOk: '就用這個',
    askKey: (name: string) => `把 ${name} 的 API Key 貼在這裡吧。依用量計費，要留意 token 消耗喔。`,
    keySend: '連線',
    keyLink: (name: string) => `還沒有 Key？到 ${name} 申請`,
    keyLater: '稍後再填',
    connecting: '正在連線…',
    keyOk: (name: string, model: string) => `連上 ${name} 了${model ? `（${model}）` : ''}！現在我能說話囉，庫...`,
    keyFail: (why: string) => `沒連上：${why}。看看 Key 是不是完整，帳戶裡還有沒有餘額？再貼一次試試。`,
    chatgptAsk: '點擊下面的按鈕，在瀏覽器裡登入 ChatGPT 帳號。我說的話會計入你的 ChatGPT 方案用量，記得留意額度喔。',
    chatgptGo: '使用 ChatGPT 繼續',
    chatgptWaiting: '在瀏覽器裡登入好就回來，我在這裡等你。',
    chatgptFail: (why: string) => `沒登入成功：${why}。再試一次吧？`,
    keyAlready: (connection: string) => `模型已經連好了（${connection}），省事，庫...`,
    keySkipped: '沒關係，等你填好我再開口。之後我會再來問你。',

    askModel: (name: string, mb: number) => `要聽懂你說話，我得先下載一個語音辨識模型（${name}，約 ${mb} MB）。現在下載嗎？`,
    download: '下載',
    notNow: '先不用',
    downloading: '正在下載語音模型，庫...',
    downloaded: '下載好了，現在我聽得懂你說話囉！',
    downloadFail: (why: string) => `沒下載下來：${why}。之後可以在設定的「語音輸入」頁再試。`,
    modelLater: '好，之後在設定的「語音輸入」頁一鍵就能下載。',
    talk: (hint: string) => `想和我說話：${hint}。`,
    talkOff: '語音輸入現在關著，可以在設定的「語音輸入」頁開啟。',
    talkType: '也可以把滑鼠停在我身上，點旁邊的氣泡按鈕打字。',
    gotIt: '知道了',
    buttons: '滑鼠停在我身上，旁邊會冒出幾個按鈕；在我身上按右鍵能開啟選單，暫停、設定和結束都在裡面。',
    ok: '好',
    persona: '我是什麼個性、怎麼說話，都寫在設定視窗的「系統提示詞」頁裡。想讓我換個樣子，可以去那裡改；直接告訴我也行，我自己來改。',
    personaMark: '系統提示詞',
    personaOk: '明白了',
    finish: MAC
      ? '都準備好囉！選單列裡也有我的圖示，想改設定點它就好。'
      : process.platform === 'linux'
        ? '都準備好囉！想改設定的話，在我身上按右鍵開啟選單就好；桌面的系統匣裡要是有我的圖示，點它也可以。'
        : '都準備好囉！工作列右下角的系統匣裡也有我的圖示，想改設定點它就好。',
    go: '開始吧',
    dress: '先幫我換身衣服',
    closed: '好，那先到這裡。想再聽我介紹，開啟設定，在「開始」頁點「使用導覽」。',

    askFirst: '我還沒連上模型，填好 API Key 我才能和你說話。用哪一家的？',
    askAgain: '還是沒連上模型呢，填好 API Key 我才能陪你聊天。用哪一家的？',
    askLater: '等一下',
    noModel: '目前沒有連上模型，要去連線嗎？',
    noModelGo: '去連線',
    noModelLater: '等一下',
  },
};

export default zhHant;
