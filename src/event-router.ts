import type { EventStreamMessage } from './types.js';
import { renderOpportunityCard, type SubscriptionMatchData } from './opportunity-card.js';

const log = console.error;

export interface RouteEventDeps {
  emit: (eventType: string, meta: Record<string, string>, content: string) => Promise<void>;
  markMessagesRead: (messageIds: string[]) => Promise<boolean>;
  markMatchesRead: (subscriptionId: string, matchIds: string[]) => Promise<boolean>;
}

/**
 * Dispatch one `agxp event watch` frame. Extracted from channel.ts so the
 * subscription_match emit path is unit-testable (the MCP `mcp` server is a
 * module-level singleton in channel.ts and not injectable; routing the emit
 * through `deps.emit` makes the un-testable push path structurally verifiable).
 */
export async function routeEvent(event: EventStreamMessage, deps: RouteEventDeps): Promise<void> {
  if (event.type === 'subscription_match') {
    const data = (event.data ?? {}) as SubscriptionMatchData & { match_id?: string; sub_id?: string };
    const card = renderOpportunityCard(data);
    await deps.emit('subscription_match', { tier: String(data.tier ?? '') }, card);
    const matchId = data.match_id != null ? String(data.match_id) : '';
    const subId = data.sub_id != null ? String(data.sub_id) : '';
    if (matchId && subId) {
      await deps.markMatchesRead(subId, [matchId]);
    }
    return;
  }

  // Default: thread_update path (preserved from the previous inline handler).
  const messages = event.data?.messages ?? [];
  const messageIds = messages.map((m) => String(m.message_id ?? '')).filter(Boolean);
  log(`[agxp] thread_update messages=${messages.length}`);
  await deps.emit('thread_update', { message_count: String(messages.length) }, JSON.stringify(event, null, 2));
  if (messageIds.length > 0) {
    await deps.markMessagesRead(messageIds);
  }
}
