#!/usr/bin/env tsx
/**
 * Read-only snapshot utility for external (non-git) Coopanion runtime patches:
 *  1. ~/Library/Application Support/Coopanion/tts/mlx/worker.py (+ model symlink target)
 *  2. ~/Library/Application Support/Coopanion/extensions/node_modules/cortico-world-streamvoice/src/*.ts
 *
 * Writes files + SHA-256 MANIFEST.json + RESTORE.md into the target directory
 * without modifying any running service or model weights.
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

interface SnapshotEntry {
  group: 'tts-mlx' | 'streamvoice';
  snapshotPath: string;
  sourcePath: string;
  bytes: number;
  sha256: string;
}

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

const home = homedir();
const appSupport = join(home, 'Library', 'Application Support', 'Coopanion');
const defaultOutDir = join(
  home,
  'Coopanion',
  'Coopanion_Rev25_并行A_五领域评测准备_20261104',
  '08_handoff',
  'external-runtime-snapshot-v1.0',
);
const outDir = resolve(process.argv[2] || defaultOutDir);

const entries: SnapshotEntry[] = [];
const warnings: string[] = [];

function captureFile(group: SnapshotEntry['group'], src: string, relDest: string): void {
  if (!existsSync(src)) {
    warnings.push(`missing source file: ${src}`);
    return;
  }
  const dest = join(outDir, relDest);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  entries.push({
    group,
    snapshotPath: relDest,
    sourcePath: src,
    bytes: statSync(dest).size,
    sha256: sha256(dest),
  });
}

// 1. E12 MLX TTS Worker + model symlink record
const mlxDir = join(appSupport, 'tts', 'mlx');
captureFile('tts-mlx', join(mlxDir, 'worker.py'), 'tts-mlx/worker.py');

let modelSymlinkTarget: string | null = null;
const modelLink = join(mlxDir, 'model');
try {
  if (lstatSync(modelLink).isSymbolicLink()) {
    modelSymlinkTarget = readlinkSync(modelLink);
  }
} catch {
  warnings.push(`model symlink not found at ${modelLink}`);
}

// 2. Patched cortico-world-streamvoice extension source files (excluding *.bak-*)
const svLink = join(appSupport, 'extensions', 'node_modules', 'cortico-world-streamvoice');
let svRealDir: string | null = null;
if (existsSync(svLink)) {
  svRealDir = realpathSync(svLink);
  for (const topFile of ['package.json', 'describe.json']) {
    captureFile('streamvoice', join(svRealDir, topFile), `streamvoice/${topFile}`);
  }
  const svSrc = join(svRealDir, 'src');
  if (existsSync(svSrc)) {
    const walk = (dir: string): void => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        if (item.name.includes('.bak-') || item.name.startsWith('.')) continue;
        const full = join(dir, item.name);
        if (item.isDirectory()) {
          walk(full);
        } else if (item.isFile()) {
          const rel = relative(svRealDir!, full);
          captureFile('streamvoice', full, `streamvoice/${rel}`);
        }
      }
    };
    walk(svSrc);
  }
} else {
  warnings.push(`streamvoice extension not found at ${svLink}`);
}

const manifest = {
  version: '1.0.0-xi',
  createdAt: new Date().toISOString(),
  appSupportDir: appSupport,
  ttsModelSymlink: {
    link: modelLink,
    target: modelSymlinkTarget,
  },
  streamvoiceRealDir: svRealDir,
  fileCount: entries.length,
  warnings,
  files: entries,
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const restoreDoc = `# Coopanion「曦」v1.0 外部运行态快照与恢复说明

- **生成时间**：${manifest.createdAt}
- **快照文件数**：${entries.length}
- **E12 MLX 模型软链目标**：\`${modelSymlinkTarget ?? '未检测到'}\`
- **StreamVoice 实路径**：\`${svRealDir ?? '未检测到'}\`

## 恢复步骤（仅当重装或更新覆盖了外部补丁时执行）

1. **恢复 E12 TTS Worker**：
   \`\`\`bash
   cp "${join(outDir, 'tts-mlx/worker.py')}" "${join(mlxDir, 'worker.py')}"
   \`\`\`
   确认模型软链指向 E12 8-bit 权重：
   \`\`\`bash
   ln -sfn "${modelSymlinkTarget ?? '<E12_MODEL_DIR>'}" "${modelLink}"
   \`\`\`

2. **恢复 StreamVoice 补丁文件**：
   \`\`\`bash
   SV_DIR="$(realpath "${svLink}")"
   cp -R "${join(outDir, 'streamvoice/src/')}" "$SV_DIR/src/"
   \`\`\`

3. **校验 SHA-256**：对照本目录 \`MANIFEST.json\` 中的 \`sha256\` 字段核对恢复文件一致性，然后重启 \`/Applications/Coopanion.app\`。
`;

writeFileSync(join(outDir, 'RESTORE.md'), restoreDoc, 'utf8');

console.log(JSON.stringify({
  ok: true,
  outDir,
  fileCount: entries.length,
  modelSymlinkTarget,
  warnings,
}, null, 2));
