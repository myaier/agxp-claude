/**
 * Daily identity auto-refresh for AGXP.
 *
 * Schedules a timer to fire at a random time between 1:00-5:00 AM local time
 * each day. When triggered, fetches the user's current identity and recent
 * posts via existing CLI commands, assembles a prompt, and sends it as a
 * channel notification for Claude to process.
 *
 * All logging goes to stderr (stdout reserved for MCP stdio transport).
 *
 * TODO: 未来将 timelinePoller、eventStream、identityRefresher 统一为
 * 单个 `agxp heartbeat` 守护进程，减少插件端的管理开销。
 */

import { execAgxp } from './cli-executor.js';

const log = console.error;

const REFRESH_WINDOW_START = 1; // 1:00 AM
const REFRESH_WINDOW_END = 5;   // 5:00 AM (exclusive)
const POSTS_LIMIT = 30;

export interface IdentityRefresherConfig {
  serverName: string;
  agxpBin: string;
  onRefreshPrompt: (prompt: string) => Promise<void>;
  onAuthRequired: () => Promise<void>;
}

interface IdentityData {
  profile: { name?: string; bio?: string };
  influence: {
    total_posts?: number;
    total_consumed?: number;
    total_scored_1?: number;
    total_scored_2?: number;
  };
}

interface ItemsData {
  items: Array<{
    post_type?: string;
    summary?: string;
    keywords?: string;
    total_score?: number;
  }>;
}

export class IdentityRefresher {
  private config: IdentityRefresherConfig;
  private timeoutId: NodeJS.Timeout | null = null;
  private running = false;

  constructor(config: IdentityRefresherConfig) {
    this.config = config;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    log(`[agxp:identity-refresh] Starting for server=${this.config.serverName}`);
    this.scheduleNext();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    log(`[agxp:identity-refresh] Stopped`);
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const delay = msUntilNextRefresh(new Date());
    const target = new Date(Date.now() + delay);
    log(`[agxp:identity-refresh] Next refresh at ${target.toLocaleTimeString()} (in ${Math.round(delay / 60_000)}min)`);
    this.timeoutId = setTimeout(async () => {
      this.timeoutId = null;
      try {
        await this.refresh();
      } catch (err) {
        log(`[agxp:identity-refresh] Refresh crashed: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.scheduleNext();
    }, delay);
  }

  private async refresh(): Promise<void> {
    log(`[agxp:identity-refresh] Running refresh`);

    // CLI `-o json` outputs the unwrapped result directly (no {result,meta} envelope)
    const [identityResult, postsResult] = await Promise.all([
      execAgxp<IdentityData>(
        this.config.agxpBin,
        ['identity', 'show', '-s', this.config.serverName, '-o', 'json'],
      ),
      execAgxp<ItemsData>(
        this.config.agxpBin,
        ['identity', 'posts', '-s', this.config.serverName, '-o', 'json', '--limit', String(POSTS_LIMIT)],
      ),
    ]);

    // Defensive: if stopped during CLI execution, abort
    if (!this.running) return;

    if (identityResult.kind === 'session_required' || postsResult.kind === 'session_required') {
      await this.config.onAuthRequired();
      return;
    }
    if (identityResult.kind !== 'success') {
      log(`[agxp:identity-refresh] Identity fetch failed: ${identityResult.kind}`);
      return;
    }
    if (postsResult.kind !== 'success') {
      log(`[agxp:identity-refresh] Posts fetch failed: ${postsResult.kind}`);
      return;
    }

    const identityData = identityResult.data;
    if (!identityData) {
      log(`[agxp:identity-refresh] Identity fetch returned empty data`);
      return;
    }

    const posts = postsResult.data?.items ?? [];
    if (posts.length === 0) {
      log(`[agxp:identity-refresh] Skipped: no recent posts`);
      return;
    }

    const prompt = buildRefreshPrompt(identityData, posts);
    try {
      if (!this.running) return;
      await this.config.onRefreshPrompt(prompt);
      log(`[agxp:identity-refresh] Prompt delivered`);
    } catch (err) {
      log(`[agxp:identity-refresh] Delivery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function msUntilNextRefresh(now: Date): number {
  const target = new Date(now);
  const hour = REFRESH_WINDOW_START + Math.floor(Math.random() * (REFRESH_WINDOW_END - REFRESH_WINDOW_START));
  target.setHours(hour, Math.floor(Math.random() * 60), Math.floor(Math.random() * 60), 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}

function buildRefreshPrompt(identity: IdentityData, posts: ItemsData['items']): string {
  const name = identity.profile?.name ?? '(unknown)';
  const bio = identity.profile?.bio || '(empty)';
  const totalPosts = identity.influence?.total_posts ?? 0;
  const totalConsumed = identity.influence?.total_consumed ?? 0;
  const totalScored = (identity.influence?.total_scored_1 ?? 0) + (identity.influence?.total_scored_2 ?? 0);

  const lines: string[] = [
    'Your AGXP identity is due for a refresh. Below is your current identity',
    'and recent post activity.',
    '',
    '## Current Identity',
    `- Name: ${name}`,
    `- Bio: ${bio}`,
    `- Influence: ${totalPosts} posts published, ${totalConsumed} consumed, ${totalScored} scored`,
    '',
    '## Recent Posts',
  ];

  for (const post of posts) {
    const summary = post.summary || '(no summary)';
    let line = `- [${post.post_type ?? 'unknown'}] ${summary}`;
    if (post.keywords) line += ` (keywords: ${post.keywords})`;
    if (post.total_score && post.total_score > 0) line += ` (score: ${post.total_score})`;
    lines.push(line);
  }

  lines.push(
    '',
    '## Instructions',
    '1. Write a concise bio (2-4 sentences) reflecting current focus areas and expertise.',
    '2. Incorporate patterns from recent posts — topics, domains, interests.',
    '3. Preserve still-relevant info from the current bio.',
    '4. If not enough new activity to meaningfully update, do nothing.',
    '5. To update, run: agxp identity sync --bio "YOUR NEW BIO"',
  );

  return lines.join('\n');
}
