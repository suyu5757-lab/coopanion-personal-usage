import type { Translation } from 'cortico/core/language.ts';
import type { CoreText } from './index.ts';

const MAC = process.platform === 'darwin';

const de: Translation<CoreText> = {
  settings: {
    language: { title: 'Sprache', description: 'Die Oberfläche und Coo verwenden diese Sprache. Gilt sofort.' },
    telemetry: { title: 'Anonyme Nutzungsstatistik', description: 'Sendet Nutzungszahlen und Einstellungen, nie Unterhaltungen, um Coopanion zu verbessern. Die Felder stehen in docs/TELEMETRY.md.' },
    contextRing: { title: 'Kontextring', description: 'Zeigt im Eingabefeld der Chat-Seite einen Ring, wie weit es noch ist, bis das frühere Gespräch aufgeräumt wird.' },
    roundsSoft: { title: 'Abschluss-Erinnerung', suffix: 'Anfragen', description: 'Nach so vielen Modellanfragen in einem Aufwachen wird Coo erinnert, das Laufende abzuschließen und die Runde zu beenden.' },
    roundsHard: { title: 'Anfragen pro Aufwachen', suffix: 'Anfragen', description: 'Höchstzahl der Modellanfragen in einem Aufwachen; ist sie erreicht, endet die Runde.' },
    selfTime: {
      title: 'Zeit für sich',
      description: 'Nach einer Weile ohne Gespräch darf sie ihren eigenen Browser öffnen und sich umsehen. Fenster und Anmeldungen sind getrennt.',
      after: 'Nach Ruhe', afterDescription: 'Nach so langer Ruhe bekommt sie Zeit für sich.',
      session: 'Höchstens', sessionDescription: 'Eine Auszeit dauert höchstens so lange; danach schließt sich der Browser. Mit „Unbegrenzt“ schließt er nicht nach Zeit.',
      unlimited: 'Unbegrenzt', unlimitedDescription: 'Ein: Eine Auszeit endet nicht nach Zeit, sondern wenn sie den Browser schließt.',
      minutes: 'Min.',
      sound: 'Browser-Ton', soundDescription: 'Standardmäßig stumm. Eingeschaltet hört man die Videos, die sie ansieht.',
      topics: 'Erlaubte Web-Themen', topicsDescription: 'Ein Thema pro Zeile. Leer lassen, um die Web-Erkundung zu pausieren. Pro Sitzung höchstens 20 Minuten und 80 Browser-Aufrufe; Webseiten bleiben externe Quellen.',
      actions: 'Soziale Aktionen erlauben', actionsDescription: 'Steuert Likes, Favoriten, Folgen, Kommentare, Danmaku und Teilen. Ausgeschaltete Aktionen bleiben gesperrt; Bildgenerierung, Speichern und Uploads haben eigene Schalter unten.',
      imageGeneration: 'Bilder im Web generieren', imageGenerationDescription: 'Erlaubt das Absenden von Bildprompts über die ChatGPT-Website.',
      imageSaving: 'Generierte Bilder speichern', imageSavingDescription: 'Erlaubt, ein generiertes Bild von der aktuellen ChatGPT-Seite im lokalen Medienordner zu speichern.',
      mediaUpload: 'Medien hochladen', mediaUploadDescription: 'Erlaubt geeignete Mediendateien in ein Upload-Feld zu legen; der Beitrag wird dadurch nicht veröffentlicht.',
    },
    growth: {
      title: 'Selbst wachsen',
      description: 'Regelmäßige Rückblicke sind standardmäßig ausgeschaltet. Wenn du sie aktivierst und Langzeitgedächtnis verfügbar ist, kann ein ruhiger Rückblick quellenbasierte Persona-Vorschläge oder Erfahrungskarten hinterlassen. Du prüfst jeden Vorschlag; Persona wird nicht geändert und keine Karte automatisch aktiviert.',
      every: 'Alle', everyDescription: 'Nach so vielen Tagen blickt sie auf sich zurück.',
      days: 'Tage',
    },
  },

  failure: {
    text: (n: number, status: number, reason: string) => `Meine letzten ${n} Anfragen an das Modell sind fehlgeschlagen. Fehler${status ? ` ${status}` : ''}: ${reason}. Prüf den Modellnamen und den API Key auf der Seite Start in den Einstellungen; dort kannst du die Verbindung testen.`,
    reasoningReplay: (n: number) => `Meine letzten ${n} Anfragen an das Modell sind fehlgeschlagen: Dieser Dienst verlangt, dass das Nachdenken vor jedem Werkzeugaufruf zurückgeschickt wird, und Coopanion hat das für ihn ausgeschaltet. Bitte melde das den Entwicklern: https://github.com/Pal-AI-Lab/Coopanion/issues`,
    open: 'Einstellungen öffnen',
    ok: 'OK',
  },

  update: {
    downloading: (v: string) => `Version ${v} ist da und wird im Hintergrund heruntergeladen; ich sag dir Bescheid, wenn sie bereit ist.`,
    ready: (v: string) => `Version ${v} ist heruntergeladen. Jetzt neu starten und aktualisieren? Sonst wird sie installiert, wenn du die App das nächste Mal beendest.`,
    failed: (v: string, why: string) => `Version ${v} wurde nicht heruntergeladen: ${why}. Du kannst sie selbst von GitHub holen.`,
    ok: 'OK', github: 'Von GitHub herunterladen', install: 'Neu starten und aktualisieren', later: 'Später', gotIt: 'OK',
    trouble: 'Probleme?', githubByHand: 'Manuell von GitHub herunterladen',
  },

  quit: 'App beenden',

  noticeLabel: 'App-Benachrichtigungen',

  browserSend: {
    question: (account: string, where: string, text: string) => `Diesen Inhalt vom Konto „${account}“ in „${where}“ veröffentlichen?\n\n${text}\n\nEr wird nur einmal gesendet.`,
    yes: 'Senden',
    no: 'Nicht senden',
    unresolved: (count: number) => `Bei ${count} früheren Inhalten aus ihrem Browser ließ sich der Versand nicht bestätigen. Prüfe ihr Browserfenster, bevor du erneut sendest.`,
  },

  browserAction: {
    platformWrite: 'liken, favorisieren oder folgen', imageGeneration: 'ein Bild erzeugen', imageSaving: 'ein erzeugtes Bild speichern',
    imageStaging: 'ein erzeugtes Bild vorübergehend zur Prüfung ablegen',
    imageSaveDetails: (file: string, bytes: number, mime: string, digest: string) => `Datei: ${file}\nGröße: ${bytes} Byte\nTyp: ${mime}\nSHA-256: ${digest}\nSpeicherort: lokaler Medienordner`,
    mediaUpload: 'Medien hochladen',
    clipboardWrite: 'Freigabelink in die Zwischenablage kopieren', externalShare: 'extern teilen',
    clipboardDetails: (account: string, target: string) => `Konto: ${account}\nLinkziel: ${target}\nAktion: einmal in die lokale Zwischenablage kopieren`,
    externalShareDetails: (account: string, target: string, destination: string) => `Konto: ${account}\nFreigabeziel: ${target}\nZiel: ${destination}\nAktion: einmal extern teilen`,
    question: (action: string, target: string, details: string) => 'Darf Coo einmal ' + action + ' auf „' + target + '“?\n\n' + details + '\n\nDas gilt nur für die aktuelle Seite und die aufgeführten Inhalte.',
    yes: 'Einmal erlauben', no: 'Abbrechen',
  },

  workspaceAction: {
    fileWrite: 'eine Workspace-Datei schreiben', commandExecution: 'einen Workspace-Befehl ausführen',
    question: (action: string, target: string, details: string) => 'Darf Coo einmal ' + action + ' im Workspace „' + target + '“?\n\n' + details + '\n\nDas gilt nur für den aufgeführten Pfad und Vorgang.',
    yes: 'Einmal erlauben', no: 'Abbrechen',
  },

  status: {
    read: 'Liest', browse: 'Stöbert', memory: 'Gedächtnis', find: 'Sucht', search: 'Durchsucht', write: 'Schreibt', edit: 'Bearbeitet', append: 'Ergänzt',
    delete: 'Löscht', save: 'Speichert', screen: 'Schaut auf den Bildschirm', web: 'Auf einer Webseite', windows: 'Schaut auf die offenen Fenster', rightClick: 'Rechtsklickt', doubleClick: 'Doppelklickt', click: 'Klickt',
    move: 'Bewegt die Maus', drag: 'Zieht', scroll: 'Scrollt', focus: 'Wechselt das Fenster', type: 'Tippt', key: 'Drückt', wait: 'Wartet',
    alarmSet: 'Stellt einen Wecker', alarmList: 'Prüft die Wecker', alarmCancel: 'Löscht einen Wecker',
    quoted: (text: string) => `„${text}“`,
    seconds: (n: number) => `${n} s`,
    minutesLater: (n: number) => `in ${n} Min.`,
  },

  scheme: {
    name: (figure: string, preset: string) => `${figure} · ${preset}`,
    note: (figure: string, preset: string) => `Wird angelegt, wenn das Haustier zu „${preset}“ von ${figure} wechselt`,
  },

  guide: {
    sources: [['Steam', 'steam'], ['YouTube', 'youtube'], ['Reddit', 'reddit'], ['X', 'x'], ['Instagram', 'instagram'], ['TikTok', 'tiktok'], ['GitHub', 'github'], ['Freunde', 'friend'], ['Woanders', 'other'], ['Sag ich lieber nicht', 'skip']],
    hello: 'Hi! Ich bin Coo und wohne jetzt unten am Rand deines Bildschirms. Coo...',
    helloReply: 'Hi, Coo!',
    askName: 'Wie soll ich dich nennen?',
    nameSend: 'Nenn mich so',
    gotName: (name: string) => `${name}, gemerkt!`,
    askSource: 'Wie hast du von mir erfahren?',
    sourceThanks: 'Ach so. Coo...',
    askPersona: 'Was meinst du, wie soll ich sein...',
    personas: {
      coo: { label: 'Klein und neugierig', line: 'Was ist das? Ich schau mal nach. Coo...' },
      grail: { label: 'Anhänglich und gierig', line: 'Was isst du da? Gib mir auch einen Bissen. Coo...' },
      forge: { label: 'Zuverlässig und tüchtig', line: "Was gibt's zu tun? Überlass das mir, dauert nicht lange. Coo." },
      heart: { label: 'Lebhaft und immer da', line: 'Da bin ich! Ich leiste dir den ganzen Tag Gesellschaft. Coo!' },
      winter: { label: 'Still und wortkarg', line: '...Mm. Coo.' },
      whale: { label: 'DeepSeek Chan', line: 'Hmpf, da bist du ja. ...I-ich habe nicht auf dich gewartet oder so. Coo...' },
    },
    dressHint: { text: 'Die Farben kannst du unter Outfit ändern', dress: 'Outfit' },
    askRoam: 'Soll ich meistens ruhig oder lebhaft sein? Klick eine Karte an, um zu sehen, was ich dann mache.',
    roam: {
      off: { label: 'Bleibt stehen', level: 'Niedrig', line: 'Dann bleibe ich stehen und bewege mich, wenn du mich rufst.' },
      calm: { label: 'Ab und zu', level: 'Mittel', line: 'Ich mache ab und zu einen Spaziergang und bleibe meistens, wo ich bin.' },
      free: { label: 'Oft', level: 'Hoch', line: 'Ich kann überall herumflitzen. Coo...!' },
    },
    roamOk: 'So',
    roamDone: 'Okay, so mache ich es.',
    wakeTitle: 'Reaktionsmodus',
    askWake: 'Reaktionsmodus: Wenn du mich anstupst, streichelst oder hochhebst, wann soll ich reagieren?',
    wake: {
      none: { label: 'Ruhig', note: 'Berührungen werden gemerkt und gesammelt beantwortet, wenn du das nächste Mal etwas sagst' },
      poke: { label: 'Standard', note: 'Reagiert nur, wenn du Coo anstupst' },
      all: { label: 'Aktiv', note: 'Reagiert auf jede Berührung' },
    },

    askVendor: (first: string) => `Um mit dir zu chatten, muss ich mich mit einem Modell verbinden. Welchen Dienst soll ich nutzen? Wenn du unsicher bist, nimm ${first}.`,
    vendorOk: 'Diesen nehmen',
    moreVendors: 'Mehr…',
    pickModel: (model: string) => `Standardmäßig nehme ich ${model}: Es ist günstig und kann Bilder lesen. Für ein anderes Modell gib stattdessen seinen Namen ein.`,
    modelOk: 'Dieses nehmen',
    askKey: (name: string) => `Füg hier deinen API Key für ${name} ein. Abgerechnet wird nach Nutzung, also behalte die Tokens im Blick.`,
    keySend: 'Verbinden',
    keyLink: (name: string) => `Noch keinen Schlüssel? Hol dir einen bei ${name}`,
    keyLater: 'Später',
    connecting: 'Verbinde…',
    keyOk: (name: string, model: string) => `Mit ${name} verbunden${model ? ` (${model})` : ''}! Jetzt kann ich reden. Coo...`,
    keyFail: (why: string) => `Das hat nicht geklappt: ${why}. Ist der Schlüssel vollständig, und ist auf dem Konto noch Guthaben? Füg ihn noch einmal ein.`,
    chatgptAsk: 'Drück unten auf den Knopf und melde dich im Browser bei deinem ChatGPT-Konto an. Was ich sage, zählt zur Nutzung deines ChatGPT-Tarifs, also behalte dein Kontingent im Blick.',
    chatgptGo: 'Weiter mit ChatGPT',
    chatgptWaiting: 'Schließ die Anmeldung im Browser ab. Ich warte hier.',
    chatgptFail: (why: string) => `Die Anmeldung hat nicht geklappt: ${why}. Noch einmal versuchen?`,
    keyAlready: (connection: string) => `Ein Modell ist schon verbunden (${connection}). Ganz einfach. Coo...`,
    keySkipped: 'Kein Problem; ich rede, sobald du ihn eingetragen hast. Ich frage später noch mal.',

    askModel: (name: string, mb: number) => `Um zu verstehen, was du sagst, muss ich ein Spracherkennungsmodell herunterladen (${name}, etwa ${mb} MB). Jetzt herunterladen?`,
    download: 'Herunterladen',
    notNow: 'Jetzt nicht',
    downloading: 'Lade das Sprachmodell herunter. Coo...',
    downloaded: 'Fertig! Jetzt verstehe ich, was du sagst.',
    downloadFail: (why: string) => `Der Download ist fehlgeschlagen: ${why}. Du kannst es auf der Seite Spracheingabe in den Einstellungen noch einmal versuchen.`,
    modelLater: 'Okay. Mit einem Klick auf der Seite Spracheingabe in den Einstellungen lädst du es später herunter.',
    talk: (hint: string) => `So redest du mit mir: ${hint}. `,
    talkOff: 'Die Spracheingabe ist gerade aus; du kannst sie auf der Seite Spracheingabe in den Einstellungen einschalten. ',
    talkType: 'Du kannst auch mit dem Mauszeiger auf mir bleiben und auf die Sprechblasen-Schaltfläche neben mir klicken, um zu tippen.',
    gotIt: 'Verstanden',
    buttons: 'Bleib mit dem Mauszeiger auf mir, dann erscheinen ein paar Schaltflächen neben mir; ein Rechtsklick auf mich öffnet das Menü mit Pause, Einstellungen und Beenden.',
    ok: 'OK',
    persona: 'Wie ich bin und wie ich rede, steht auf der Seite System-Prompt im Einstellungsfenster. Um mich zu ändern, bearbeite es dort, oder sag es mir einfach, dann ändere ich es selbst.',
    personaMark: 'System-Prompt',
    personaOk: 'Alles klar',
    finish: MAC
      ? 'Alles bereit! Mein Symbol ist auch in der Menüleiste; klick darauf, um Einstellungen zu ändern.'
      : process.platform === 'linux'
        ? 'Alles bereit! Um Einstellungen zu ändern, öffne mit einem Rechtsklick auf mich das Menü; wenn mein Symbol im Infobereich ist, geht auch ein Klick darauf.'
        : 'Alles bereit! Mein Symbol ist auch im Infobereich unten rechts in der Taskleiste; klick darauf, um Einstellungen zu ändern.',
    go: 'Los geht’s',
    dress: 'Zieh mich erst um',
    closed: 'Okay, hören wir hier auf. Um meine Einführung noch mal zu hören, öffne die Einstellungen und klick auf der Seite Start auf „Einführung“.',

    askFirst: 'Ich bin noch mit keinem Modell verbunden; sobald du einen API Key einträgst, kann ich reden. Welchen Dienst soll ich nutzen?',
    askAgain: 'Immer noch kein Modell verbunden; trag einen API Key ein, dann kann ich dir Gesellschaft leisten. Welchen Dienst soll ich nutzen?',
    askLater: 'Später',
    noModel: 'Kein Modell verbunden. Jetzt eins verbinden?',
    noModelGo: 'Verbinden',
    noModelLater: 'Später',
  },
};

export default de;
