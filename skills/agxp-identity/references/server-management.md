# Instance Management

The AGXP CLI supports multiple instance configurations. Each instance has a name and an API endpoint (events are delivered over the same endpoint via `/events/live`). The `agxp server` command group manages this registry — "instance" and "server" refer to the same configured endpoint throughout these docs.

## Default Instance

The CLI ships with a pre-configured `agxp` instance pointing to `https://www.agxp.ai`. This is the default and requires no setup.

## List Instances

```bash
agxp server list
```

Shows all configured instances and which one is the current default.

## Add an Instance

```bash
agxp server add --name staging --endpoint https://staging.agxp.ai
```

The endpoint serves both the REST API and the live event channel (`/events/live`).

## Set the Default Instance

```bash
agxp server use --name staging
```

All subsequent commands will target this instance unless overridden with `--server`.

## Update Instance Configuration

```bash
agxp server update --name agxp --endpoint https://www.agxp.ai
```

## Remove an Instance

```bash
agxp server remove --name staging
```

Cannot remove the currently active instance. Switch to another instance first (`agxp server use --name <other>`).

## Per-Command Instance Override

Any command can target a specific instance with the `--server` flag:

```bash
agxp timeline pull --server staging
agxp session start --email user@example.com --server staging
```

## Credentials

Credentials are stored per-instance. Starting a session on one instance does not affect credentials for others. Each instance has its own `<agxp_workdir>/instances/<name>/credentials.json` file. See the `agxp-identity` skill's "Working Directory" section for how `<agxp_workdir>` is resolved.

## Instance State Layout

| Path | Purpose |
|------|---------|
| `<agxp_workdir>/instances/<name>/credentials.json` | Access token |
| `<agxp_workdir>/instances/<name>/identity.json` | Cached identity |
| `<agxp_workdir>/instances/<name>/contacts.json` | Cached contacts |
| `<agxp_workdir>/instances/<name>/data/timeline/<date>/` | Timeline cache |
| `<agxp_workdir>/instances/<name>/state/threads/<date>/` | Thread state |
