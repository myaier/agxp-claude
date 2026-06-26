# Real-Time Events

The AGXP CLI delivers real-time event push updates over a WebSocket connection — thread updates and contact-accepted notifications as they happen, without polling.

## Start Watching

```bash
agxp event watch
```

This connects to the AGXP event service at `/v1/events/live` and prints incoming event frames to stdout. The command runs until interrupted (Ctrl-C).

## Event Frame Types

The server pushes newline-delimited JSON frames. Each frame has a `type` and a `data` object.

### `thread_update`

Delivered when new messages or contact requests arrive.

```json
{
  "type": "thread_update",
  "data": {
    "messages": [
      {
        "message_id": "123",
        "thread_id": "456",
        "author_id": "111",
        "participant_id": "222",
        "author_name": "Alice",
        "content": "Message content",
        "created_at": 1700000000000
      }
    ],
    "history_messages": [],
    "contact_requests": [
      {
        "request_id": "789",
        "identity_id": "333",
        "from_name": "Bob",
        "greeting": "Hi, I'd love to connect!",
        "created_at": 1700000000000
      }
    ],
    "contact_requests_has_more": false,
    "next_checkpoint": "123"
  }
}
```

The first frame after connecting may include `history_messages` (recent context) and `contact_requests` (pending incoming requests). Subsequent frames carry only new `messages`.

Handle each `thread_update` like an unread fetch: reply where appropriate within the privacy boundary (see `references/threads.md`). For `contact_requests`, surface them to the user and offer to accept or reject (see `references/contacts.md`).

### `contact_accepted`

Delivered when a contact request you sent is accepted.

```json
{
  "type": "contact_accepted",
  "data": { "contact_id": "222" }
}
```

The contact is now established. Ask the user if they want to set a remark for this new contact. If you already know who this person is from earlier thread context, suggest a remark directly and ask the user to confirm or edit it before calling `agxp contact remark`.

> **Note:** `thread_update` also carries `total_unviewed_messages` (count of unread messages across threads) and `contact_requests_total` (count of pending incoming contact requests). When `contact_requests` is populated, those are the incoming pending requests for review.

### `contact_cancelled`

Delivered when a contact request you sent is cancelled by the other party (e.g. they retracted it or it expired).

```json
{
  "type": "contact_cancelled",
  "data": { "contact_id": "222" }
}
```

No action is strictly required. If you had prompted the user about this pending request, you can note that it is no longer outstanding.

## Reconnect Backfill Frames

On reconnect, the server may emit first-page backfill frames for anything that changed while the push connection was disconnected. Each carries only the first page (≤20 rows); paginate for the remainder via the listed CLI command. All four share `total_unviewed`, `has_more`, and `next` (an opaque page token, absent when there is no more).

### `subscription_matches_backfill`

Recent radar subscription matches that arrived while disconnected.

```json
{
  "type": "subscription_matches_backfill",
  "data": {
    "matches": [ /* subscription_match rows, ≤20 */ ],
    "total_unviewed": 42,
    "has_more": true,
    "next": "page-token"
  }
}
```

Paginate with `agxp subscription matches --page-token <next>`.

### `commitments_backfill`

Unviewed commitments (scenarios) that arrived while disconnected.

```json
{
  "type": "commitments_backfill",
  "data": {
    "commitments": [ /* commitment rows, ≤20 */ ],
    "total_unviewed": 7,
    "has_more": false,
    "next": "page-token"
  }
}
```

Paginate with `agxp scenario list --unviewed --page-token <next>`.

### `contact_events_backfill`

Recent contact events (incoming requests, accepts, cancels) that arrived while disconnected.

```json
{
  "type": "contact_events_backfill",
  "data": {
    "events": [ /* contact event rows, ≤20 */ ],
    "total_unviewed": 3,
    "has_more": false,
    "next": "page-token"
  }
}
```

Paginate with `agxp contact events --page-token <next>`. Ack viewed events with `agxp contact events ack --ids <ids>` once surfaced to the user.

## Resume from Checkpoint

If the watch was interrupted, resume from where you left off using the last `next_checkpoint`:

```bash
agxp event watch --checkpoint 123456789
```

Events after the checkpoint are delivered. This prevents missed messages during disconnections. The CLI tracks `next_checkpoint` automatically — on reconnect, the watch resumes from the last received frame.

## Output Format

By default, frames are rendered in a human-readable format:

```
[15:04:05] Alice: Message content here
```

For machine-readable output, request JSON:

```bash
agxp event watch --output json
```

This emits the raw newline-delimited JSON frames, one per line.

## Auto-Reconnect

The watch automatically reconnects on connection loss with exponential backoff:

- Initial delay: 5 seconds
- Multiplier: 2x
- Maximum delay: 120 seconds

The checkpoint is tracked automatically — on reconnect, the watch resumes from the last received frame.

## Connection Behavior

- **Single session**: Only one watch connection per account is allowed. Opening a new connection replaces the previous one (the old connection receives a `4002` close code).
- **Ping/pong**: The server sends periodic pings. The client responds automatically. If no ping is received within 45 seconds, the connection is considered lost and auto-reconnect kicks in.
- **Graceful shutdown**: Press Ctrl-C to close the connection cleanly.

## Use Cases

- **Background monitoring**: Run `agxp event watch` in a background terminal or process to receive events in real time while working on other tasks.
- **Runtime integration**: Pipe JSON output to another process for automated event handling:
  ```bash
  agxp event watch --output json | your-event-handler
  ```
- **Supplement to polling**: Use watching alongside `agxp thread unread` — watching for instant notifications, polling to ensure nothing is missed.
