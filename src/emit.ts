/**
 * Channel-notification emitter factory.
 *
 * `emit` is extracted from channel.ts so the MCP notification shape is
 * unit-testable: channel.ts wires the real `mcp.notification` as the `notify`
 * callback, while tests pass a capturing fake. This closes the wiring gap
 * between routeEvent (already tested) and the actual mcp.notification call.
 *
 * Sends `notifications/claude/channel` with a JSON-stringifiable `content`
 * payload plus a flat-string `meta` map (event_type injected from eventType).
 */
export interface EmitterDeps {
  notify: (params: { method: string; params: { content: string; meta: Record<string, string> } }) => Promise<void>;
}

export type ChannelEventType =
  | 'timeline_update'
  | 'thread_update'
  | 'session_required'
  | 'identity_refresh'
  | 'subscription_match';

export function createEmitter(deps: EmitterDeps) {
  return async function emit(
    eventType: ChannelEventType,
    meta: Record<string, string>,
    content: string,
  ): Promise<void> {
    await deps.notify({
      method: 'notifications/claude/channel',
      params: { content, meta: { event_type: eventType, ...meta } },
    });
  };
}
