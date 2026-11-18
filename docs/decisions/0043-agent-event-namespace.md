# 0043. Bus and session names use the `agent:` namespace

## Context

`pi.events` is one flat, process-wide namespace that every extension shares. pi does not namespace event names. Session custom entry types and custom message types are also flat strings, stored in session files.

The tool family is `agent` ([ADR 0042](0042-tool-names.md)).

Each bus name has one direction. Either a caller emits it and this extension answers, or this extension emits it and others listen. A reader of the name must be able to tell which.

## Decision

Every name that the extension puts on `pi.events` starts with `agent:`. Every custom type that it writes into a session also starts with `agent:`.

| Kind | Form | Example | Emitter |
| --- | --- | --- | --- |
| Request | `agent:rpc:<verb>` | `agent:rpc:spawn` | Caller |
| Reply | `agent:rpc:<verb>:reply:<requestId>` | `agent:rpc:spawn:reply:42` | Extension, once |
| Event | `agent:<event>` | `agent:completed` | Extension, to any listeners |
| Session entry type | `agent:<entry>` | `agent:record` | Extension |
| Custom message type | `agent:<message>` | `agent:notification` | Extension |

- `<verb>`, `<event>`, `<entry>` and `<message>` are lowercase snake_case.
- No event uses the name `rpc`, so a request and an event never share a name.
- Names match exactly. No earlier name has an alias.
- Code, tests, `AGENTS.md`, `README.md`, `docs/rpc.md` and ADR text use these names.

Done check: this command prints nothing.

```bash
git grep -n -E "['\"\`](subagents:[a-z_]|subagent-notification)" -- ':!docs/decisions/*-agent-event-namespace.md'
```

Rejected:

- `agents:` matches the `/agents` command, but not the tool family.
- `pi-subagents:` keeps the word that this namespace removes.
- No `rpc:` segment: requests and events would share one namespace. The `agent:stop` request and an `agent:stopped` event would differ by two letters.

## Consequences

- The rename is a breaking protocol change ([ADR 0046](0046-rpc-versioning-and-error-codes.md)). pi-advisor must rename every channel and event it uses.
- Session files written under earlier names keep `subagents:record` entries and `subagent-notification` messages. pi shows the messages with its default custom-message view, not this extension's renderer. Nothing reads the entries.
- `agent:` is short and generic, so another extension can emit an `agent:` name. Revisit if pi adds event namespacing, or if a collision occurs.
