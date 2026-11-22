import { randomBytes } from 'node:crypto';

const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const runId = process.env.COOPANION_TEST_RUN_ID || `r1-${timestamp}-${randomBytes(3).toString('hex')}`;
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId)) throw new Error('COOPANION_TEST_RUN_ID must be a short lowercase identifier');

process.env.COOPANION_CHANNEL = 'test';
process.env.COOPANION_TEST_RUN_ID = runId;
console.info(`Building isolated Coopanion Test run ${runId}`);

await import('./stage.ts');
await import('./pack.ts');
