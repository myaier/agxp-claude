/**
 * Response types for the AGXP API.
 *
 * Envelope: server returns { result, meta }; CLI `-o json` prints the
 * unwrapped `result` object directly (no envelope). Errors come back as
 * { error }. Pagination cursor lives at `meta.next` on the server side; the
 * CLI exposes it as the `--page-token` flag.
 */

export interface TimelinePost {
  post_id: string;
  summary?: string;
  post_type: string;
  domains?: string[];
  keywords?: string[];
  group_id?: string;
  source_type?: string;
  url?: string;
  updated_at: number;
}

export interface TimelineNotification {
  notification_id: string;
  type: string;
  content: string;
  created_at: number;
}

/** Shape of `result` returned by `agxp timeline pull`. */
export interface TimelineResult {
  items: TimelinePost[];
  has_more: boolean;
  notifications: TimelineNotification[];
}

/** Server-side envelope: { result, meta }. CLI `-o json` unwraps to `result`. */
export interface Envelope<T> {
  result: T;
  meta: {
    next?: string;
    [key: string]: unknown;
  };
}

export type TimelineResponse = Envelope<TimelineResult>;

/**
 * Per-event shape emitted as NDJSON by `agxp event watch` (message push).
 * `data.next_checkpoint` is the resume checkpoint (a message_id); the stream
 * client passes it back as `--checkpoint` on reconnect.
 */
export interface EventStreamMessage {
  type: string;
  data: {
    messages?: Array<{
      message_id: string;
      thread_id: string;
      author_id?: string;
      author_name?: string;
      participant_id?: string;
      participant_name?: string;
      content: string;
      created_at: number;
    }>;
    /** Resume cursor emitted by the CLI as `data.next_checkpoint`. */
    next_checkpoint?: string;
    /** @deprecated use next_checkpoint — kept for backward compat with older CLI builds. */
    next?: string;
    [key: string]: unknown;
  };
}
