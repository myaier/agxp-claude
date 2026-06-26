/**
 * Opportunity-card renderer for subscription_match events (AGXP Radar).
 * Pure formatting — mirrors plugins/hermes/src/hermes_agxp/card.py byte-for-byte
 * against the shared fixture (contracts/radar/opportunity-card-fixture.json).
 * Missing fields are omitted gracefully.
 * Fallback chains use `||` (not `??`) to mirror card.py's Python `or` (falsy) semantics — e.g. headcount:0 falls through to capacity.
 */
const TIER_BADGE: Record<string, string> = { high: '🔴', medium: '🟡', low: '⚪' };

export interface SubscriptionMatchData {
  tier?: string;
  title?: string;
  summary?: string;
  why_matched?: string[];
  keyword_overlap?: number;
  author?: { name?: string; sender_autonomous?: boolean };
  payload?: { headcount?: number; capacity?: number; [k: string]: unknown };
  post_id?: string;
  match_id?: string | number;
  sub_id?: string | number;
  [k: string]: unknown;
}

export function renderOpportunityCard(data: SubscriptionMatchData): string {
  const tier = String(data.tier || 'low');
  const badge = TIER_BADGE[tier] ?? '⚪';
  const title = String(data.title || data.summary || 'AGXP 机会').trim();
  const summary = String(data.summary ?? '').trim();

  const why = data.why_matched ?? [];
  const overlap = data.keyword_overlap;
  const author = data.author ?? {};
  const postPayload = (data.payload ?? {}) as { headcount?: number; capacity?: number };
  const postId = data.post_id;

  const lines: string[] = [`🎯 AGXP 机会 · ${badge}[${tier}]`];
  lines.push(title);
  if (summary && summary !== title) {
    lines.push(truncate(summary, 160));
  }

  if (why.length > 0) {
    let whyStr = why.map((w) => String(w)).join(', ');
    if (overlap) {
      whyStr += `（重叠 ${overlap}）`;
    }
    lines.push(`why: ${whyStr}`);
  }

  const authorName = author.name;
  if (authorName) {
    let fromStr = `from: ${authorName}`;
    if (author.sender_autonomous) {
      fromStr += ' 🤖自治';
    }
    lines.push(fromStr);
  }

  const cap = postPayload.headcount || postPayload.capacity;
  if (cap) {
    lines.push(`名额: ${cap}（剩余见 /derive）`);
  }

  if (postId) {
    lines.push(`post ${postId}`);
  }

  lines.push('');
  if (authorName) {
    lines.push(`你可以说：拉详情 / 联系 ${authorName} / 创建承诺 / 调整这个雷达。联系、承诺等写动作会先确认。`);
  } else {
    lines.push('你可以说：拉详情 / 联系作者 / 创建承诺 / 调整这个雷达。联系、承诺等写动作会先确认。');
  }
  lines.push('Powered by AGXP');
  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
