/**
 * routeEvent (P1 forwarder).
 *
 * The CLI (`agxp event watch -o agent`) now owns ALL event rendering: it turns
 * each raw server frame into a self-contained `RenderedBlock` and emits one
 * NDJSON line. This module is a thin forwarder that preserves the NO-LOSS
 * boundary: it emits the rendered `agent_block` to the channel, and ONLY after
 * a successful emit (and only if the block carries an `ack_token`) does it ack
 * server-side via `agxp event ack <token>`. A block the agent never saw is
 * never marked read.
 *
 * What was deleted here vs the pre-P1 version:
 *  - the per-type `switch (event.type)` over raw `event.data`
 *  - `renderOpportunityCard` import + `formatBackfillRows`
 *  - per-type ack deps (markMatchesRead / markCommitmentsRead /
 *    markContactEventsRead / markMessagesRead) — collapsed into one generic
 *    `ackToken(token)`.
 */

const log = console.error;

/** A rendered frame as emitted by `agxp event watch -o agent`. Empty fields
 *  are omitted by the CLI's renderer, so every field except `type` is optional. */
export interface RenderedBlock {
  type: string;
  /** Ready-to-inject text (card / summary / instruction). May be absent for
   *  skip frames (e.g. 0-item backfill), in which case the shell still emits
   *  an empty string so the channel sees the event_type. */
  agent_block?: string;
  /** Raw event data the CLI received (the inner `data` object). Additive
   *  (omitempty); claude/openclaw emit agent_block only and never read this.
   *  Present so shells needing structured access (hermes OwnerGate / PM-keying)
   *  can read data.messages[].{thread_id,author_id} off the parsed Block. */
  data?: unknown;
  /** Flat string map carried alongside the block (tier / message_count / ...). */
  meta?: Record<string, string>;
  /** Self-contained ack token. Absent on frames that must NOT be acked
   *  (contact_request, live contact_event). */
  ack_token?: string;
}

export interface RouteEventDeps {
  /** Push the agent_block into the MCP channel. MUST reject to signal a
   *  delivery failure — on reject, routeEvent skips the ack (no-loss). */
  emit: (eventType: string, meta: Record<string, string>, content: string) => Promise<void>;
  /** Run `agxp event ack <token>`. Only called after a successful emit. */
  ackToken: (token: string) => Promise<boolean>;
}

/**
 * Forward one rendered Block to the channel and (conditionally) ack it.
 *
 * Ordering + no-loss invariant:
 *   1. `await deps.emit(...)` — if this rejects, we log and RETURN without
 *      acking. Never mark read something the agent never saw.
 *   2. only if emit resolved AND `block.ack_token` is non-empty:
 *      `await deps.ackToken(block.ack_token)`.
 */
export async function routeEvent(block: RenderedBlock, deps: RouteEventDeps): Promise<void> {
  const meta = block.meta ?? {};
  const content = block.agent_block ?? '';

  try {
    await deps.emit(block.type, meta, content);
  } catch (err) {
    // NO-LOSS: emit failed → the agent did not see this block → do NOT ack.
    log(`[agxp:event] emit failed for type=${block.type}; skipping ack (no-loss): ${
      err instanceof Error ? err.message : String(err)
    }`);
    return;
  }

  const token = block.ack_token ?? '';
  if (token) {
    try {
      await deps.ackToken(token);
    } catch (err) {
      // ack failure is non-fatal: the block was delivered (the important
      // part); a missed ack just means the row may re-deliver next reconnect,
      // which is the safe direction (spec §8 "重复通知比丢通知安全").
      log(`[agxp:event] ack failed for type=${block.type}: ${
        err instanceof Error ? err.message : String(err)
      }`);
    }
  }
}
