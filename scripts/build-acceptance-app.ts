import { randomBytes } from 'node:crypto';

const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const runId = process.env.COOPANION_ACCEPTANCE_RUN_ID || `rev29-${timestamp}-${randomBytes(3).toString('hex')}`;
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId)) throw new Error('COOPANION_ACCEPTANCE_RUN_ID must be a short lowercase identifier');

process.env.COOPANION_CHANNEL = 'acceptance';
process.env.COOPANION_ACCEPTANCE_RUN_ID = runId;
console.info(`Building isolated Coopanion acceptance run ${runId}`);

await import('./stage.ts');
await import('./pack.ts');
