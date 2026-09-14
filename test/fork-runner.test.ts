import assert from "node:assert/strict";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { test } from "vitest";
import type { BtwEntryData } from "../src/btw-entries.js";
import { BtwStateStore } from "../src/btw-state.js";
import { BTW_EVENT_PREFIX } from "../src/host-events.js";
import { runSideQuestion } from "../src/side-runner.js";
import { createSideThread, streamSideThreadTurn } from "../src/side-thread.js";
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
			input: 11,
			output: 7,
			cacheRead: 3,
			cacheWrite: 2,
			totalTokens: 18,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0042 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** streamSimple fake: emits start + the given deltas + done with the answer. */
function fakeStreamSimple(chunks: string[], options?: { hang?: boolean }) {
	return (_model: unknown, _context: unknown, streamOptions?: { signal?: AbortSignal }) => {
		const stream = createAssistantMessageEventStream();
		const partial = assistantMessage("");
		stream.push({ type: "start", partial });
		if (options?.hang) {
			// Never completes on its own; aborting the signal ends the stream.
			streamOptions?.signal?.addEventListener("abort", () => {
				stream.push({ type: "error", reason: "aborted", error: assistantMessage("") });
			});
			return stream;
		}
		for (const chunk of chunks) {
			stream.push({ type: "text_delta", contentIndex: 0, delta: chunk, partial });
		}
		stream.push({ type: "done", reason: "stop", message: assistantMessage(chunks.join("")) });
		return stream;
	};
}

test("streamSideThreadTurn streams deltas and records the answered turn", async () => {
	const thread = createSideThread("ctx");
	const deltas: string[] = [];
	const result = await streamSideThreadTurn({
		thread,
		model: MODEL,
		question: "q1",
		thinkingLevel: "off",
		auth: { apiKey: "k" },
		streamSimple: fakeStreamSimple(["hello", " ", "world"]) as never,
		onTextDelta: (accumulated) => deltas.push(accumulated),
	});
	assert.equal(result.kind, "answered");
	assert.deepEqual(deltas, ["hello", "hello ", "hello world"]);
	assert.equal(thread.turns.length, 1);
	assert.equal(thread.turns[0]?.kind, "answered");
});

test("streamSideThreadTurn reports provider errors without recording a turn", async () => {
	const thread = createSideThread("ctx");
	const result = await streamSideThreadTurn({
		thread,
		model: MODEL,
		question: "q1",
		thinkingLevel: "off",
		auth: { apiKey: "k" },
		streamSimple: (() => {
			const stream = createAssistantMessageEventStream();
			const partial = assistantMessage("");
			stream.push({ type: "start", partial });
			const error = {
				...assistantMessage(""),
				stopReason: "error",
				errorMessage: "boom",
			} as AssistantMessage;
			stream.push({ type: "error", reason: "error", error });
			return stream;
		}) as never as never,
	});
	assert.equal(result.kind, "error");
	assert.equal(thread.turns.length, 0);
});

type CapturedEvent = {
	event: string;
	text?: string;
	usage?: unknown;
	context?: unknown;
};

function readBtwEvents(notifications: Array<{ message: string; level?: string }>): CapturedEvent[] {
	return notifications
		.filter((n) => n.message.startsWith(BTW_EVENT_PREFIX))
		.map((n) => JSON.parse(n.message.slice(BTW_EVENT_PREFIX.length)) as CapturedEvent);
}

function setupRpcRun(chunks: string[], options?: { hang?: boolean }) {
	const mock = createMockPi({ thinkingLevel: "medium" });
	const store = new BtwStateStore();
	const branch = [
		{
			type: "message",
			id: "leaf-1",
			message: { role: "user", content: "main conversation background" },
		},
	];
	const { ctx, notifications } = createMockContext({
		mode: "rpc",
		hasUI: true,
		model: MODEL,
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => branch,
			getEntries: () => [],
		},
	});
	const state = {
		id: "btw-fixedid0001",
		thread: createSideThread("main conversation background"),
		thinkingLevel: "medium" as const,
		contextInfo: {
			mode: "branch" as const,
			entries: 1,
			chars: 28,
			truncated: false,
			leafId: "leaf-1",
		},
		createdAt: 1000,
		updatedAt: 1000,
	};
	return { mock, store, ctx, notifications, state, chunks, options };
}

