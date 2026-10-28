export interface CuaNativeTarget {
  bundleId: string;
  executablePath: string;
  route: string;
  source: string;
}

/** The first supported target is TextEdit; unknown applications and browser bundles stay closed. */
export function isSupportedCuaTarget(target: CuaNativeTarget): boolean {
  return target.source === 'cua-driver'
    && (target.route === 'background-ax' || target.route === 'background-window-pixel')
    && target.bundleId === 'com.apple.TextEdit'
    && target.executablePath === '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit';
}
