/** The app's version and channel, set by scripts/stage.ts when it builds the settings window. */
declare const COOPANION_VERSION: string;
declare const COOPANION_CHANNEL: 'github' | 'steam' | 'acceptance';

export const APP_VERSION: string = COOPANION_VERSION;
export const APP_CHANNEL: 'github' | 'steam' | 'acceptance' = COOPANION_CHANNEL;
