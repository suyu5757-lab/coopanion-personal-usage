import { lstatSync, readdirSync, realpathSync, type Stats } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

const MEDIA_TYPES: Record<string, 'image' | 'video' | 'audio'> = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image',
  '.mp4': 'video', '.mov': 'video', '.m4v': 'video', '.webm': 'video', '.mkv': 'video',
  '.mp3': 'audio', '.m4a': 'audio', '.wav': 'audio', '.aac': 'audio', '.ogg': 'audio',
};
const MAX_FILES = 200;
const MAX_ENTRIES = 2000;
const MAX_DEPTH = 8;

export interface MediaLibraryEntry {
  path: string;
  type: 'image' | 'video' | 'audio';
  bytes: number;
}

export interface MediaLibrary {
  files: MediaLibraryEntry[];
  truncated: boolean;
}

/** Lists media files without following directory symlinks or leaving the configured media root. */
export function listMedia(mediaDir: string): MediaLibrary {
  let root: string;
  try { root = realpathSync(mediaDir); }
  catch { return { files: [], truncated: false }; }
  const files: MediaLibraryEntry[] = [];
  let visited = 0;
  let truncated = false;
  const walk = (folder: string, depth: number): void => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES || visited >= MAX_ENTRIES) {
      truncated = true;
      return;
    }
    let names: string[];
    try { names = readdirSync(folder).sort((a, b) => a.localeCompare(b, 'en')); }
    catch { return; }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      visited++;
      if (visited > MAX_ENTRIES || files.length >= MAX_FILES) { truncated = true; return; }
      const file = join(folder, name);
      let stats: Stats;
      try { stats = lstatSync(file); }
      catch { continue; }
      if (stats.isSymbolicLink()) continue;
      const kind = MEDIA_TYPES[extname(name).toLowerCase()];
      if (stats.isDirectory()) { walk(file, depth + 1); continue; }
      if (!stats.isFile() || !kind) continue;
      const path = relative(root, file).split(sep).join('/');
      if (!path || path.startsWith('../')) continue;
      files.push({ path, type: kind, bytes: stats.size });
    }
  };
  walk(root, 0);
  return { files, truncated };
}
