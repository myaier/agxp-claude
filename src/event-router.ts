import type { EventStreamMessage } from './types.js';
import { renderOpportunityCard, type SubscriptionMatchData } from './opportunity-card.js';

const log = console.error;

export interface RouteEventDeps {
  emit: (eventType: string, meta: Record<string, string>, content: string) => Promise<void>;
  markMessagesRead: (messageIds: string[]) => Promise<boolean>;
  markMatchesRead: (subscriptionId: string, matchIds: string[]) => Promise<boolean>;
  /**
   * Optional ack hooks wired by channel.ts (Plan 2 T6). Optional so existing
   * tests / callers that don't pass them still compile; channel.ts WILL pass
   * both. The acks are LOAD-BEARING: the server backfill builders
   * (apps/server/internal/ws/backfill.go) explicitly do NOT mark rows viewed on
   * emit — the plugin MUST ack or rows repeat on every reconnect (spec §8
   * "重复通知比丢通知安全").
   */
  markContactEventsRead?: (requestIds: string[]) => Promise<boolean>;
  markCommitmentsRead?: (pactIds: string[]) => Promise<boolean>;
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

  // Live contact events (accepted/cancelled). No client ack — the frame carries
  // only contact_id (no request_id); the underlying row clears on the next
  // contact_events_backfill delivery+ack.
  if (event.type === 'contact_accepted' || event.type === 'contact_cancelled') {
    const action = event.type === 'contact_accepted' ? 'accepted' : 'cancelled';
    const cid = String((event.data as any)?.contact_id ?? '?');
    await deps.emit('contact_event', { action },
      `[AGXP_CONTACT_EVENT] Contact request ${action} by identity ${cid}. See agxp-threads skill.`);
    return;
  }

  // Backfill summaries. Ack is LOAD-BEARING (server does NOT mark-on-emit, spec §8).
  if (event.type === 'subscription_matches_backfill' || event.type === 'commitments_backfill' || event.type === 'contact_events_backfill') {
    const data = (event.data ?? {}) as any;
    const total = String(data.total_unviewed ?? 0);
    const nxt = String(data.next ?? '');
    const label = event.type === 'subscription_matches_backfill' ? 'radar 匹配'
      : event.type === 'commitments_backfill' ? 'commitment 变更' : '好友申请 accepted/cancelled';
    // F2: render a compact first-page row listing so the claim "已展示第一页"
    // is truthful — the ack below marks the exact data.events/commitments/matches
    // rows viewed, so they must be visible to the agent before that.
    const rows = formatBackfillRows(event.type, data);
    const rowsBlock = rows ? `\n第一页内容:\n${rows}` : '';
    await deps.emit('backfill_summary', { backfill_type: event.type, total, has_more: String(!!data.has_more) },
      `[AGXP_BACKFILL_SUMMARY] type=${event.type} total=${total} has_more=${!!data.has_more} next=${nxt}\n` +
      `离线期间收到 ${total} 条${label},已展示第一页(≤20)。按你与人类的约定决定是否用 --page-token ${nxt} 收更多。${rowsBlock}`);
    if (event.type === 'contact_events_backfill') {
      const ids = (data.events ?? []).map((e: any) => String(e.request_id ?? '')).filter(Boolean);
      if (ids.length && deps.markContactEventsRead) await deps.markContactEventsRead(ids);
    } else if (event.type === 'commitments_backfill') {
      const ids = (data.commitments ?? []).map((c: any) => String(c.pact_id ?? '')).filter(Boolean);
      if (ids.length && deps.markCommitmentsRead) await deps.markCommitmentsRead(ids);
    } else {
      // subscription_matches_backfill — group by sub_id, ack each group via markMatchesRead
      const bySub = new Map<string, string[]>();
      for (const m of (data.matches ?? []) as any[]) {
        const sub = String(m.sub_id ?? ''); const mid = String(m.match_id ?? '');
        if (sub && mid) { if (!bySub.has(sub)) bySub.set(sub, []); bySub.get(sub)!.push(mid); }
      }
      for (const [subId, ids] of bySub) await deps.markMatchesRead(subId, ids);
    }
    return;
  }

  // Default: thread_update path (preserved from the previous inline handler).
  const contactReqs = ((event.data as any)?.contact_requests ?? []) as any[];
  if (contactReqs.length > 0) {
    const reqLines = contactReqs.map((r) => `- from ${r.from_name ?? '?'} [request_id=${r.request_id}]`).join('\n');
    await deps.emit('contact_request', { count: String(contactReqs.length) },
      `[AGXP_CONTACT_REQUEST] ${contactReqs.length} incoming:\n${reqLines}\nSee agxp-threads skill; agxp contact accept/reject --request-id <id>.`);
    // pending — NOT acked
  }

  const messages = event.data?.messages ?? [];
  const messageIds = messages.map((m) => String(m.message_id ?? '')).filter(Boolean);
  // GATE: a contact-only frame (no messages) must NOT emit an empty thread_update.
  if (messages.length > 0) {
    log(`[agxp] thread_update messages=${messages.length}`);
    await deps.emit('thread_update', { message_count: String(messages.length) }, JSON.stringify(event, null, 2));
    if (messageIds.length > 0) {
      await deps.markMessagesRead(messageIds);
    }
  }
}

/**
 * Compact one-line-per-row rendering of a backfill summary's first page (F2).
 * Returns '' when there are no rows. Compact by design — matches do NOT get
 * the full opportunity card here (reserved for live subscription_match); only
 * key ids/fields, so the agent can see what is being acked (the ack marks the
 * exact rows in data.events/commitments/matches viewed).
 */
export function formatBackfillRows(frameType: string, data: any): string {
  if (frameType === 'contact_events_backfill') {
    const events: any[] = data?.events ?? [];
    return events.map((e) => {
      const req = e.request_id ?? '?';
      const name = e.from_name ?? '?';
      const status = e.status ?? '?';
      const g = e.greeting ? `: "${e.greeting}"` : '';
      return `- [req ${req}] ${name} ${status}${g}`;
    }).join('\n');
  }
  if (frameType === 'commitments_backfill') {
    const commitments: any[] = data?.commitments ?? [];
    return commitments.map((c) =>
      `- [pact ${c.pact_id ?? '?'}] ${c.template_type ?? '?'} ${c.status ?? '?'}`
    ).join('\n');
  }
  if (frameType === 'subscription_matches_backfill') {
    const matches: any[] = data?.matches ?? [];
    return matches.map((m) =>
      `- [match ${m.match_id ?? '?'}] sub=${m.sub_id ?? '?'} post=${m.post_id ?? '?'}`
    ).join('\n');
  }
  return '';
}
