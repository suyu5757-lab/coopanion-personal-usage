import type { Language } from 'cortico/core/language.ts';

export interface MemoryStorageText {
  hindsightLabel: string;
  hindsightPanelDesc: string;
  hindsightNote: string;
  hindsightStat: (bank: string) => string;
  hindsightCleared: string;
  actionReceiptsLabel: string;
  actionReceiptsPanelDesc: string;
  workspacePermissionLabel: string;
  workspacePermissionPanelDesc: string;
  workspaceFilesLabel: string;
  workspaceFilesNote: string;
}

const zh: MemoryStorageText = {
  hindsightLabel: 'Hindsight 长期记忆',
  hindsightPanelDesc: '长期记忆里的事实、观察和画像；可以搜索，也可以删除。',
  hindsightNote: '删除本机的 Hindsight bank：事实、观察、画像和关系摘要都会被清掉，不能恢复。',
  hindsightStat: (bank) => `bank：${bank}`,
  hindsightCleared: '长期记忆已清除',
  actionReceiptsLabel: '动作回执',
  actionReceiptsPanelDesc: '查看未决动作；核实结果后记录观察，仍不确定时保留未决状态。',
  workspacePermissionLabel: '工作区写入权限',
  workspacePermissionPanelDesc: '查看待处理的工作区写入、管理长期规则，或暂停 Coo 自主维护低风险文件。',
  workspaceFilesLabel: '工作区文件',
  workspaceFilesNote: 'Coo 的工作区文件；它们是任务资料，不是长期记忆，也不作为历史来源。',
};

const zhHant: MemoryStorageText = {
  hindsightLabel: 'Hindsight 長期記憶',
  hindsightPanelDesc: '長期記憶裡的事實、觀察和畫像；可以搜尋，也可以刪除。',
  hindsightNote: '刪除本機的 Hindsight bank：事實、觀察、畫像和關係摘要都會被清掉，不能恢復。',
  hindsightStat: (bank) => `bank：${bank}`,
  hindsightCleared: '長期記憶已清除',
  actionReceiptsLabel: '動作回執',
  actionReceiptsPanelDesc: '查看未解決的動作；核實結果後記錄觀察，仍不確定時保留未解決狀態。',
  workspacePermissionLabel: '工作區寫入權限',
  workspacePermissionPanelDesc: '查看待處理的工作區寫入、管理長期規則，或暫停 Coo 自主維護低風險檔案。',
  workspaceFilesLabel: '工作區檔案',
  workspaceFilesNote: 'Coo 的工作區檔案；它們是任務資料，不是長期記憶，也不作為歷史來源。',
};

const en: MemoryStorageText = {
  hindsightLabel: 'Hindsight long-term memory',
  hindsightPanelDesc: 'Facts, observations and portraits in long-term memory; search them or delete them here.',
  hindsightNote: 'Deletes this machine\'s Hindsight bank: facts, observations, portraits and the relationship summary. This cannot be undone.',
  hindsightStat: (bank) => `bank: ${bank}`,
  hindsightCleared: 'Long-term memory cleared',
  actionReceiptsLabel: 'Action receipts',
  actionReceiptsPanelDesc: 'Review unresolved actions and record what you observed; leave uncertain results unresolved.',
  workspacePermissionLabel: 'Workspace write permissions',
  workspacePermissionPanelDesc: "Review waiting workspace writes, manage lasting rules, or pause Coo's own low-risk file work.",
  workspaceFilesLabel: 'Workspace files',
  workspaceFilesNote: "Coo's workspace files; they are task material, not long-term memory or a historical source.",
};

const ja: MemoryStorageText = {
  hindsightLabel: 'Hindsight 長期記憶',
  hindsightPanelDesc: '長期記憶の事実・観察・ポートレート。検索も削除もここから。',
  hindsightNote: 'この端末の Hindsight bank を削除します。事実、観察、ポートレート、関係の要約が消え、元に戻せません。',
  hindsightStat: (bank) => `bank: ${bank}`,
  hindsightCleared: '長期記憶を削除しました',
  actionReceiptsLabel: '操作レシート',
  actionReceiptsPanelDesc: '未解決の操作を確認し、観察した結果を記録します。不明な場合は未解決のままにします。',
  workspacePermissionLabel: 'ワークスペース書き込みの権限',
  workspacePermissionPanelDesc: '待機中の書き込みを確認し、継続ルールを管理し、低リスクの自動ファイル作業を一時停止します。',
  workspaceFilesLabel: 'ワークスペースのファイル',
  workspaceFilesNote: 'Coo のワークスペースファイル。作業資料であり、長期記憶でも歴史的な出典でもありません。',
};

