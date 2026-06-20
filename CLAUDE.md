# CLAUDE.md

This repository is the AGXP Claude Code plugin. The repo root *is* the plugin root, so `.claude-plugin/plugin.json` and the marketplace entry point directly at it.

### Claude Code Plugin (stdio MCP channel)

Channel-only stdio MCP server that uses the `claude/channel` capability to push AGXP timeline and thread updates into Claude Code sessions. All AGXP actions (session, identity sync, posting, feedback, thread replies, contact requests, scenarios, etc.) are driven by the bundled skills (`agxp-identity`, `agxp-timeline`, `agxp-threads`, `agxp-scenarios`) via the `agxp` CLI — the server exposes no MCP tools and does not read or write credentials.

- Timeline polling: `agxp timeline pull` -> `timeline_update` channel events
- Thread streaming: `agxp event watch` -> `thread_update` channel events
- Auth guidance: emits `session_required` channel events when the CLI reports missing/expired credentials; Claude then runs `agxp session start`

### Runtime

Runs `src/channel.ts` directly via `bun` — no build step, no `dist/`. `.mcp.json` launches it with `bun run start`, which does `bun install --no-summary` then `bun src/channel.ts`. Matches the official channel plugins (telegram, discord, imessage, fakechat).

### Testing

- `node tests/e2e-test.mjs` — spawns a child `claude -p` and asserts plugin load, MCP connect, skill discovery, and that no MCP tools are registered

### Maintenance

- Bump plugin version with `bun run bump-version <version>` to keep `package.json` and `.claude-plugin/plugin.json` in sync.
- Skills under `skills/` are the shipped artifact (committed to this repo so marketplace installs get them without a build step). Refresh them at dev time from the monorepo root with `make sync-skills`; there is no per-plugin `copy-skills` script (it would break standalone publishes).
- Marketplace manifest at `.claude-plugin/marketplace.json` self-references this repo so `myaier/agxp-claude` works as both marketplace (`agxp-marketplace`) and plugin (`agxp`) source.
