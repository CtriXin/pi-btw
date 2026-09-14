import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	appendBtwEntry,
	type BtwEntryContextInfo,
	type BtwEntryData,
	type BtwEntryHost,
	type BtwEntryUsage,
	newBtwId,
} from "./btw-entries.js";
import type { ActiveBtwRun, BtwThreadState, ResolvedBtwModel } from "./btw-state.js";
import { DeltaThrottle, emitBtwHostEvent, terminalEventFromEntry } from "./host-events.js";
import {
	type BtwThinkingLevel,
	type StreamSimpleFunction,
	streamSideThreadTurn,
} from "./side-thread.js";
import { sanitizeSingleLine } from "./text.js";

export interface RunSideQuestionOptions {
	pi: ExtensionAPI;
	ctx: ExtensionCommandContext;
	question: string;
	state: BtwThreadState;
	selected: ResolvedBtwModel;
	thinkingLevel: BtwThinkingLevel;
	host: BtwEntryHost;
	contextInfo: BtwEntryContextInfo;
	activeRuns: Map<string, ActiveBtwRun>;
	streamSimple: StreamSimpleFunction;
	/** Called with the accumulated answer on every streamed delta (unthrottled). */
	onDelta?: (accumulated: string) => void;
	now?: () => number;
}

/**
 * Run one side-question turn end to end: host events, streaming, thread
 * bookkeeping, cancellation, and terminal-state persistence. Shared by the
 * headless (RPC) flow and the TUI inline card; the fullscreen thread keeps its
 * own upstream loop.
 *
 * Isolation contract: this never calls pi.sendMessage / sendUserMessage /
 * appendCustomMessageEntry, never touches ctx.abort, and never changes the main
 * model or thinking level. The only session write is one terminal custom entry.
 */
export async function runSideQuestion({
	pi,
	ctx,
	question,
	state,
	selected,
	thinkingLevel,
	host,
	contextInfo,
	activeRuns,
	streamSimple,
	onDelta,
	now = Date.now,
}: RunSideQuestionOptions): Promise<BtwEntryData> {
	const isFirstTurn = state.thread.turns.length === 0;
	const turnId = isFirstTurn ? state.id : newBtwId();
	const createdAt = new Date(now()).toISOString();
	const controller = new AbortController();
	const run: ActiveBtwRun = {
		id: turnId,
		threadId: state.id,
		question,
		host,
		controller,
		startedAt: now(),
	};
	activeRuns.set(turnId, run);
	const abortFromCtx = () => controller.abort();
	if (ctx.signal) {
		if (ctx.signal.aborted) controller.abort();
		else ctx.signal.addEventListener("abort", abortFromCtx, { once: true });
	}

	const modelInfo = { provider: selected.model.provider, id: selected.model.id };
	emitBtwHostEvent(ctx, { event: "accepted", id: turnId, question });
	emitBtwHostEvent(ctx, { event: "running", id: turnId, question, model: modelInfo });

	const throttle = new DeltaThrottle(250, now);
	try {
		const result = await streamSideThreadTurn({
			thread: state.thread,
			model: selected.model,
			question,
			thinkingLevel,
			auth: selected.auth,
			signal: controller.signal,
			streamSimple,
			sessionId: readBtwSessionId(ctx),
			onTextDelta: (accumulated, delta) => {
				onDelta?.(accumulated);
				if (throttle.allow()) {
					emitBtwHostEvent(ctx, { event: "delta", id: turnId, text: delta });
				}
			},
		});

		state.title ||= sanitizeSingleLine(question) || "Untitled side thread";
		state.updatedAt = now();
		state.thinkingLevel = thinkingLevel;

		const data = buildTerminalEntry({
			result,
			turnId,
			state,
			question,
			host,
			contextInfo,
			modelInfo,
			thinkingLevel,
			createdAt,
			now,
		});
		appendBtwEntry(pi, data);
		terminalEventFromEntry(ctx, data);
		return data;
	} finally {
		if (ctx.signal) ctx.signal.removeEventListener("abort", abortFromCtx);
		activeRuns.delete(turnId);
	}
}

function buildTerminalEntry({
	result,
	turnId,
	state,
	question,
	host,
	contextInfo,
	modelInfo,
	thinkingLevel,
	createdAt,
	now,
}: {
	result: Awaited<ReturnType<typeof streamSideThreadTurn>>;
	turnId: string;
	state: BtwThreadState;
	question: string;
	host: BtwEntryHost;
	contextInfo: BtwEntryContextInfo;
	modelInfo: { provider: string; id: string };
	thinkingLevel: BtwThinkingLevel;
	createdAt: string;
	now: () => number;
}): BtwEntryData {
	const base = {
		v: 1 as const,
		id: turnId,
		threadId: state.id,
		question,
		model: modelInfo,
		thinkingLevel,
		context: contextInfo,
		createdAt,
		completedAt: new Date(now()).toISOString(),
		host,
	};
	if (result.kind === "answered") {
		return {
			...base,
			status: "completed",
			answer: result.answer,
			error: null,
			usage: extractUsage(result.response),
		};
	}
	if (result.kind === "aborted") {
		// Cancelled turns intentionally carry no answer: nothing leaks into history.
		return { ...base, status: "cancelled", answer: "", error: "cancelled", usage: null };
	}
	return { ...base, status: "failed", answer: "", error: result.message, usage: null };
}

function extractUsage(response: { usage?: unknown }): BtwEntryUsage | null {
	const usage = response.usage as
		| {
				input?: number;
				output?: number;
				cacheRead?: number;
				cacheWrite?: number;
				cost?: { total?: number };
		  }
		| undefined;
	if (!usage) return null;
	return {
		input: usage.input ?? 0,
		output: usage.output ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
		cost: typeof usage.cost?.total === "number" ? usage.cost.total : null,
	};
}

function readBtwSessionId(ctx: ExtensionCommandContext): string | undefined {
	const getSessionId = ctx.sessionManager.getSessionId;
	if (typeof getSessionId !== "function") return undefined;
	const sessionId = getSessionId.call(ctx.sessionManager);
	return sessionId.length > 0 ? sessionId : undefined;
}
