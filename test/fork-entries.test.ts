import assert from "node:assert/strict";
import { test } from "vitest";
import { buildConversationContextWithMeta } from "../src/btw-context.js";
import {
	BTW_ENTRY_TYPE,
	type BtwEntryData,
	collectBtwEntries,
	isBtwEntryData,
	newBtwId,
	rebuildBtwThreads,
	registerBtwEntryRenderer,
} from "../src/btw-entries.js";
import { createMockPi } from "./support.js";

function completedEntry(overrides: Partial<BtwEntryData> = {}): BtwEntryData {
	return {
		v: 1,
		id: "btw-aaaabbbbcccc",
		threadId: "btw-aaaabbbbcccc",
		question: "What does this repo do?",
		status: "completed",
		answer: "It answers side questions.",
		error: null,
		model: { provider: "test", id: "side-model" },
		thinkingLevel: "medium",
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: null },
		context: { mode: "branch", entries: 3, chars: 120, truncated: false, leafId: "leaf" },
		createdAt: "2026-09-14T01:00:00.000Z",
		completedAt: "2026-09-14T01:00:01.000Z",
		host: "tui",
		...overrides,
	};
}

test("newBtwId produces btw-<12hex> ids", () => {
	const id = newBtwId();
	assert.match(id, /^btw-[0-9a-f]{12}$/);
	assert.notEqual(newBtwId(), newBtwId());
});

test("isBtwEntryData validates the v1 contract", () => {
	assert.equal(isBtwEntryData(completedEntry()), true);
	assert.equal(isBtwEntryData(null), false);
	assert.equal(isBtwEntryData({ v: 2, id: "x", question: "q", status: "completed" }), false);
	assert.equal(isBtwEntryData({ v: 1, id: "x", question: "q", status: "running" }), false);
});

test("collectBtwEntries filters custom/btw entries and ignores foreign data", () => {
	const entries = [
		{ type: "message", message: { role: "user", content: "hi" } },
		{ type: "custom", customType: "other", data: {} },
		{ type: "custom", customType: BTW_ENTRY_TYPE, data: { broken: true } },
		{ type: "custom", customType: BTW_ENTRY_TYPE, data: completedEntry() },
	];
	const collected = collectBtwEntries(entries);
	assert.equal(collected.length, 1);
	assert.equal(collected[0]?.id, "btw-aaaabbbbcccc");
});

test("rebuildBtwThreads groups turns by thread and skips cancelled answers", () => {
	const first = completedEntry();
	const cancelled = completedEntry({
		id: "btw-dddd00001111",
		threadId: first.id,
		question: "cancelled follow-up",
		status: "cancelled",
		answer: "",
		error: "cancelled",
	});
	const failed = completedEntry({
		id: "btw-222233334444",
		threadId: first.id,
		question: "failed follow-up",
		status: "failed",
		answer: "",
		error: "provider exploded",
	});
	const threads = rebuildBtwThreads([first, cancelled, failed]);
	assert.equal(threads.length, 1);
	const thread = threads[0];
	assert.equal(thread.threadId, first.id);
	assert.equal(thread.title, "What does this repo do?");
	assert.equal(thread.turns.length, 2);
	assert.equal(thread.turns[0]?.kind, "answered");
	assert.equal(thread.turns[1]?.kind, "error");
	assert.equal(thread.thinkingLevel, "medium");
});

test("entry renderer shows an answer preview in collapsed mode and full expanded card", () => {
	const mock = createMockPi();
	registerBtwEntryRenderer(mock.pi);
	const renderer = mock.entryRenderers.get(BTW_ENTRY_TYPE);
	assert.ok(renderer);

	const theme = {
		fg: (_role: string, text: string) => text,
		bg: (_role: string, text: string) => text,
		bold: (text: string) => text,
	};
	const entry = { type: "custom", customType: BTW_ENTRY_TYPE, data: completedEntry() };
	const collapsed = renderer(entry, { expanded: false }, theme) as {
		render: (width: number) => string[];
	};
	const collapsedLines = collapsed.render(100);
	assert.equal(collapsedLines.length <= 6, true);
	assert.match(collapsedLines.join("\n"), /\/btw What does this repo do\?/);
	assert.match(collapsedLines.join("\n"), /completed/);
	assert.match(collapsedLines.join("\n"), /It answers side questions\./);
	assert.match(collapsedLines.join("\n"), /\/btw:open btw-aaaabbbbcccc/);

	const expanded = renderer(entry, { expanded: true }, theme) as {
		render: (width: number) => string[];
	};
	const expandedLines = expanded.render(100).join("\n");
	assert.match(expandedLines, /It answers side questions\./);
	assert.match(expandedLines, /test\/side-model/);
});

test("entry renderer keeps collapsed answer previews bounded", () => {
	const mock = createMockPi();
	registerBtwEntryRenderer(mock.pi);
	const renderer = mock.entryRenderers.get(BTW_ENTRY_TYPE);
	assert.ok(renderer);
	const theme = {
		fg: (_role: string, text: string) => text,
		bg: (_role: string, text: string) => text,
		bold: (text: string) => text,
	};
	const entry = {
		type: "custom",
		customType: BTW_ENTRY_TYPE,
		data: completedEntry({ answer: "x".repeat(500) }),
	};
	const collapsed = renderer(entry, { expanded: false }, theme) as {
		render: (width: number) => string[];
	};
	const lines = collapsed.render(100).join("\n");
	assert.match(lines, /\/btw:open btw-aaaabbbbcccc/);
	assert.ok(!lines.includes("x".repeat(200)));
});

test("buildConversationContextWithMeta reports entries, chars and truncation", () => {
	const { text, info } = buildConversationContextWithMeta([
		{ type: "message", id: "a", message: { role: "user", content: "hello" } },
		{ type: "message", id: "b", message: { role: "assistant", content: "hi there" } },
		{ type: "custom", id: "c" },
	]);
	assert.equal(text, "User: hello\n\nAssistant: hi there");
	assert.deepEqual(info, {
		mode: "branch",
		entries: 2,
		chars: text.length,
		truncated: false,
		leafId: "c",
	});

	const empty = buildConversationContextWithMeta([]);
	assert.equal(empty.info.mode, "none");
	assert.equal(empty.info.entries, 0);
});
