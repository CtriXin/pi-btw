import assert from "node:assert/strict";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { test } from "vitest";
import btw from "../src/btw.js";
import type { BtwEntryData } from "../src/btw-entries.js";
import { BTW_EVENT_PREFIX } from "../src/host-events.js";
import { createMockContext, createMockPi } from "./support.js";

const MODEL = { provider: "test", id: "side-model" } as unknown as Model<Api>;

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "unknown" as AssistantMessage["api"],
		provider: "test" as AssistantMessage["provider"],
		model: "side-model",
		usage: {
			input: 5,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 8,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function streamOf(chunks: string[]) {
	const stream = createAssistantMessageEventStream();
	const partial = assistantMessage("");
	stream.push({ type: "start", partial });
	for (const chunk of chunks) {
		stream.push({ type: "text_delta", contentIndex: 0, delta: chunk, partial });
	}
	stream.push({ type: "done", reason: "stop", message: assistantMessage(chunks.join("")) });
	return stream;
}

function hangingStream(signal?: AbortSignal) {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: assistantMessage("") });
	signal?.addEventListener("abort", () => {
		stream.push({ type: "error", reason: "aborted", error: assistantMessage("") });
	});
	return stream;
}

type CtxOverrides = Parameters<typeof createMockContext>[0];

/**
 * Mock context wired for the standalone flow: model resolvable through the
 * registry, branch with background messages, provider streaming the chunks.
 */
function standaloneContext(
	chunks: string[],
	overrides: CtxOverrides = {},
	mock?: ReturnType<typeof createMockPi>,
) {
	let lastStreamOptions: { signal?: AbortSignal } | undefined;
	const branchMessages = [
		{
			type: "message",
			id: "leaf-9",
			message: { role: "user", content: "main task background" },
		},
	];
	// Mirror real Pi: pi.appendEntry writes into the session, so getBranch
	// reflects previously persisted custom entries.
	const getBranch = () => [
		...branchMessages,
		...(mock?.entries ?? []).map((entry) => ({
			type: "custom",
			customType: entry.customType,
			data: entry.data,
		})),
	];
	const ctxResult = createMockContext({
		mode: "rpc",
		hasUI: true,
		model: MODEL,
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch,
			getEntries: getBranch,
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
			getProvider: () => ({
				streamSimple: (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
					lastStreamOptions = options;
					return streamOf(chunks);
				},
			}),
			getAll: () => [MODEL],
			getAvailable: () => [MODEL],
			isUsingOAuth: () => false,
		},
		...overrides,
	});
	// Note: do not spread ctxResult — its editorText/footer getters must stay live.
	return Object.assign(ctxResult, {
		getLastStreamOptions: () => lastStreamOptions,
	});
}

function btwEvents(notifications: Array<{ message: string }>) {
	return notifications
		.filter((n) => n.message.startsWith(BTW_EVENT_PREFIX))
		.map((n) => JSON.parse(n.message.slice(BTW_EVENT_PREFIX.length)));
}

test("/btw <question> in RPC mode answers headlessly and persists a custom entry", async () => {
	const mock = createMockPi({ thinkingLevel: "medium" });
	btw(mock.pi);
	const { ctx, notifications } = standaloneContext(["side ", "answer"], {}, mock);

	await mock.commands.get("btw")?.handler("what is the main task?", ctx);

	const events = btwEvents(notifications);
	assert.deepEqual(
		events.map((event) => event.event).filter((kind) => kind !== "delta"),
		["accepted", "running", "completed"],
	);
	const terminal = events.at(-1);
	assert.equal(terminal.text, "side answer");
	assert.equal(terminal.context.mode, "branch");
	assert.equal(terminal.context.leafId, "leaf-9");
	assert.equal(terminal.model.id, "side-model");

	assert.equal(mock.entries.length, 1);
	const entry = mock.entries[0]?.data as BtwEntryData;
	assert.equal(entry.status, "completed");
	assert.equal(entry.answer, "side answer");
	// Isolation: nothing entered the LLM context or the main run state.
	assert.equal(mock.sentMessages.length, 0);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.equal(mock.setModels.length, 0);
	assert.equal(mock.thinkingLevels.length, 0);
});

