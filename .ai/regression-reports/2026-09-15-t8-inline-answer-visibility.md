# T8 Inline Answer Visibility Regression

- Timestamp: 2026-09-15 18:38 +08
- Task/scope: Make completed `/btw` answers visible in the Pi TUI transcript/card and make `/btw:open` / `/btw:history` overlays opaque and width-safe.
- Changed files: `PRODUCT.md`, `src/inline-card.ts`, `src/btw-entries.ts`, `src/entry-viewer.ts`, `test/fork-entries.test.ts`, `test/fork-headless.test.ts`, `test/entry-viewer.test.ts`, `test/support.ts`, `scripts/t8-pty-smoke.py`.
- Expected behavior: completed card retains answer until input/Escape; collapsed entry shows bounded answer and open hint; overlay rows fill their allocated width and stay within the frame; RPC/schema/host contracts are unchanged.
- Regression risk/blast radius: fork TUI presentation layer only; no provider, model, RPC, event, entry-schema, or Pilot changes.
- Commands run: `npm run check`; `npm test`; `npm run test:e2e`; `python3 -m py_compile scripts/t8-pty-smoke.py`; real PTY smoke using Pi `0.85.1` and local mock SSE upstream.
- Result: PASS. `18` test files and `359` tests passed; RPC A2/A3/A4 passed; final PTY summary all required checks true.
- Evidence: Stride `docs/btw-plugin/reports/t8-logs/` contains raw/clean PTY logs, summary, reproducible harness, and four PNG screen captures.
- Known unrelated/skipped: production provider quality and downstream MMS bundle/A6 release checks are out of scope until fork review and landing.
- Final status: PASS locally; awaiting review, no publish/merge/deploy performed.