const ko: MemoryStorageText = {
  hindsightLabel: 'Hindsight 장기 기억',
  hindsightPanelDesc: '장기 기억의 사실, 관찰, 초상입니다. 여기서 검색하거나 삭제할 수 있습니다.',
  hindsightNote: '이 기기의 Hindsight bank를 삭제합니다. 사실, 관찰, 초상, 관계 요약이 사라지며 되돌릴 수 없습니다.',
  hindsightStat: (bank) => `bank: ${bank}`,
  hindsightCleared: '장기 기억을 지웠습니다',
  actionReceiptsLabel: '작업 영수증',
  actionReceiptsPanelDesc: '미해결 작업을 검토하고 관찰한 결과를 기록합니다. 확실하지 않으면 미해결 상태로 둡니다.',
  workspacePermissionLabel: '작업 공간 쓰기 권한',
  workspacePermissionPanelDesc: '대기 중인 쓰기를 확인하고 지속 규칙을 관리하며, 저위험 자동 파일 작업을 일시 중지합니다.',
  workspaceFilesLabel: '작업 공간 파일',
  workspaceFilesNote: 'Coo의 작업 공간 파일입니다. 작업 자료이며 장기 기억이나 역사적 출처가 아닙니다.',
};

const fr: MemoryStorageText = {
  hindsightLabel: 'Mémoire à long terme Hindsight',
  hindsightPanelDesc: 'Faits, observations et portraits de la mémoire à long terme ; recherchez-les ou supprimez-les ici.',
  hindsightNote: 'Supprime la banque Hindsight de cette machine : faits, observations, portrait et résumé de la relation. Action irréversible.',
  hindsightStat: (bank) => `banque : ${bank}`,
  hindsightCleared: 'Mémoire à long terme effacée',
  actionReceiptsLabel: 'Reçus d’action',
  actionReceiptsPanelDesc: 'Examinez les actions non résolues et consignez vos observations ; gardez-les ouvertes si le résultat reste incertain.',
  workspacePermissionLabel: 'Autorisations d’écriture dans l’espace de travail',
  workspacePermissionPanelDesc: 'Examinez les écritures en attente, gérez les règles durables ou suspendez le travail de fichier à faible risque.',
  workspaceFilesLabel: 'Fichiers de l’espace de travail',
  workspaceFilesNote: 'Les fichiers d’espace de travail de Coo ; ce sont des documents de travail, pas la mémoire à long terme ni une source historique.',
};

const de: MemoryStorageText = {
  hindsightLabel: 'Hindsight-Langzeitgedächtnis',
  hindsightPanelDesc: 'Fakten, Beobachtungen und Porträts im Langzeitgedächtnis; hier suchen oder löschen.',
  hindsightNote: 'Löscht die Hindsight-Bank dieses Rechners: Fakten, Beobachtungen, Porträt und Beziehungszusammenfassung. Nicht rückgängig zu machen.',
  hindsightStat: (bank) => `Bank: ${bank}`,
  hindsightCleared: 'Langzeitgedächtnis gelöscht',
  actionReceiptsLabel: 'Aktionsbelege',
  actionReceiptsPanelDesc: 'Prüfe offene Aktionen und halte deine Beobachtung fest. Bei Unsicherheit bleibt der Status offen.',
  workspacePermissionLabel: 'Schreibrechte im Arbeitsbereich',
  workspacePermissionPanelDesc: 'Wartende Schreibvorgänge prüfen, dauerhafte Regeln verwalten oder die risikoarme Dateiarbeit pausieren.',
  workspaceFilesLabel: 'Arbeitsbereichsdateien',
  workspaceFilesNote: 'Coos Arbeitsbereichsdateien; sie sind Arbeitsmaterial, kein Langzeitgedächtnis und keine historische Quelle.',
};