test("/btw without a question in RPC mode fails with question_required", async () => {
	const mock = createMockPi();
	btw(mock.pi);
	const { ctx, notifications } = standaloneContext([], {}, mock);

	await mock.commands.get("btw")?.handler("", ctx);

	const events = btwEvents(notifications);
	assert.equal(events.length, 1);
	assert.equal(events[0]?.event, "failed");
	assert.equal(events[0]?.error, "question_required");
	assert.equal(mock.entries.length, 0);
});

test("/btw:cancel aborts the latest in-flight headless question", async () => {
	const mock = createMockPi({ thinkingLevel: "medium" });
	btw(mock.pi);
	const hangingBranch = () => [
		...mock.entries.map((entry) => ({
			type: "custom",
			customType: entry.customType,
			data: entry.data,
		})),
	];
	const ctxResult = createMockContext({
		mode: "rpc",
		hasUI: true,
		model: MODEL,
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: hangingBranch,
			getEntries: hangingBranch,
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
			getProvider: () => ({
				streamSimple: (_m: unknown, _c: unknown, options?: { signal?: AbortSignal }) =>
					hangingStream(options?.signal),
			}),
			getAll: () => [MODEL],
		},
	});
	const runPromise = mock.commands.get("btw")?.handler("hang please", ctxResult.ctx);
	// The "running" event fires right after the run registers its controller.
	await waitFor(() =>
		btwEvents(ctxResult.notifications).some((event) => event.event === "running"),
	);

	await mock.commands.get("btw:cancel")?.handler("", ctxResult.ctx);
	await runPromise;

	const events = btwEvents(ctxResult.notifications);
	assert.equal(events.at(-1)?.event, "cancelled");
	const entry = mock.entries[0]?.data as BtwEntryData;
	assert.equal(entry.status, "cancelled");
	assert.equal(entry.answer, "");
});

test("session_shutdown aborts in-flight runs and writes cancelled entries", async () => {
	const mock = createMockPi({ thinkingLevel: "medium" });
	btw(mock.pi);
	const hangingBranch = () => [
		...mock.entries.map((entry) => ({
			type: "custom",
			customType: entry.customType,
			data: entry.data,
		})),
	];
	const ctxResult = createMockContext({
		mode: "rpc",
		hasUI: true,
		model: MODEL,
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: hangingBranch,
			getEntries: hangingBranch,
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
			getProvider: () => ({
				streamSimple: (_m: unknown, _c: unknown, options?: { signal?: AbortSignal }) =>
					hangingStream(options?.signal),
			}),
			getAll: () => [MODEL],
		},
	});
	const runPromise = mock.commands.get("btw")?.handler("hang please", ctxResult.ctx);
	await waitFor(() =>
		btwEvents(ctxResult.notifications).some((event) => event.event === "running"),
	);

	const shutdownHandlers = mock.events.get("session_shutdown");
	assert.ok(shutdownHandlers && shutdownHandlers.length > 0);
	await shutdownHandlers[0]?.({}, ctxResult.ctx);
	await runPromise;

	const entry = mock.entries[0]?.data as BtwEntryData;
	assert.equal(entry.status, "cancelled");
});

test("session_start rebuilds resumable threads from persisted btw entries", async () => {
	const mock = createMockPi({ thinkingLevel: "medium" });
	const menuSnapshots: Array<Array<{ id: string; title: string }>> = [];
	btw(mock.pi, {
		showCommandMenu: (async (
			_pi: unknown,
			_ctx: unknown,
			threads: Array<{ id: string; title: string; questionCount: number }>,
		) => {
			menuSnapshots.push(threads.map((thread) => ({ id: thread.id, title: thread.title })));
			return "closed";
		}) as never,
	});

	const persisted: BtwEntryData = {
		v: 1,
		id: "btw-aaaabbbbcccc",
		threadId: "btw-aaaabbbbcccc",
		question: "persisted question",
		status: "completed",
		answer: "persisted answer",
		error: null,
		model: { provider: "test", id: "side-model" },
		thinkingLevel: "high",
		usage: null,
		context: { mode: "branch", entries: 2, chars: 40, truncated: false },
		createdAt: "2026-09-14T01:00:00.000Z",
		completedAt: "2026-09-14T01:00:01.000Z",
		host: "rpc",
	};
	const { ctx } = createMockContext({
		mode: "tui",
		hasUI: true,
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => [{ type: "custom", customType: "btw", data: persisted }],
			getEntries: () => [{ type: "custom", customType: "btw", data: persisted }],
		},
	});

	const startHandlers = mock.events.get("session_start");
	assert.ok(startHandlers && startHandlers.length > 0);
	await startHandlers[0]?.({}, ctx);

	// The rebuilt thread appears in the /btw resume menu.
	await mock.commands.get("btw")?.handler("", ctx);
	assert.deepEqual(menuSnapshots, [[{ id: "btw-aaaabbbbcccc", title: "persisted question" }]]);
});

