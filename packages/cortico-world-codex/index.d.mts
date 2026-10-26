import type { WorldDefinition } from 'cortico/world.ts';
interface CodexConfig { enabled: boolean; bin: string; workRoots: string; taskMinutes: number }
declare const definition: WorldDefinition<CodexConfig>;
export default definition;