test("runSideQuestion emits the full event sequence and persists one completed entry", async () => {
	const { mock, store, ctx, notifications, state } = setupRpcRun(["partial ", "answer"]);
	const entry = await runSideQuestion({
		pi: mock.pi,
		ctx,
		question: "what is this?",
		state,
		selected: { model: MODEL, auth: { apiKey: "k" } },
		thinkingLevel: "medium",
		host: "rpc",
		contextInfo: state.contextInfo,
		activeRuns: store.activeRuns,
		streamSimple: fakeStreamSimple(["partial ", "answer"]) as never,
	});

	assert.equal(entry.status, "completed");
	assert.equal(entry.answer, "partial answer");
	assert.equal(entry.id, "btw-fixedid0001");
	assert.equal(entry.threadId, "btw-fixedid0001");
	assert.deepEqual(entry.usage, {
		input: 11,
		output: 7,
		cacheRead: 3,
		cacheWrite: 2,
		cost: 0.0042,
	});
	assert.equal(entry.host, "rpc");
	assert.deepEqual(entry.model, { provider: "test", id: "side-model" });

	// Exactly one custom entry, no LLM-context writes of any kind.
	assert.equal(mock.entries.length, 1);
	assert.equal(mock.entries[0]?.customType, "btw");
	assert.equal(mock.sentMessages.length, 0);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.equal(mock.setModels.length, 0);

	const events = readBtwEvents(notifications);
	const kinds = events.map((event) => event.event);
	assert.deepEqual(
		kinds.filter((k) => k !== "delta"),
		["accepted", "running", "completed"],
	);
	const terminal = events.at(-1);
	assert.ok(terminal);
	assert.equal(terminal.text, "partial answer");
	assert.deepEqual(terminal.usage, entry.usage);
	assert.deepEqual(terminal.context, entry.context);
});

test("runSideQuestion throttles delta events to at most four per second", async () => {
	const { mock, store, ctx, state, notifications } = setupRpcRun([]);
	const deltas: string[] = [];
	// 20 deltas at the same instant: only the first may pass the throttle.
	const many = Array.from({ length: 20 }, (_, index) => `c${index} `);
	await runSideQuestion({
		pi: mock.pi,
		ctx,
		question: "q",
		state,
		selected: { model: MODEL, auth: { apiKey: "k" } },
		thinkingLevel: "medium",
		host: "rpc",
		contextInfo: state.contextInfo,
		activeRuns: store.activeRuns,
		streamSimple: fakeStreamSimple(many) as never,
		onDelta: (accumulated) => deltas.push(accumulated),
		now: () => 1_000,
	});
	const events = readBtwEvents(notifications);
	const deltaEvents = events.filter((event) => event.event === "delta");
	assert.equal(deltaEvents.length, 1);
	assert.equal(deltas.length, 20, "onDelta rendering stays unthrottled");
});

test("runSideQuestion aborts via the active-run controller and persists cancelled", async () => {
	const { mock, store, ctx, state, notifications } = setupRpcRun([], { hang: true });
	const promise = runSideQuestion({
		pi: mock.pi,
		ctx,
		question: "hang",
		state,
		selected: { model: MODEL, auth: { apiKey: "k" } },
		thinkingLevel: "medium",
		host: "rpc",
		contextInfo: state.contextInfo,
		activeRuns: store.activeRuns,
		streamSimple: fakeStreamSimple([], { hang: true }) as never,
	});
	// Let the run register before cancelling.
	await Promise.resolve();
	const run = [...store.activeRuns.values()][0];
	assert.ok(run);
	run.controller.abort();
	const entry = await promise;

	assert.equal(entry.status, "cancelled");
	assert.equal(entry.answer, "", "cancelled entries never leak partial answers");
	assert.equal(store.activeRuns.size, 0);
	const events = readBtwEvents(notifications);
	assert.equal(events.at(-1)?.event, "cancelled");
	assert.equal(events.at(-1)?.text, undefined);
	const persisted = mock.entries[0]?.data as BtwEntryData;
	assert.equal(persisted.status, "cancelled");
});

test("runSideQuestion uses a fresh turn id for follow-ups on an existing thread", async () => {
	const { mock, store, ctx, state } = setupRpcRun(["first"]);
	state.thread.turns.push({
		kind: "answered",
		question: "earlier",
		answer: "earlier answer",
		response: assistantMessage("earlier answer"),
	});
	const entry = await runSideQuestion({
		pi: mock.pi,
		ctx,
		question: "follow-up",
		state,
		selected: { model: MODEL, auth: { apiKey: "k" } },
		thinkingLevel: "medium",
		host: "rpc",
		contextInfo: state.contextInfo,
		activeRuns: store.activeRuns,
		streamSimple: fakeStreamSimple(["second"]) as never,
	});
	assert.notEqual(entry.id, state.id);
	assert.equal(entry.threadId, state.id);
});
