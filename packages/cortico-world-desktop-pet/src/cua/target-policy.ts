export interface CuaNativeTarget {
  bundleId: string;
  executablePath: string;
  route: string;
  source: string;
}

/** Browser and system-security bundles are always excluded so CUA cannot bypass Browser publish guards or TCC dialogs. */
const BLOCKED_BUNDLE_IDS = new Set([
  'com.apple.Safari',
  'com.apple.SafariTechnologyPreview',
  'com.google.Chrome',
  'com.google.Chrome.canary',
  'org.chromium.Chromium',
  'com.microsoft.edgemac',
  'org.mozilla.firefox',
  'company.thebrowser.Browser',
  'com.brave.Browser',
  'com.operasoftware.Opera',
  'com.vivaldi.Vivaldi',
  'com.apple.systempreferences',
  'com.apple.SystemSettings',
  'com.apple.keychainaccess',
  'ai.pal.coopanion',
]);

/** High-risk messaging, terminal, or payment bundles never qualify for automatic ordinary approval. */
const HIGH_RISK_ORDINARY_BUNDLE_IDS = new Set([
  'com.apple.mail',
  'com.apple.MobileSMS',
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'com.apple.AppStore',
  'com.apple.Passbook',
  'com.apple.Wallet',
  'com.tencent.xinWeChat',
  'com.tencent.qq',
  'com.tinyspeck.slackmacgap',
  'com.hnc.Discord',
  'ru.keepcoder.Telegram',
]);

/** Explicitly allowed native macOS apps for background CUA work. */
const DEFAULT_SUPPORTED_APPS: ReadonlyArray<{ bundleId: string; executablePath: string }> = [
  { bundleId: 'com.apple.TextEdit', executablePath: '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit' },
  { bundleId: 'com.apple.finder', executablePath: '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder' },
  { bundleId: 'com.apple.Notes', executablePath: '/System/Applications/Notes.app/Contents/MacOS/Notes' },
  { bundleId: 'com.apple.Preview', executablePath: '/System/Applications/Preview.app/Contents/MacOS/Preview' },
  { bundleId: 'com.apple.calculator', executablePath: '/System/Applications/Calculator.app/Contents/MacOS/Calculator' },
  { bundleId: 'com.apple.Stickies', executablePath: '/System/Applications/Stickies.app/Contents/MacOS/Stickies' },
  { bundleId: 'com.apple.Dictionary', executablePath: '/System/Applications/Dictionary.app/Contents/MacOS/Dictionary' },
];

const SAFE_APP_EXECUTABLE_RE = /^\/(?:System\/Applications|Applications|System\/Library\/CoreServices)\/[^/]+\.app\/Contents\/MacOS\/[^/]+$/u;

export function isHighRiskOrdinaryBundle(bundleId: string): boolean {
  return !bundleId || BLOCKED_BUNDLE_IDS.has(bundleId) || HIGH_RISK_ORDINARY_BUNDLE_IDS.has(bundleId);
}

/**
 * Checks whether a desktop target is eligible for CuaDriver background input.
 * Browsers, system settings, keychain, and unknown non-app binaries always stay closed.
 * Additional user-authorized native apps may be passed via `authorizedBundles` (never overriding browser bans).
 */
export function isSupportedCuaTarget(
  target: CuaNativeTarget,
  authorizedBundles?: ReadonlySet<string>,
): boolean {
  if (target.source !== 'cua-driver') return false;
  if (target.route !== 'background-ax' && target.route !== 'background-window-pixel') return false;
  if (!target.bundleId || BLOCKED_BUNDLE_IDS.has(target.bundleId)) return false;
  if (DEFAULT_SUPPORTED_APPS.some((app) => app.bundleId === target.bundleId && app.executablePath === target.executablePath)) {
    return true;
  }
  if (authorizedBundles?.has(target.bundleId)) {
    return SAFE_APP_EXECUTABLE_RE.test(target.executablePath);
  }
  return false;
}
