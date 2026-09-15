# @ctrixin-dev/pi-btw

## 0.59.0-fork.3

- Align the package version with the next release tag; no functional source changes.

> Fork of `@narumitw/pi-btw` (MIT). See `NOTICE` for provenance and `README.md` for the fork diff.

## 0.59.0-fork.1

- Repository is now a standalone package (was the `packages/pi-btw` directory of the upstream monorepo),
  with the upstream git history imported via `git filter-repo`.
- Added standalone dev/CI tooling: biome config, vitest config plus the upstream test helpers, and a
  GitHub Actions workflow (build, typecheck, biome, tests, `npm pack --dry-run`).
- Changed: package name `@ctrixin-dev/pi-btw`, repository URL, pinned `@narumitw/pi-tui-kit` dependency,
  devDependencies pinned to Pi 0.85.1.
- Added headless RPC mode: `/btw <question>` under `pi --mode rpc` answers without any TUI surface and
  emits `BTW_EVENT:` host events (`accepted`/`running`/`delta`/`completed`/`failed`/`cancelled`/`history`,
  deltas capped at 4/second) per `docs/host-integration.md`.
- Added persistence: every terminal turn appends one `custom/btw` session entry (never enters the LLM
  context); `session_start` rebuilds resumable threads; a registered entry renderer shows a collapsed
  card that expands to the full Q&A.
- Changed default `/btw <question>` TUI behavior to a non-blocking inline widget card (Grok-style):
  the editor stays usable and the main task keeps running. The upstream fullscreen workspace moved to
  `/btw` (no arguments) and `/btw:thread [question]`.
- Added commands: `/btw:cancel`, `/btw:history`, `/btw:open`, `/btw:bring`, `/btw:follow`.
- `session_shutdown` aborts in-flight runs and records them as `cancelled`.
- Verified end-to-end against real `pi --mode rpc` with a mock upstream (`scripts/e2e-rpc.mts`):
  in-stream answers, cancel without answer leakage, and history after `--continue`.

---

# Upstream changelog (`@narumitw/pi-btw`, imported at 0.58.1)

## 0.58.1

### Patch Changes

- ad0fbc0: Honor the API base URL returned by Pi's authentication resolver for both inherited and explicitly configured side-thread models. This fixes misdirected requests for GitHub Copilot accounts that use a different endpoint from the provider default, without changing the main session's model.

## 0.58.0

### Minor Changes

- 609f6a8: Add BTW-only exit, thinking-cycle, and bring-to-main keybindings in `/btw` → Settings, with conflict validation and per-action reset. Preserve Ctrl+C as hard cancel and keep pasted input out of shortcut handling.

### Patch Changes

- Updated dependencies [317f7bd]
  - @narumitw/pi-tui-kit@0.61.0

## 0.57.1

### Patch Changes

- ee07eb8: Forward Pi session headers to OpenCode providers for side-thread requests.

## 0.57.0

### Minor Changes

- f24a5b0: Add a themed, clickable Jump to latest control that honors Pi's effective fullscreen bottom keybinding.

## 0.56.2

### Patch Changes

- c0fe03e: Wait for Pi's terminal input drain before restoring the parent fullscreen TUI after Ctrl+C.

## 0.56.1

### Patch Changes

- 612df75: Defer Ctrl+C terminal restoration until input dispatch finishes so Windows fullscreen sessions redraw and scroll correctly.

## 0.56.0

### Minor Changes

- f41734c: Add configurable manual fullscreen selection copying through Pi's effective copy keybinding, with paste-safe input and compatibility checks.

## 0.55.4

### Patch Changes

- Updated dependencies [40182e5]
  - @narumitw/pi-tui-kit@0.59.0

## 0.55.3

### Patch Changes

- 4fb170b: Restore main-editor input immediately after Ctrl+C exits a dedicated side thread.
- 2250f3c: Close the active side flow when Ctrl+C restores the main editor while transcript search has focus.
- Updated dependencies [78276b0]
- Updated dependencies [dc9802e]
  - @narumitw/pi-tui-kit@0.58.1

## 0.55.2

### Patch Changes

- Updated dependencies [b9eba3a]
  - @narumitw/pi-tui-kit@0.58.0

## 0.55.1

### Patch Changes

- Updated dependencies [6574232]
- Updated dependencies [cddc265]
  - @narumitw/pi-tui-kit@0.57.0

## 0.55.0

### Minor Changes

- 79bc155: Add themed fullscreen transcript search and verified host clipboard feedback for mouse selections.

## 0.54.2

### Patch Changes

- 30bc076: Load each extension from a generated TypeScript runtime to reduce Jiti package startup work while preserving existing first-use boundaries.

## 0.54.1

### Patch Changes

- Updated dependencies [8bead31]
  - @narumitw/pi-tui-kit@0.56.0

## 0.54.0

### Minor Changes

- b5c0682: Add native mouse-wheel and trackpad scrolling to side-thread transcript history.

## 0.53.0

### Minor Changes

- d97edfd: Add a native main-session tree picker that starts a fresh side thread from any selected branch without switching the main conversation.

### Patch Changes

- Updated dependencies [3176172]
  - @narumitw/pi-tui-kit@0.55.0

## 0.52.0

### Minor Changes

- f3d76af: Add a Same as main thread thinking option that starts new side threads from the current main thread level while keeping shortcut changes local.

## 0.51.0

### Minor Changes

- 69e8485: Add local fuzzy search to the in-memory Resume thread choice.

## 0.50.0

### Minor Changes

- be8d492: Add an in-memory Resume picker to `/btw` so the current Pi session can continue any non-empty side thread by its first question while `/btw <question>` remains a fresh-thread fast path.

## 0.49.7

### Patch Changes

- 3f33860: Run side threads in a dedicated full-screen TUI so mouse-drag copying stays stable while the main agent continues producing output in the background.
- 2a2c9c1: Queue Pi-style steering questions while a side-thread answer is running, process them one at a time without touching the main conversation, and report malformed side-model responses without hanging the side UI.

## 0.49.6

### Patch Changes

- a4b44ee: Route side-question completions through Pi's effective runtime provider so custom provider APIs work.
