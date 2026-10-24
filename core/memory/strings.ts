import type { Language } from 'cortico/core/language.ts';

export interface MemoryStorageText {
  hindsightLabel: string;
  hindsightPanelDesc: string;
  hindsightNote: string;
  hindsightStat: (bank: string) => string;
  hindsightCleared: string;
}

const zh: MemoryStorageText = {
  hindsightLabel: 'Hindsight 长期记忆',
  hindsightPanelDesc: '长期记忆里的事实、观察和画像；可以搜索，也可以删除。',
  hindsightNote: '删除本机的 Hindsight bank：事实、观察、画像和关系摘要都会被清掉，不能恢复。',
  hindsightStat: (bank) => `bank：${bank}`,
  hindsightCleared: '长期记忆已清除',
};

const zhHant: MemoryStorageText = {
  hindsightLabel: 'Hindsight 長期記憶',
  hindsightPanelDesc: '長期記憶裡的事實、觀察和畫像；可以搜尋，也可以刪除。',
  hindsightNote: '刪除本機的 Hindsight bank：事實、觀察、畫像和關係摘要都會被清掉，不能恢復。',
  hindsightStat: (bank) => `bank：${bank}`,
  hindsightCleared: '長期記憶已清除',
};

const en: MemoryStorageText = {
  hindsightLabel: 'Hindsight long-term memory',
  hindsightPanelDesc: 'Facts, observations and portraits in long-term memory; search them or delete them here.',
  hindsightNote: 'Deletes this machine\'s Hindsight bank: facts, observations, portraits and the relationship summary. This cannot be undone.',
  hindsightStat: (bank) => `bank: ${bank}`,
  hindsightCleared: 'Long-term memory cleared',
};

const ja: MemoryStorageText = {
  hindsightLabel: 'Hindsight 長期記憶',
  hindsightPanelDesc: '長期記憶の事実・観察・ポートレート。検索も削除もここから。',
  hindsightNote: 'この端末の Hindsight bank を削除します。事実、観察、ポートレート、関係の要約が消え、元に戻せません。',
  hindsightStat: (bank) => `bank: ${bank}`,
  hindsightCleared: '長期記憶を削除しました',
};

const ko: MemoryStorageText = {
  hindsightLabel: 'Hindsight 장기 기억',
  hindsightPanelDesc: '장기 기억의 사실, 관찰, 초상입니다. 여기서 검색하거나 삭제할 수 있습니다.',
  hindsightNote: '이 기기의 Hindsight bank를 삭제합니다. 사실, 관찰, 초상, 관계 요약이 사라지며 되돌릴 수 없습니다.',
  hindsightStat: (bank) => `bank: ${bank}`,
  hindsightCleared: '장기 기억을 지웠습니다',
};

const fr: MemoryStorageText = {
  hindsightLabel: 'Mémoire à long terme Hindsight',
  hindsightPanelDesc: 'Faits, observations et portraits de la mémoire à long terme ; recherchez-les ou supprimez-les ici.',
  hindsightNote: 'Supprime la banque Hindsight de cette machine : faits, observations, portrait et résumé de la relation. Action irréversible.',
  hindsightStat: (bank) => `banque : ${bank}`,
  hindsightCleared: 'Mémoire à long terme effacée',
};

const de: MemoryStorageText = {
  hindsightLabel: 'Hindsight-Langzeitgedächtnis',
  hindsightPanelDesc: 'Fakten, Beobachtungen und Porträts im Langzeitgedächtnis; hier suchen oder löschen.',
  hindsightNote: 'Löscht die Hindsight-Bank dieses Rechners: Fakten, Beobachtungen, Porträt und Beziehungszusammenfassung. Nicht rückgängig zu machen.',
  hindsightStat: (bank) => `Bank: ${bank}`,
  hindsightCleared: 'Langzeitgedächtnis gelöscht',
};

const es419: MemoryStorageText = {
  hindsightLabel: 'Memoria a largo plazo Hindsight',
  hindsightPanelDesc: 'Hechos, observaciones y retratos de la memoria a largo plazo; búscalos o elimínalos aquí.',
  hindsightNote: 'Elimina el banco Hindsight de esta máquina: hechos, observaciones, retrato y resumen de la relación. No se puede deshacer.',
  hindsightStat: (bank) => `banco: ${bank}`,
  hindsightCleared: 'Memoria a largo plazo borrada',
};

const ptBR: MemoryStorageText = {
  hindsightLabel: 'Memória de longo prazo Hindsight',
  hindsightPanelDesc: 'Fatos, observações e retratos da memória de longo prazo; pesquise ou apague aqui.',
  hindsightNote: 'Apaga o banco Hindsight desta máquina: fatos, observações, retrato e resumo do relacionamento. Não pode ser desfeito.',
  hindsightStat: (bank) => `banco: ${bank}`,
  hindsightCleared: 'Memória de longo prazo apagada',
};

const it: MemoryStorageText = {
  hindsightLabel: 'Memoria a lungo termine Hindsight',
  hindsightPanelDesc: 'Fatti, osservazioni e ritratti della memoria a lungo termine; cerca o elimina qui.',
  hindsightNote: 'Elimina il bank Hindsight di questa macchina: fatti, osservazioni, ritratto e riepilogo della relazione. Non può essere annullato.',
  hindsightStat: (bank) => `bank: ${bank}`,
  hindsightCleared: 'Memoria a lungo termine cancellata',
};

const ru: MemoryStorageText = {
  hindsightLabel: 'Долговременная память Hindsight',
  hindsightPanelDesc: 'Факты, наблюдения и портреты в долговременной памяти; ищите или удаляйте их здесь.',
  hindsightNote: 'Удаляет банк Hindsight на этом компьютере: факты, наблюдения, портрет и сводку отношений. Отменить нельзя.',
  hindsightStat: (bank) => `банк: ${bank}`,
  hindsightCleared: 'Долговременная память очищена',
};

const TEXT: Record<Language, MemoryStorageText> = {
  zh, 'zh-Hant': zhHant, en, ja, ko, fr, de, 'es-419': es419, 'pt-BR': ptBR, it, ru,
};

export function memoryStorageText(language: Language): MemoryStorageText {
  return TEXT[language] ?? en;
}
