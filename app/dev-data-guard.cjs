'use strict';

/**
 * Fail-closed path gate for a source run that opens the settings window on request.
 *
 * `COOPANION_DEV_OPEN_SETTINGS=1` is a development aid, not a production mode. It may only
 * point `CORTICO_COMPANION_DATA` at a fresh directory inside this checkout's `scratch/` tree.
 * The check runs before `app.setPath('userData', DATA)`, so a rejected path never becomes the
 * Electron profile, the Core data root, or a writer.
 *
 * The production root and the run root are compared after `realpath`, so `..`, a symlinked
 * ancestor and a symlinked data directory cannot hide an equivalent production path.
 */

const fs = require('node:fs');
const path = require('node:path');

function requireAbsolute(name, value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is not set`);
  if (!path.isAbsolute(value)) throw new Error(`${name} is not absolute`);
  return path.resolve(value);
}

/** True when `child` is below `parent`, with neither equal to the other. */
function isStrictlyWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** True when `child` is `parent` or below it. */
function isSameOrWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Canonical path for a path that may not exist yet: resolve the nearest existing ancestor,
 * then append the missing tail. Symlinks in the existing part are resolved.
 */
function canonicalLoose(target, fsImpl) {
  let current = path.resolve(target);
  const tail = [];
  for (;;) {
    if (fsImpl.existsSync(current)) {
      const base = fsImpl.realpathSync(current);
      return path.join(base, ...tail);
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error('cannot resolve path');
    tail.unshift(path.basename(current));
    current = parent;
  }
}

/**
 * Validate and, when needed, create the isolated data root.
 *
 * @param {{
 *   dataRoot?: string,
 *   scratchRoot?: string,
 *   appScratch: string,
 *   productionRoot: string,
 *   create?: boolean,
 *   fsImpl?: typeof fs,
 * }} options
 * @returns {{ dataRoot: string, scratchRoot: string, productionRoot: string }}
 */
function assertDevDataRoot(options) {
  const fsImpl = options.fsImpl ?? fs;
  const dataRoot = requireAbsolute('CORTICO_COMPANION_DATA', options.dataRoot);
  const scratchRoot = requireAbsolute('COOPANION_DEV_SETTINGS_SCRATCH', options.scratchRoot);
  const appScratch = requireAbsolute('appScratch', options.appScratch);
  const productionRoot = requireAbsolute('productionRoot', options.productionRoot);

  if (!fsImpl.existsSync(appScratch)) throw new Error('checkout scratch directory does not exist');
  const appScratchCanonical = fsImpl.realpathSync(appScratch);

  if (!fsImpl.existsSync(scratchRoot)) throw new Error('run scratch directory does not exist');
  const scratchCanonical = canonicalLoose(scratchRoot, fsImpl);
  if (!isStrictlyWithin(appScratchCanonical, scratchCanonical)) {
    throw new Error('run scratch directory is not inside this checkout scratch');
  }

  const productionCanonical = canonicalLoose(productionRoot, fsImpl);
  if (isSameOrWithin(productionCanonical, scratchCanonical) || isSameOrWithin(scratchCanonical, productionCanonical)) {
    throw new Error('run scratch directory overlaps the production data root');
  }

  const dataCanonical = canonicalLoose(dataRoot, fsImpl);
  if (isSameOrWithin(productionCanonical, dataCanonical) || isSameOrWithin(dataCanonical, productionCanonical)) {
    throw new Error('data root overlaps the production data root');
  }
  if (!isStrictlyWithin(scratchCanonical, dataCanonical)) {
    throw new Error('data root is not inside this run scratch directory');
  }

  if (!fsImpl.existsSync(dataRoot)) {
    if (options.create === false) throw new Error('data root does not exist');
    fsImpl.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  }

  const stat = fsImpl.statSync(dataRoot);
  if (!stat.isDirectory()) throw new Error('data root is not a directory');

  const finalCanonical = fsImpl.realpathSync(dataRoot);
  if (isSameOrWithin(productionCanonical, finalCanonical) || isSameOrWithin(finalCanonical, productionCanonical)) {
    throw new Error('data root overlaps the production data root');
  }
  if (!isStrictlyWithin(scratchCanonical, finalCanonical)) {
    throw new Error('data root is not inside this run scratch directory');
  }

  return { dataRoot: finalCanonical, scratchRoot: scratchCanonical, productionRoot: productionCanonical };
}

module.exports = { assertDevDataRoot, isStrictlyWithin, isSameOrWithin, canonicalLoose };