test("/btw:history in RPC mode emits a history event with recent entries", async () => {
	const mock = createMockPi({ thinkingLevel: "medium" });
	btw(mock.pi);
	const { ctx, notifications } = standaloneContext(["one"], {}, mock);

	await mock.commands.get("btw")?.handler("first question", ctx);
	const before = btwEvents(notifications).length;
	await mock.commands.get("btw:history")?.handler("", ctx);

	const events = btwEvents(notifications).slice(before);
	assert.equal(events.length, 1);
	assert.equal(events[0]?.event, "history");
	assert.equal(events[0]?.items.length, 1);
	assert.equal(events[0]?.items[0].question, "first question");
});

test("/btw:follow reuses the same thread for headless follow-ups", async () => {
	const mock = createMockPi({ thinkingLevel: "medium" });
	btw(mock.pi);
	const { ctx } = standaloneContext(["first answer"], {}, mock);

	await mock.commands.get("btw")?.handler("first question", ctx);
	const first = mock.entries[0]?.data as BtwEntryData;

	await mock.commands.get("btw:follow")?.handler(`${first.id} second question`, ctx);

	assert.equal(mock.entries.length, 2);
	const second = mock.entries[1]?.data as BtwEntryData;
	assert.equal(second.threadId, first.id);
	assert.notEqual(second.id, first.id);
	assert.equal(second.question, "second question");
});

test("/btw:follow with an unknown thread fails visibly", async () => {
	const mock = createMockPi();
	btw(mock.pi);
	const { ctx, notifications } = standaloneContext([], {}, mock);

	await mock.commands.get("btw:follow")?.handler("btw-missing question", ctx);

	const events = btwEvents(notifications);
	assert.equal(events.at(-1)?.event, "failed");
	assert.match(events.at(-1)?.error ?? "", /No \/btw thread found/);
	assert.equal(mock.entries.length, 0);
});

test("/btw:bring loads the latest completed answer into the editor", async () => {
	const mock = createMockPi({ thinkingLevel: "medium" });
	btw(mock.pi);
	const standalone = standaloneContext(["the answer text"], {}, mock);
	await mock.commands.get("btw")?.handler("question", standalone.ctx);

	await mock.commands.get("btw:bring")?.handler("", standalone.ctx);
	assert.equal(standalone.editorText, "the answer text");
});

test("/btw <question> in TUI mode routes to the inline card flow", async () => {
	const mock = createMockPi({ thinkingLevel: "medium" });
	const inlineCalls: Array<{ question: string; stateId: string }> = [];
	btw(mock.pi, {
		runInline: (async (_pi: unknown, _ctx: unknown, question: string, state: { id: string }) => {
			inlineCalls.push({ question, stateId: state.id });
		}) as never,
	});
	const { ctx } = createMockContext({
		mode: "tui",
		hasUI: true,
		model: MODEL,
		sessionManager: {
			getSessionId: () => "s",
			getBranch: () => [{ type: "message", id: "l1", message: { role: "user", content: "bg" } }],
			getEntries: () => [],
		},
	});

	await mock.commands.get("btw")?.handler("inline question", ctx);

	assert.equal(inlineCalls.length, 1);
	assert.equal(inlineCalls[0]?.question, "inline question");
	assert.match(inlineCalls[0]?.stateId, /^btw-[0-9a-f]{12}$/);
});

test("/btw:thread in RPC mode fails with tui_required", async () => {
	const mock = createMockPi();
	btw(mock.pi);
	const { ctx, notifications } = standaloneContext([], {}, mock);

	await mock.commands.get("btw:thread")?.handler("question", ctx);

	const events = btwEvents(notifications);
	assert.equal(events.at(-1)?.event, "failed");
	assert.equal(events.at(-1)?.error, "tui_required");
});

async function waitFor(condition: () => boolean, attempts = 500): Promise<void> {
	for (let index = 0; index < attempts; index += 1) {
		if (condition()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	throw new Error("waitFor condition was not met");
}
