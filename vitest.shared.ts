import { fileURLToPath } from 'node:url';

/** `cortico/*` resolves to the vendored Cortico sources, as tsconfig.json says. */
export const CORTICO_ALIAS = [{ find: /^cortico\//, replacement: fileURLToPath(new URL('./vendor/cortico/src/', import.meta.url)) }];

/**
 * Vite keeps the percent escapes of a `file:` URL when it turns a dynamic import into an id, so a
 * checkout whose path contains a space fails to load. Cortico discovers provider modules with
 * `import(pathToFileURL(...))`, which is the import that hits it.
 */
export const decodeFileUrlIds = {
  name: 'decode-file-url-ids',
  enforce: 'pre' as const,
  resolveId(id: string) {
    if (!id.startsWith('/') || !id.includes('%')) return null;
    try {
      return decodeURIComponent(id);
    } catch {
      return null;
    }
  },
};
