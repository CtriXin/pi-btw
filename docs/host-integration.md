# Host integration contract (v1)

Status: **implemented** in `@ctrixin-dev/pi-btw` `v0.59.0-fork.3` (headless RPC mode, persistence, and
these events are shipped and covered by `npm test` plus `npm run test:e2e`).

## Goals

- A host can start a side question during a running main task without interrupting it.
- Side questions and answers never enter the main conversation context.
- History survives `/new`, `/resume`, `/reload`, and process restart.
- The host can render progress and terminal states from structured events instead of parsing prose.

## Isolation invariants (must not change)

The extension must not call `pi.sendMessage` / `sendUserMessage` / `appendCustomMessageEntry`, must
not abort or steer the main task, and must not change the main model or thinking level.

- Main transcript events stay unchanged.
- `get_entries` gains at most one `custom/btw` entry per finished turn.
- Queue, model, channel, and thinking level stay unchanged.

## Persistent entry

Every finished turn appends one Pi custom entry (`pi.appendEntry("btw", data)`, `customType: "btw"`).
It is persisted to the session and does **not** enter the LLM context. Running turns are not written;
`session_shutdown` cancels and records in-flight turns as `cancelled`.

```json
{
  "v": 1,
  "id": "btw-<12hex>",
  "threadId": "btw-<12hex of the first turn>",
  "question": "…",
  "status": "completed|failed|cancelled",
  "answer": "…",
  "error": null,
  "model": { "provider": "…", "id": "…" },
  "thinkingLevel": "medium",
  "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": null },
  "context": { "mode": "branch|excerpt|none", "entries": 0, "chars": 0, "truncated": false, "leafId": "…" },
  "createdAt": "ISO-8601",
  "completedAt": "ISO-8601",
  "host": "tui|rpc"
}
```

`threadId` groups follow-up turns (`/btw:follow`); the first turn's `id` equals its `threadId`.
Cancelled turns persist with an empty `answer` and `error: "cancelled"` — partial answers are never
written.

## RPC / headless events

In non-TUI modes the extension emits events through `ctx.ui.notify("BTW_EVENT:" + JSON, "info")`.
`notify` is fire-and-forget and surfaces as `extension_ui_request` in the RPC stream, so hosts must
treat it as a stream, not as a request with a response.

```json
{
  "v": 1,
  "event": "accepted|running|delta|completed|failed|cancelled|history",
  "id": "btw-…",
  "question": "…",
  "text": "delta or answer content",
  "error": "…",
  "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": null },
  "context": { "mode": "branch|excerpt|none", "entries": 0, "chars": 0, "truncated": false },
  "model": { "provider": "…", "id": "…" },
  "at": "ISO-8601",
  "items": []
}
```

- `items` is present only for `history` (most recent finished turns, capped by the extension).
- `delta` is optional and rate-limited to at most 4 events per second; `text` carries the delta.
- Terminal events (`completed` / `failed` / `cancelled`) must match the persisted `custom/btw` entry
  for the same `id`.

## Host side (MMS / Pilot)

- Driver: parse the `BTW_EVENT:` notify prefix into `sink.side_question_event(payload)`; it is not a
  user-facing notice. Invalid JSON is recorded as a notice and must not crash the driver.
- Session service: after startup, `get_commands` containing `btw` **and** `btw:cancel` marks
  `meta.btwNative = True` (the upstream package has no headless mode, so `btw:cancel` distinguishes
  the fork).
- Answering: native first via `prompt "/btw <question>"`, falling back to the host runner once when
  the extension is absent, `success:false`, or no terminal event arrives before the host timeout.
  The side-question row records `runner: "pi-extension" | "host"`.
- Cancel: `prompt "/btw:cancel <id>"`.
- The host keeps its own timeout and redaction; extension output is never treated as a success claim.

## Versioning

`v` is the contract version. Additive fields are allowed within `v: 1`; removing or renaming fields
requires a new version.
