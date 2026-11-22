import type { Translation } from 'cortico/core/language.ts';
import type { CoreText } from './index.ts';

const MAC = process.platform === 'darwin';

const es419: Translation<CoreText> = {
  settings: {
    language: { title: 'Idioma', description: 'La interfaz y 曦 usan este idioma. Se aplica al instante.' },
    telemetry: { title: 'Estadísticas de uso anónimas', description: 'Envía conteos de uso y la configuración, nunca conversaciones, para ayudar a mejorar Coopanion. Los campos se listan en docs/TELEMETRY.md.' },
    contextRing: { title: 'Anillo de contexto', description: 'Muestra en el cuadro de texto de la página Chat un anillo con cuánto falta para ordenar la conversación anterior.' },
    roundsSoft: { title: 'Recordatorio para cerrar', suffix: 'solicitudes', description: 'Tras esta cantidad de solicitudes al modelo en un mismo despertar, se recuerda a 曦 que termine lo que está haciendo y cierre el turno.' },
    roundsHard: { title: 'Solicitudes por despertar', suffix: 'solicitudes', description: 'El máximo de solicitudes al modelo en un despertar; al llegar a él, el turno termina.' },
    workspaceAppendPath: { title: 'Rutas para agregar sin pedir aprobación cada vez', description: 'Una o más rutas relativas exactas en el espacio de trabajo Persona de 曦, separadas por punto y coma. Solo se omite la aprobación por acción al agregar a los archivos listados; editar, sobrescribir, borrar, ejecutar comandos y otras rutas siguen requiriendo aprobación. Déjalo vacío para desactivar.' },
    selfTime: {
      title: 'Tiempo propio',
      description: 'Tras un rato sin conversación, puede abrir su propio navegador y mirar. La ventana y sus sesiones son aparte.',
      after: 'Tras el silencio', afterDescription: 'Recibe tiempo propio tras este tiempo sin conversación.',
      session: 'Como máximo', sessionDescription: 'Un tiempo propio dura como máximo esto; al terminar, el navegador se cierra. Con «Sin límite», no se cierra por tiempo.',
      unlimited: 'Sin límite', unlimitedDescription: 'Activado: el tiempo propio no termina por tiempo, sino cuando ella cierra el navegador.',
      minutes: 'min',
      sound: 'Sonido del navegador', soundDescription: 'Silenciado por defecto. Al activarlo, se oyen los videos que mira.',
      topics: 'Temas web permitidos', topicsDescription: 'Un tema por línea. Déjalo vacío para pausar la exploración web. Cada sesión dura como máximo 20 minutos y 80 llamadas al navegador; las páginas son fuentes externas.',
      actions: 'Permitir acciones sociales', actionsDescription: 'Controla los me gusta, guardados, seguimientos, comentarios, danmaku y compartir. La generación de imágenes, guardar imágenes, descargar medios y subir medios tienen controles independientes abajo.',
      imageGeneration: 'Permitir generar imágenes en la web', imageGenerationDescription: 'Permite enviar indicaciones de imagen desde el sitio web de ChatGPT.',
      imageSaving: 'Permitir guardar imágenes generadas', imageSavingDescription: 'Permite guardar una imagen generada desde la página actual de ChatGPT en la carpeta local de medios.',
      mediaUpload: 'Permitir subir medios', mediaUploadDescription: 'Permite colocar medios aptos en un control de carga; esto no publica la obra.',
      mediaDownload: 'Permitir descargas de medios', mediaDownloadDescription: 'Tras una confirmación única, permite descargar una imagen pública o un video existente seleccionado a una carpeta local que ya exista.',
    },
    growth: {
      autoApply: "Aprobar y aplicar reglas de riesgo bajo o medio automáticamente",
      autoApplyDescription: "La aprobación del Owner aún requiere permiso de escritura",
      title: 'Crecer por su cuenta',
      description: "Aprobar y aplicar reglas de riesgo bajo o medio automáticamente. Pendiente de revisión del Owner: Alto.",
      every: 'Cada', everyDescription: 'Vuelve sobre sí misma después de estos días.',
      days: 'días',
    },
  },

  failure: {
    text: (n: number, status: number, reason: string) => `Mis últimas ${n} solicitudes al modelo fallaron. Error${status ? ` ${status}` : ''}: ${reason}. Revisa el nombre del modelo y la API Key en la página Inicio de la configuración, donde puedes probar la conexión.`,
    reasoningReplay: (n: number) => `Mis últimas ${n} solicitudes al modelo fallaron: este servicio exige que el razonamiento se reenvíe antes de cada llamada a una herramienta, y Coopanion lo tiene desactivado para él. Por favor, repórtalo a los desarrolladores: https://github.com/Pal-AI-Lab/Coopanion/issues`,
    open: 'Abrir configuración',
    ok: 'De acuerdo',
  },

  update: {
    downloading: (v: string) => `Salió la versión ${v} y se está descargando en segundo plano; te aviso cuando esté lista.`,
    ready: (v: string) => `La versión ${v} ya se descargó. ¿Reinicio para actualizar ahora? Si no, se instala la próxima vez que cierres la app.`,
    failed: (v: string, why: string) => `La versión ${v} no se descargó: ${why}. Puedes bajarla tú desde GitHub.`,
    ok: 'De acuerdo', github: 'Descargar de GitHub', install: 'Reiniciar y actualizar', later: 'Más tarde', gotIt: 'Entendido',
    trouble: '¿Algún problema?', githubByHand: 'Descargar de GitHub a mano',
  },

  quit: 'Salir de la app',

  noticeLabel: 'Notificaciones de la app',

  browserSend: {
    question: (account: string, where: string, text: string) => `¿Publicar esto desde la cuenta «${account}» en «${where}»?\n\n${text}\n\nSe envía una sola vez.`,
    yes: 'Publicar',
    no: 'No publicar',
    unresolved: (count: number) => `No se pudo confirmar el envío de ${count} contenido anterior desde su navegador. Revisa su ventana antes de volver a enviar.`,
  },

  browserAction: {
    platformWrite: 'dar me gusta, guardar o seguir', imageGeneration: 'generar una imagen', imageSaving: 'guardar una imagen generada',
    imageGenerationDetails: (prompt: string) => `Se enviará un solo prompt. Esto puede consumir la cuota de la cuenta de ChatGPT o generar cargos.\n\nPrompt:\n${prompt}`,
    imageStaging: 'preparar temporalmente una imagen generada para revisarla',
    imageSaveDetails: (file: string, bytes: number, mime: string, digest: string) => `Archivo: ${file}\nTamaño: ${bytes} bytes\nTipo: ${mime}\nSHA-256: ${digest}\nGuardar en: carpeta local de medios`,
    mediaUpload: 'subir medios',
    mediaDownload: 'descargar medios',
    mediaDownloadDetails: (label: string, mediaType: string, host: string, directory: string, filename: string, maxBytes: number) => `Contenido: ${label} (${mediaType})\nServidor de origen: ${host}\nCarpeta de destino: ${directory}\nNombre de archivo: ${filename}\nTamaño máximo: ${maxBytes} bytes`,
    clipboardWrite: 'copiar el enlace para compartir al portapapeles', externalShare: 'compartir externamente',
    clipboardDetails: (account: string, target: string) => `Cuenta: ${account}\nDestino del enlace: ${target}\nAcción: copiar una vez al portapapeles local`,
    externalShareDetails: (account: string, target: string, destination: string) => `Cuenta: ${account}\nContenido: ${target}\nDestino: ${destination}\nAcción: compartir una vez`,
    question: (action: string, target: string, details: string) => '¿Permites que 曦 realice la acción «' + action + '» en «' + target + '»?\n\n' + details + '\n\nEsto solo se aplica a la página actual y al contenido indicado.',
    yes: 'Permitir una vez', no: 'Cancelar',
  },

  workspaceAction: {
    fileWrite: 'escribir un archivo del espacio de trabajo', commandExecution: 'ejecutar un comando del espacio de trabajo',
    question: (action: string, target: string, details: string) => '¿Permites que 曦 realice la acción «' + action + '» en el espacio de trabajo «' + target + '»?\n\n' + details + '\n\nEsto solo se aplica a la ruta y operación indicadas.',
    yes: 'Permitir una vez', no: 'Cancelar',
    appendFile: 'agregar a un archivo del espacio de trabajo',
    deleteFile: 'eliminar un archivo del espacio de trabajo',
    always: 'Permitir siempre este tipo de escritura de bajo riesgo',
    alwaysScope: (scope: string) => `«Permitir siempre» cubre la creación, el agregado y la actualización automáticos bajo ${scope} para archivos .md/.txt/.json/.jsonl, hasta 64 KiB por archivo y como máximo 200 escrituras / 2 MiB al día. Puedes revocarlo en Ajustes → Memoria → Permisos de escritura.`,
    highRisk: 'Esta operación no es una escritura automática de bajo riesgo, así que no se ofrece «Permitir siempre».',
    pendingTitle: 'Coopanion tiene una escritura pendiente de aprobación',
    pendingBody: (count: number, path: string) => `${count} escritura(s) esperando aprobación, por ejemplo ${path}. Abre Ajustes → Memoria → Permisos de escritura en el espacio de trabajo.`,
  },

  status: {
    read: 'Leyendo', browse: 'Revisando', memory: 'memoria', find: 'Localizando', search: 'Buscando', write: 'Escribiendo', edit: 'Editando', append: 'Agregando a',
    delete: 'Borrando', save: 'Guardando', screen: 'Mirando la pantalla', web: 'En una página web', windows: 'Mirando las ventanas abiertas', rightClick: 'Haciendo clic derecho', doubleClick: 'Haciendo doble clic', click: 'Haciendo clic',
    move: 'Moviendo el mouse', drag: 'Arrastrando', scroll: 'Desplazando', focus: 'Cambiando de ventana', type: 'Tecleando', key: 'Presionando', wait: 'Esperando',
    alarmSet: 'Poniendo una alarma', alarmList: 'Revisando las alarmas', alarmCancel: 'Cancelando una alarma',
    quoted: (text: string) => `“${text}”`,
    seconds: (n: number) => `${n} s`,
    minutesLater: (n: number) => `en ${n} min`,
  },

  scheme: {
    name: (figure: string, preset: string) => `${figure} · ${preset}`,
    note: (figure: string, preset: string) => `Se aplica cuando la mascota cambia a “${preset}” de ${figure}`,
  },

  guide: {
    sources: [['Steam', 'steam'], ['YouTube', 'youtube'], ['Reddit', 'reddit'], ['X', 'x'], ['Instagram', 'instagram'], ['TikTok', 'tiktok'], ['GitHub', 'github'], ['Un amigo', 'friend'], ['En otro lugar', 'other'], ['Prefiero no decirlo', 'skip']],
    hello: '¡Hola! Soy 曦, y ahora vivo en el borde de abajo de tu pantalla. 曦...',
    helloReply: '¡Hola, 曦!',
    askName: '¿Cómo te llamo?',
    nameSend: 'Llámame así',
    gotName: (name: string) => `¡${name}, anotado!`,
    askSource: '¿Dónde supiste de mí?',
    sourceThanks: 'Ah, ya veo. 曦...',
    askPersona: '¿Cómo crees que debería ser...?',
    personas: {
      coo: { label: 'Pequeño y curioso', line: '¿Qué es eso? Déjame echar un vistazo. 曦...' },
      grail: { label: 'Mimoso y glotón', line: '¿Qué estás comiendo? Dame un bocadito. 曦...' },
      forge: { label: 'Confiable y capaz', line: '¿Qué hay que hacer? Déjamelo a mí, no tardo. 曦.' },
      heart: { label: 'Alegre y compañero', line: '¡Ya llegué! Hoy te acompaño todo el día. 曦!' },
      winter: { label: 'Tranquilo y callado', line: '...Mm. 曦.' },
      whale: { label: "曦（xī）", line: "Hola, hermano. Soy Xi. ¿De qué hablamos hoy?" },
    },
    dressHint: { text: 'Los colores se cambian en Vestuario', dress: 'Vestuario' },
    askRoam: '¿La mayor parte del tiempo me quedo en calma o me muevo mucho? Haz clic en una opción para ver qué haría.',
    roam: {
      off: { label: 'Sin moverse', level: 'Bajo', line: 'Entonces me quedo en mi lugar y me muevo cuando me llames.' },
      calm: { label: 'De vez en cuando', level: 'Medio', line: 'Daré un paseo de vez en cuando y la mayor parte del tiempo me quedaré en mi lugar.' },
      free: { label: 'A menudo', level: 'Alto', line: 'Puedo correr por todos lados. ¡曦...!' },
    },
    roamOk: 'Así',
    roamDone: 'Listo, así lo haré.',
    wakeTitle: 'Modo de respuesta',
    askWake: 'Modo de respuesta: cuando me das un toque, me acaricias o me levantas, ¿cuándo debo responder?',
    wake: {
      none: { label: 'Tranquilo', note: 'Los toques quedan anotados y reciben respuesta juntos la próxima vez que hables' },
      poke: { label: 'Predeterminado', note: 'Solo responde cuando das un toque' },
      all: { label: 'Activo', note: 'Responde a todos los toques' },
    },

    askVendor: (first: string) => `Para conversar contigo necesito conectarme a un modelo. ¿Qué servicio uso? Si tienes dudas, elige ${first}.`,
    vendorOk: 'Usar este',
    moreVendors: 'Más…',
    pickModel: (model: string) => `Por defecto usaré ${model}: es barato y puede leer imágenes. Para usar otro modelo, escribe su nombre en su lugar.`,
    modelOk: 'Usar este',
    askKey: (name: string) => `Pega aquí tu API Key de ${name}. Se cobra por uso, así que vigila los tokens.`,
    keySend: 'Conectar',
    keyLink: (name: string) => `¿Aún no tienes API Key? Consíguela en ${name}`,
    keyLater: 'Más tarde',
    connecting: 'Conectando…',
    keyOk: (name: string, model: string) => `¡Conectado a ${name}${model ? ` (${model})` : ''}! Ahora puedo hablar. 曦...`,
    keyFail: (why: string) => `No se conectó: ${why}. ¿La API Key está completa y queda saldo en la cuenta? Intenta pegarla de nuevo.`,
    chatgptAsk: 'Presiona el botón de abajo e inicia sesión en tu cuenta de ChatGPT en el navegador. Lo que digo cuenta para el uso de tu plan de ChatGPT, así que vigila tu cuota.',
    chatgptGo: 'Continuar con ChatGPT',
    chatgptWaiting: 'Termina de iniciar sesión en el navegador. Te espero aquí.',
    chatgptFail: (why: string) => `No se pudo iniciar sesión: ${why}. ¿Lo intentamos de nuevo?`,
    keyAlready: (connection: string) => `Ya hay un modelo conectado (${connection}). Fácil. 曦...`,
    keySkipped: 'No pasa nada; hablaré cuando la agregues. Te lo vuelvo a preguntar más tarde.',

    askModel: (name: string, mb: number) => `Para entender lo que dices, necesito descargar un modelo de reconocimiento de voz (${name}, unos ${mb} MB). ¿Lo descargo ahora?`,
    download: 'Descargar',
    notNow: 'Ahora no',
    downloading: 'Descargando el modelo de voz. 曦...',
    downloaded: '¡Listo! Ahora entiendo lo que dices.',
    downloadFail: (why: string) => `La descarga falló: ${why}. Puedes volver a intentarlo en la página Entrada de voz de la configuración.`,
    modelLater: 'De acuerdo. Con un clic en la página Entrada de voz de la configuración lo descargas más tarde.',
    talk: (hint: string) => `Para hablarme: ${hint}. `,
    talkOff: 'La entrada de voz está desactivada; puedes activarla en la página Entrada de voz de la configuración. ',
    talkType: 'También puedes dejar el puntero sobre mí y hacer clic en el botón de burbuja a mi lado para escribir.',
    gotIt: 'Entendido',
    buttons: 'Deja el puntero sobre mí y aparecen unos botones a mi lado; haz clic derecho sobre mí para abrir el menú, con pausa, configuración y salir.',
    ok: 'De acuerdo',
    persona: 'Cómo soy y cómo hablo está escrito en la página Prompt del sistema de la ventana de configuración. Para cambiarme, edítalo ahí, o simplemente dímelo y lo cambio yo.',
    personaMark: 'Prompt del sistema',
    personaOk: 'Comprendido',
    finish: MAC
      ? '¡Todo listo! Mi ícono también está en la barra de menús; haz clic en él para cambiar la configuración.'
      : process.platform === 'linux'
        ? '¡Todo listo! Para cambiar la configuración, haz clic derecho sobre mí para abrir el menú; si mi ícono está en la bandeja, hacer clic en él también funciona.'
        : '¡Todo listo! Mi ícono también está en la bandeja, abajo a la derecha de la barra de tareas; haz clic en él para cambiar la configuración.',
    go: '¡Vamos!',
    dress: 'Primero vísteme',
    closed: 'Bueno, lo dejamos aquí. Para volver a escuchar mi presentación, abre la configuración y haz clic en “Guía” en la página Inicio.',

    askFirst: 'Todavía no tengo un modelo conectado; podré hablar cuando agregues una API Key. ¿Qué servicio uso?',
    askAgain: 'Sigo sin modelo conectado; agrega una API Key y podré hacerte compañía. ¿Qué servicio uso?',
    askLater: 'Más tarde',
    noModel: 'No hay ningún modelo conectado. ¿Conectamos uno ahora?',
    noModelGo: 'Conectar',
    noModelLater: 'Más tarde',
  },
};

export default es419;
