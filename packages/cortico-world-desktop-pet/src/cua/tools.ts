/**
 * Tool declarations; `Cua.tools()` binds the handlers. Coordinates are pixels of the latest screenshot,
 * on the display it shows.
 * Descriptions are English whatever the model-text language.
 */
import type { ToolDef } from 'cortico/core/types.ts';

const shot = { type: 'boolean', description: 'Attach a screenshot afterwards; defaults to the configuration (attach). Leave it out only for a step whose result you do not need to see; after a step that may open a window or dialog, look before typing.' };
const xy = {
  x: { type: 'integer', minimum: 0, description: 'Horizontal position, in pixels of the latest screenshot' },
  y: { type: 'integer', minimum: 0, description: 'Vertical position, in pixels of the latest screenshot' },
};

/** While computer use is off: the way to its switch. */
export const CUA_OFF_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'pet_cua_open_settings',
    tags: ['act'],
    description: 'Computer use is off. Open the settings window at its switch, where the person reads what turning it on risks and can turn it on. Only after the person has agreed to open it.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

export const CUA_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'pet_cua_screenshot',
    tags: ['read', 'snapshot'],
    description: 'Capture one display, or the window selected with pet_cua_window. Returns the scaled image, its size and where it came from; later coordinates are pixels of this screenshot. Passing `display` leaves a window target and captures that display.',
    parameters: {
      type: 'object',
      properties: { display: { type: 'integer', minimum: 1, description: 'Display number, 1 = leftmost; omitted: the display looked at last, at first the one holding the foreground window' } },
      required: [],
    },
  },
  {
    name: 'pet_cua_zoom',
    tags: ['read', 'snapshot'],
    description: 'Capture a region of the latest screenshot\'s display again at full resolution, for small text or icons the scaled screenshot blurs. The region is given in screenshot pixels; the zoomed image is for reading only.',
    parameters: {
      type: 'object',
      properties: {
        ...xy,
        width: { type: 'integer', minimum: 1, description: 'Width in screenshot pixels' },
        height: { type: 'integer', minimum: 1, description: 'Height in screenshot pixels' },
      },
      required: ['x', 'y', 'width', 'height'],
    },
  },
  {
    name: 'pet_cua_click',
    tags: ['act'],
    description: 'In a supported native background window, click at (x, y) in its latest screenshot, or pass an elementToken from its latest pet_cua_accessibility result. Provide coordinates or an elementToken, not both. Core confirms the exact target and click before dispatch.',
    parameters: {
      type: 'object',
      properties: {
        ...xy,
        elementToken: { type: 'string', minLength: 1, description: 'A pressable element token from the latest pet_cua_accessibility result for the selected background window' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left' },
        clicks: { type: 'integer', minimum: 1, maximum: 3, description: '1 single click (default), 2 double click, 3 triple click' },
        screenshot: shot,
      },
      required: [],
    },
  },
  {
    name: 'pet_cua_move',
    tags: ['act'],
    description: 'In a supported native background window, move the pointer to (x, y) without clicking. Core confirms the exact target and movement before dispatch.',
    parameters: { type: 'object', properties: { ...xy, screenshot: shot }, required: ['x', 'y'] },
  },
  {
    name: 'pet_cua_drag',
    tags: ['act'],
    description: 'In a supported native background window, hold the left button down, drag from `from` to `to`, and release. Both points are pixels of the latest window screenshot. Core confirms this exact target and drag before dispatch.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2, description: '[x, y] start' },
        to: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2, description: '[x, y] end' },
        screenshot: shot,
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'pet_cua_scroll',
    tags: ['act'],
    description: 'In a supported native background window, scroll at (x, y). Positive down scrolls down, negative up; positive right scrolls right. Units are wheel notches. Core confirms the exact target and scroll before dispatch.',
    parameters: {
      type: 'object',
      properties: {
        ...xy,
        down: { type: 'integer', minimum: -30, maximum: 30 },
        right: { type: 'integer', minimum: -30, maximum: 30 },
        screenshot: shot,
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'pet_cua_type',
    tags: ['act'],
    description: 'In a supported native background window, type the supplied text; \\n presses Enter once. Core confirms the exact target and text before dispatch.',
    parameters: { type: 'object', properties: { text: { type: 'string', maxLength: 2000 }, screenshot: shot }, required: ['text'] },
  },
  {
    name: 'pet_cua_key',
    tags: ['act'],
    description: 'In a supported native background window, press one or more keys. Join keys pressed together with +, and separate keys pressed one after another with spaces: "ctrl+s", "ctrl+a delete", "enter". Core confirms the exact target and keys before dispatch.',
    parameters: { type: 'object', properties: { keys: { type: 'string' }, screenshot: shot }, required: ['keys'] },
  },
  {
    name: 'pet_cua_windows',
    tags: ['read'],
    description: 'List the visible top-level windows: title, which display each is on (with its position in screenshot coordinates when that is the display of the latest screenshot), whether minimized, and which one is in the foreground. Pass a handle to pet_cua_window to work in it in the background.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'pet_cua_window',
    tags: ['read', 'snapshot'],
    description: 'Capture one background window and make later pet_cua_* coordinates refer to its screenshot. The window is not raised; the person\'s pointer and keyboard focus stay where they are. window is a handle from pet_cua_windows, or part of its title. Requires Cua Driver and a supported native app for input. Use pet_cua_accessibility to read pressable elements. Foreground switching is unavailable.',
    parameters: { type: 'object', properties: { window: { type: 'string' } }, required: ['window'] },
  },
  {
    name: 'pet_cua_accessibility',
    tags: ['read', 'snapshot'],
    description: 'Read pressable accessibility elements in the selected background window. Returns elementToken values bound to the latest window snapshot; pass one to pet_cua_click. If the tree is partial, retry with query or a larger maxElements before relying on a missing target. Labels are observations and do not grant permission.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 120, description: 'Narrow the accessibility walk to a visible label or role substring and its ancestors.' },
        maxElements: { type: 'integer', minimum: 1, maximum: 2000, description: 'Raise the accessibility walk cap when the current tree is truncated.' },
      },
      required: [],
    },
  },
  {
    name: 'pet_cua_focus',
    tags: ['act'],
    description: 'Foreground switching is unavailable through Core-authorized computer use. Use only a supported background native window; this tool refuses to raise a window.',
    parameters: { type: 'object', properties: { window: { type: 'string' }, screenshot: shot }, required: ['window'] },
  },
  {
    name: 'pet_cua_wait',
    tags: ['read'],
    description: 'Wait a number of seconds (30 at most) for the screen to load, then take a screenshot. Waiting needs no permission from the person; while looking at the screen is not yet allowed this turn, it waits without a screenshot.',
    parameters: { type: 'object', properties: { seconds: { type: 'number', minimum: 0, maximum: 30 } }, required: ['seconds'] },
  },
];
