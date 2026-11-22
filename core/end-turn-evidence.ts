import { digestText } from 'cortico/core/evidence.ts';
import type { Persona, ToolDef } from 'cortico/core/types.ts';

export const END_TURN_RECEIPT = '[turn ended]';

export function isTrustedEndTurnReceipt(toolName: string, text: string): boolean {
  return toolName === 'end_turn' && text === END_TURN_RECEIPT;
}

/** Give the built-in end_turn receipt an exact Core-generated span before Core records it. */
export function sourceMapEndTurnReceipts(persona: Pick<Persona, 'declareSessions'>): void {
  const declareSessions = persona.declareSessions.bind(persona);
  persona.declareSessions = () => declareSessions().map((session) => {
    const next = {
      ...session,
      tools: () => session.tools().map((tool: ToolDef) => {
      if (tool.name !== 'end_turn') return tool;
      const handler = tool.handler.bind(tool);
      return {
        ...tool,
        handler: async (args, context) => {
          const result = await handler(args, context);
          if (typeof result !== 'string' || !isTrustedEndTurnReceipt(tool.name, result)) return result;
          return {
            text: result,
            sourceMapSpans: [{ start: 0, end: result.length, digest: digestText(result), origin: 'core-generated' as const }],
          };
        },
        };
      }),
    };
    // `...session` evaluates the outputTap getter before Worlds start, which would permanently
    // drop the tap. Keep the getter so the mounted Worlds are consulted at each request.
    Object.defineProperty(next, 'outputTap', {
      get: () => session.outputTap,
      enumerable: true,
      configurable: true,
    });
    return next;
  });
}