const es419: MemoryStorageText = {
  hindsightLabel: 'Memoria a largo plazo Hindsight',
  hindsightPanelDesc: 'Hechos, observaciones y retratos de la memoria a largo plazo; búscalos o elimínalos aquí.',
  hindsightNote: 'Elimina el banco Hindsight de esta máquina: hechos, observaciones, retrato y resumen de la relación. No se puede deshacer.',
  hindsightStat: (bank) => `banco: ${bank}`,
  hindsightCleared: 'Memoria a largo plazo borrada',
  actionReceiptsLabel: 'Comprobantes de acciones',
  actionReceiptsPanelDesc: 'Revisa las acciones sin resolver y registra lo que observaste; si no es claro, déjalas pendientes.',
  workspacePermissionLabel: 'Permisos de escritura en el espacio de trabajo',
  workspacePermissionPanelDesc: 'Revisa escrituras pendientes, administra reglas duraderas o pausa el trabajo de archivos de bajo riesgo.',
  workspaceFilesLabel: 'Archivos del espacio de trabajo',
  workspaceFilesNote: 'Los archivos del espacio de trabajo de Coo; son material de trabajo, no memoria a largo plazo ni una fuente histórica.',
};

const ptBR: MemoryStorageText = {
  hindsightLabel: 'Memória de longo prazo Hindsight',
  hindsightPanelDesc: 'Fatos, observações e retratos da memória de longo prazo; pesquise ou apague aqui.',
  hindsightNote: 'Apaga o banco Hindsight desta máquina: fatos, observações, retrato e resumo do relacionamento. Não pode ser desfeito.',
  hindsightStat: (bank) => `banco: ${bank}`,
  hindsightCleared: 'Memória de longo prazo apagada',
  actionReceiptsLabel: 'Comprovantes de ações',
  actionReceiptsPanelDesc: 'Revise as ações não resolvidas e registre o que observou; mantenha pendente se o resultado não estiver claro.',
  workspacePermissionLabel: 'Permissões de escrita no espaço de trabalho',
  workspacePermissionPanelDesc: 'Revise escritas pendentes, gerencie regras duradouras ou pause o trabalho de arquivos de baixo risco.',
  workspaceFilesLabel: 'Arquivos do espaço de trabalho',
  workspaceFilesNote: 'Os arquivos do espaço de trabalho do Coo; são material de trabalho, não memória de longo prazo nem fonte histórica.',
};

const it: MemoryStorageText = {
  hindsightLabel: 'Memoria a lungo termine Hindsight',
  hindsightPanelDesc: 'Fatti, osservazioni e ritratti della memoria a lungo termine; cerca o elimina qui.',
  hindsightNote: 'Elimina il bank Hindsight di questa macchina: fatti, osservazioni, ritratto e riepilogo della relazione. Non può essere annullato.',
  hindsightStat: (bank) => `bank: ${bank}`,
  hindsightCleared: 'Memoria a lungo termine cancellata',
  actionReceiptsLabel: 'Ricevute delle azioni',
  actionReceiptsPanelDesc: 'Esamina le azioni irrisolte e registra ciò che hai osservato; lasciale irrisolte se il risultato non è chiaro.',
  workspacePermissionLabel: 'Permessi di scrittura nello spazio di lavoro',
  workspacePermissionPanelDesc: 'Esamina le scritture in attesa, gestisci le regole durature o sospendi il lavoro sui file a basso rischio.',
  workspaceFilesLabel: 'File dell’area di lavoro',
  workspaceFilesNote: 'I file dell’area di lavoro di Coo; sono materiale di lavoro, non memoria a lungo termine né fonte storica.',
};

const ru: MemoryStorageText = {
  hindsightLabel: 'Долговременная память Hindsight',
  hindsightPanelDesc: 'Факты, наблюдения и портреты в долговременной памяти; ищите или удаляйте их здесь.',
  hindsightNote: 'Удаляет банк Hindsight на этом компьютере: факты, наблюдения, портрет и сводку отношений. Отменить нельзя.',
  hindsightStat: (bank) => `банк: ${bank}`,
  hindsightCleared: 'Долговременная память очищена',
  actionReceiptsLabel: 'Квитанции действий',
  actionReceiptsPanelDesc: 'Проверьте нерешённые действия и запишите наблюдения; если результат неясен, оставьте его нерешённым.',
  workspacePermissionLabel: 'Права записи в рабочей области',
  workspacePermissionPanelDesc: 'Проверяйте ожидающие записи, управляйте постоянными правилами или приостанавливайте работу с файлами низкого риска.',
  workspaceFilesLabel: 'Файлы рабочей области',
  workspaceFilesNote: 'Файлы рабочей области Coo; это рабочий материал, а не долговременная память и не исторический источник.',
};

const TEXT: Record<Language, MemoryStorageText> = {
  zh, 'zh-Hant': zhHant, en, ja, ko, fr, de, 'es-419': es419, 'pt-BR': ptBR, it, ru,
};

export function memoryStorageText(language: Language): MemoryStorageText {
  return TEXT[language] ?? en;
}
