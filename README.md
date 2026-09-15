# 💬 pi-btw — Ask Side Questions Without Derailing the Main Task

[![npm](https://img.shields.io/npm/v/@ctrixin-dev/pi-btw)](https://www.npmjs.com/package/@ctrixin-dev/pi-btw) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Ask questions in a temporary side thread without adding them to the main Pi conversation.
Only context you explicitly bring back is loaded into the main editor.

> **Fork notice.** This repository is a fork of [`@narumitw/pi-btw`](https://www.npmjs.com/package/@narumitw/pi-btw)
> v0.58.1 (MIT), maintained by CtriXin. The upstream package directory was imported with its full git
> history; the MIT `LICENSE` and copyright notice are retained. See [`NOTICE`](./NOTICE) for provenance
> and [Fork changes](#-fork-changes) for what differs from upstream.

## ✨ Features

- Starts a side thread immediately with `/btw <question>` or opens the manager with `/btw`.
- Uses any persisted main-session branch as context without switching branches.
- Supports scrollable answers, transcript search, a clickable jump-to-latest control, follow-up questions, queued steering, and in-memory resume.
- Keeps side questions and answers out of the main conversation by default.
- Brings back the latest answer, a question suffix, an exact range, or the complete thread only when requested.
- Uses Pi's current model and thinking level or saved pi-btw choices.
- Offers BTW-only exit, thinking-cycle, and bring-to-main keybindings.

## 📦 Install

```bash
pi install npm:@ctrixin-dev/pi-btw
```

Try without installing permanently:

```bash
pi -e npm:@ctrixin-dev/pi-btw
```

Or install a pinned git ref / a local checkout:

```bash
pi install git:github.com/CtriXin/pi-btw@v0.59.0-fork.1
pi install /path/to/pi-btw
```

The `v0.59.0-fork.1` tag is created when the fork release is tagged; before that, use `@main` or a
commit ref.

Build and try this package locally from this repository root:

```bash
npm install
npm run build
pi -e .
```

The package declares `dist/index.ts`, so an unbuilt local checkout must run the build before Pi loads the package directory.
Pi extensions run with the Pi process's user permissions, so install only trusted packages.
The upstream package (`npm:@narumitw/pi-btw`) is still installable; until coexistence behavior is
verified and documented, install only one of the two packages.

### Fork changes

This fork keeps the upstream 0.58.1 TUI feature set and adds headless (RPC) support, persistent
history, and structured host events. Status of the fork work (as of `v0.59.0-fork.1`):

| Area | Status |
| --- | --- |
| Upstream 0.58.1 fullscreen side thread (search, steering, bring-to-main, keybindings) | Imported unchanged; reachable via `/btw` (no arguments) or `/btw:thread [question]` |
| Repository/CI skeleton | In this commit |
| Headless (`ctx.mode === "rpc"`) support | Implemented; verified end-to-end with `pi --mode rpc` ([`scripts/e2e-rpc.mts`](./scripts/e2e-rpc.mts)) |
| Persistent `btw` custom entries and resume after restart | Implemented; terminal turns append one `custom/btw` entry (never enters LLM context); `session_start` rebuilds resumable threads |
| `BTW_EVENT` structured events for MMS/Pilot | Implemented per [`docs/host-integration.md`](./docs/host-integration.md) |
| `/btw:cancel`, `/btw:history`, `/btw:open`, `/btw:bring`, `/btw:follow`, `/btw:thread` | Implemented |
| Grok-style non-blocking inline card for `/btw <question>` | Implemented: streaming widget above the editor, terminal state persists as a transcript entry |

#### Default interaction change

Upstream `/btw <question>` opened the fullscreen side-thread workspace. In this fork,
`/btw <question>` is a **non-blocking inline card**: the editor stays usable, the answer streams
into a bordered widget above it while the main task keeps running, and the finished answer becomes
a collapsible transcript entry. The fullscreen workspace remains available as `/btw` (no arguments)
or `/btw:thread [question]`.

#### Coexistence with upstream `@narumitw/pi-btw` (measured)

Installing both packages registers two `btw` commands. Verified on Pi 0.85.1: Pi renames them to
`/btw:1` and `/btw:2` in load order, no crash. **However, the bare `/btw` then becomes ambiguous and
is sent to the main agent as a normal user message** — the question would enter the main context.
Do not run both packages in the same Pi setup; pick one (`pi remove <source>` for the other).

Compatibility: development, tests, and the pinned `@earendil-works/pi-*` devDependencies target Pi
**0.85.1**. Other Pi versions are not verified by this repository.


## 🚀 Quick start

In TUI mode, run `/btw <question>` to start immediately or `/btw` to choose context and settings first.
The side thread stays separate until you explicitly bring context to the main editor.

## 💬 Commands

| Command | Purpose |
| --- | --- |
| `/btw <question>` | Non-blocking inline card answer (TUI) or headless answer with host events (RPC). |
| `/btw` | Upstream menu: choose context, start or resume a side thread, or change settings (TUI only). In RPC mode this fails with `question_required`. |
| `/btw:thread [question]` | Upstream fullscreen side-thread workspace (TUI only). |
| `/btw:cancel [id]` | Cancel an in-flight side question (latest when no id is given). |
| `/btw:history` | Recent persisted side questions (TUI overlay; RPC `history` event, last 20). |
| `/btw:open [id]` | Read a persisted answer in a scrollable overlay; Esc closes (TUI only). |
| `/btw:bring [id]` | Load a completed answer into the main editor without sending it. |
| `/btw:follow <id> <question>` | Ask a follow-up on an existing side thread. |

The inline/headless flows require a model with usable credentials; see [Settings](#-settings).
Side questions and selected conversation context are sent to that model's provider.
Bringing context back fills the main editor without submitting; replacing an existing draft requires confirmation.
Ctrl+C cancels the response in the fullscreen workspace and discards the current draft and queued questions.
Read the [workflow guide](./docs/workflows.md) for context selection, copying, search, steering, and draft recovery.
Finished turns persist as `custom/btw` session entries and survive `/new`, `/resume`, `/reload`, and restarts.

## ⚙️ Settings

By default, `/btw` uses the current session model.
To use an independent model for side questions, create:

```text
$PI_CODING_AGENT_DIR/pi-btw.json
```

The normal location is `~/.pi/agent/pi-btw.json`.
`PI_CODING_AGENT_DIR` is an existing Pi setting; pi-btw does not add any environment variables.

```json
{
  "model": "anthropic/claude-sonnet-4-5",
  "thinkingLevel": "low",
  "rememberThinkingLevelChanges": true,
  "fullscreenCopyOnSelect": true
}
```

The `model` value uses `provider/model-id` format.
Only the first `/` is the separator, so model IDs may contain additional slashes, such as `openrouter/anthropic/claude-sonnet`.
The configured model must exist in Pi's model registry and have usable credentials.
If it is missing or unauthenticated, pi-btw warns and falls back to the current session model.
If neither model is available, `/btw` reports an error and stops.
This selection affects only `/btw`; it does not change the main session model.

Pi calls its reasoning setting the **thinking level**.
In Settings, choose **Same as main thread** to start each new side thread from the main thread's current thinking level.
This is stored by omitting `thinkingLevel` from `pi-btw.json`.

Set `thinkingLevel` only when you want a fixed pi-btw starting level.
Accepted fixed values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
The initial value and shortcut cycle are clamped to the selected side model's capabilities using Pi's model rules.
Resumed side threads keep their own local thinking level instead of re-syncing with the main thread.
Pi-btw does not read, write, or change the main session's `defaultThinkingLevel`.

`rememberThinkingLevelChanges` controls only persistence for fixed thinking levels and defaults to `true` when omitted.
A side-thread shortcut always changes that side thread immediately.
When a fixed thinking level is selected and remembering is on, the concrete level is written for the next invocation; when off, `pi-btw.json` stays unchanged.
When **Same as main thread** is selected, shortcut changes stay local even when remembering is on.
If a shortcut write fails, the local change remains active and pi-btw warns that it was not remembered.
A failed Settings-screen save instead restores the previous displayed value.

`fullscreenCopyOnSelect` controls only pi-btw's dedicated fullscreen view and defaults to `true` when omitted.
Turn **Copy selection automatically** off to retain highlighted selections and copy them with Pi's effective `app.message.copy` binding.
Pi-btw does not inherit Pi core's setting of the same name because Pi's public extension API does not expose its effective value.

### Keybindings

Open `/btw` → **Settings**, select a shortcut row, then choose **Edit key combination…** or **Restore default**.
Type a key name such as `ctrl+q` or `f6`; this is not a key-recording prompt.
Changes save immediately and apply when opening or resuming BTW, without `/reload`. Escape cancels an unfinished edit, not earlier saves.
The literal `/btw settings` remains a side question, not a settings subcommand.

| JSON field under `keybindings` | Default | Action |
| --- | --- | --- |
| `exit` | `ctrl+c` | Cancel and leave the dedicated side-thread workspace, including its nested dialogs. |
| `cycleThinkingLevel` | Inherit Pi's `app.thinking.cycle` | Cycle supported levels while composing or generating. |
| `bringToMain` | `ctrl+r` | Open the bring-to-main chooser after a completed answer. |

For example, merge these overrides into `pi-btw.json`:

```json
{
  "keybindings": {
    "exit": "ctrl+q",
    "cycleThinkingLevel": "f6",
    "bringToMain": "f7"
  }
}
```

Each override accepts one Pi key name with optional `ctrl`, `shift`, `alt`, and `super` modifiers; modifier order and letter case do not matter.
Letters, digits, Pi special keys and symbols are recognized, except the literal `+`, which Pi's matcher cannot parse as a base key.
Function keys `f1`–`f12` and Escape accept no modifiers; Clear accepts only no modifier, Shift, or Ctrl.
Actual availability depends on the terminal; `super` and some modified combinations require extended keyboard reporting.

New overrides cannot take ordinary typing keys or conflict with BTW actions, Pi editing, selection, search, scrolling, or enabled manual-copy bindings.
Pi's explicitly configured printable thinking shortcuts remain inherited for compatibility.
If a saved override becomes conflicting, BTW warns and uses an available default; if none is usable, that shortcut is unavailable and its activation hint is omitted.
An explicitly unbound Pi thinking action stays unbound. Remove an override field to restore its default; neither saving nor resetting modifies Pi's global keybindings.
**Ctrl+C always remains available as hard cancel**, even after configuring another exit key. Shortcut handling does not interpret bracketed-paste payloads as commands.

### Persistence

Reading a missing settings file has no side effects.
Pi-btw creates it only after a Settings change or a remembered shortcut change.
Within one Pi process, saves run in order and publish atomically through a same-directory temporary file and rename.
Saves preserve `model` and unknown fields.
Malformed or invalid files block saves and remain unchanged.
Files must be valid UTF-8 and no larger than 64 KiB.
Separate Pi processes and external editors are outside the in-process ordering boundary.
The file is read for every `/btw` invocation, so edits apply without `/reload`.

## 🚧 Limitations

- Headless mode covers `ctx.mode === "rpc"`; `print` and `json` modes report an error.
- Threads resumed after a restart keep their Q&A turns but not the original branch snapshot; follow-ups then run with `context.mode` based on the rebuilt (empty) background.
- A side thread retains the latest 40,000 characters of main-conversation context and adds a truncation notice when earlier content is omitted.
- Clipboard access depends on Pi's host helper, the operating system, and the terminal.
- Pi versions before 0.85 omit the clickable jump-to-latest control.

## 🗂️ Package layout

```text
pi-btw/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── btw.ts                         # Side-thread lifecycle and command
├── dist/                              # Generated Jiti runtime
├── docs/                              # Side-thread workflows, install, host contract
├── scripts/build-runtime.mjs          # Runtime builder
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, AI coding agent, side question command, agent chat workflow, TypeScript Pi package, npm Pi extension.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
