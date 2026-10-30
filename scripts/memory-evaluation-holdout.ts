import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createMemoryEvaluationHoldoutCorpus,
  createMemoryEvaluationHoldoutPrompts,
} from '../tests/fixtures/memory-evaluation-holdout.ts';

async function runCli(): Promise<void> {
  const [mode] = process.argv.slice(2);
  if (mode === 'cases') {
    for (const prompt of createMemoryEvaluationHoldoutPrompts()) process.stdout.write(`${JSON.stringify(prompt)}\n`);
    return;
  }
  if (mode === '--reveal-corpus') {
    for (const item of createMemoryEvaluationHoldoutCorpus()) process.stdout.write(`${JSON.stringify(item)}\n`);
    return;
  }
  if (mode === '--reveal-gold') {
    const { createMemoryEvaluationHoldoutGold } = await import('../tests/fixtures/memory-evaluation-holdout-gold.ts');
    for (const item of createMemoryEvaluationHoldoutGold()) process.stdout.write(`${JSON.stringify(item)}\n`);
    return;
  }
  process.stderr.write('usage: tsx scripts/memory-evaluation-holdout.ts cases\n');
  process.stderr.write('   or: tsx scripts/memory-evaluation-holdout.ts --reveal-corpus\n');
  process.stderr.write('   or: tsx scripts/memory-evaluation-holdout.ts --reveal-gold\n');
  process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
