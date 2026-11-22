/**
 * Trust identities for the bundled World environment prompts Coopanion itself ships.
 *
 * The digest is the full SHA-256 of the template file inside the application. A deployment
 * override is never trusted, even when its text happens to match a bundled template. Each
 * variable still needs its own provenance: `independentVariables` only preserves the spans a
 * World supplies, and a plain string keeps its non-whitespace text unknown.
 */
import { createHash } from 'node:crypto';
import type { World, WorldEnvPromptVars, WorldEnvPromptValue } from 'cortico/core/types.ts';

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** `vendor/cortico/src/worlds/console/ENV_PROMPT.md` as shipped. */
export const CONSOLE_TRUSTED_TEMPLATE_DIGESTS: readonly string[] = [
  '0037bba0ea659128f6cab069895b49dd8c2630adfa6aca9f34ae4b6901630ac0',
];

/** `core/browser/ENV_PROMPT.md` (zh) and `ENV_PROMPT.en.md` as shipped. */
export const BROWSER_TRUSTED_TEMPLATE_DIGESTS: readonly string[] = [
  '59d64e7c9848094371fbf1a9a9f9dcf95741bff0804b84edef23716a6a1730d6',
  'ee1a84a73c92ef7707477e8bd0bde6e209052f1662bdf54ba72ffb18a4f9ebe1',
];

/** `packages/cortico-world-opencode/src/ENV_PROMPT.md` (zh) and `.en.md` as shipped. */
export const OPENCODE_TRUSTED_TEMPLATE_DIGESTS: readonly string[] = [
  '4f8f3bbc25e6e8283ffc7902e096ade32c8e2fa62aa4ad07949716438e46ee48',
  'e8335991904493c291be07b99f300735fc4ce2a398a874afe5236c66f429de21',
];

/** `packages/cortico-world-codex/ENV_PROMPT.md` (zh) and `.en.md` as shipped. */
export const CODEX_TRUSTED_TEMPLATE_DIGESTS: readonly string[] = [
  '0ef5f2d58ce81cc2bf2135c3ac13075cbe5db50c388eee1cca4a4a3450361f22',
  'd9bb24c935ff4e318c650efbc0a98854c229ad759bf08b45cf20d9a5ce78f34b',
];

/** `cortico-world-streamvoice@0.4.0/src/ENV_PROMPT.md` as installed and reviewed for Voice V5. */
export const STREAMVOICE_TRUSTED_TEMPLATE_DIGESTS: readonly string[] = [
  'ea8497b91eefcf21d7db1e52a21df4e8ab7dc88cf0227e95700585fe2abe86e3',
];

/** The app's trust policy for the Worlds it builds itself. Desktop-pet keeps its package policy. */
export function coopanionWorldPromptTrust(world: World) {
  if (world.id === 'console') {
    return { templateDigests: CONSOLE_TRUSTED_TEMPLATE_DIGESTS, independentVariables: true };
  }
  if (world.id === 'browser') {
    return { templateDigests: BROWSER_TRUSTED_TEMPLATE_DIGESTS, independentVariables: true };
  }
  if (world.id === 'opencode') {
    return { templateDigests: OPENCODE_TRUSTED_TEMPLATE_DIGESTS, independentVariables: true };
  }
  if (world.id === 'codex') {
    return { templateDigests: CODEX_TRUSTED_TEMPLATE_DIGESTS, independentVariables: true };
  }
  if (world.id === 'streamvoice') {
    return { templateDigests: STREAMVOICE_TRUSTED_TEMPLATE_DIGESTS, independentVariables: true };
  }
  return undefined;
}

function internalValue(text: string): WorldEnvPromptValue {
  return {
    text,
    ...(text ? {
      sourceMapSpans: [{ start: 0, end: text.length, digest: sha256(text), origin: 'core-generated' as const }],
    } : {}),
  };
}

function internalValues(vars: WorldEnvPromptVars): WorldEnvPromptVars {
  return Object.fromEntries(Object.entries(vars).map(([key, value]) => [
    key, typeof value === 'string' ? internalValue(value) : value,
  ]));
}

/**
 * The console World lives in Cortico and reports its PIN as a bare string. The PIN comes from the
 * deployment's console config, so it gets its own core-generated span; the template's literals get
 * theirs from the template digest. No other console text is admitted by this wrapper.
 */
/**
 * The opencode and codex Worlds render config values (roots, task minutes) as plain strings.
 * Their templates are trusted above; this wrapper gives each substituted value its own
 * core-generated span, exactly as the console PIN wrapper does. It does not trust any other
 * World text and does not grant a permission.
 */
export function withTrustedWorldVariables(world: World): World {
  const read = world.envPromptVars.bind(world);
  world.envPromptVars = () => {
    const vars = read();
    return vars && typeof (vars as Promise<WorldEnvPromptVars>).then === 'function'
      ? (vars as Promise<WorldEnvPromptVars>).then(internalValues)
      : internalValues(vars as WorldEnvPromptVars);
  };
  return world;
}

export function withTrustedConsoleVariables(world: World): World {
  const read = world.envPromptVars.bind(world);
  world.envPromptVars = () => {
    const vars = read();
    return vars && typeof (vars as Promise<WorldEnvPromptVars>).then === 'function'
      ? (vars as Promise<WorldEnvPromptVars>).then(internalValues)
      : internalValues(vars as WorldEnvPromptVars);
  };
  return world;
}
