import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildConversationContextWithMeta } from "./btw-context.js";
import {
	type BtwEntryContextInfo,
	type BtwEntryData,
	type BtwEntryHost,
	newBtwId,
} from "./btw-entries.js";
import type { BtwStateStore, BtwThreadState, ResolvedBtwModel } from "./btw-state.js";
import { emitBtwHostEvent } from "./host-events.js";
import type { BtwSettings } from "./settings.js";
import { runSideQuestion } from "./side-runner.js";
import { createSideThread, type StreamSimpleFunction } from "./side-thread.js";
import { sanitizeSingleLine } from "./text.js";

export interface StandaloneBtwDeps {
	settings: BtwSettings;
	/** UI-free model resolution; returns undefined when no model is usable. */
	resolveModel: () => Promise<ResolvedBtwModel | undefined>;
	streamSimple: StreamSimpleFunction;
	/** Unthrottled accumulated-text callback for live rendering (TUI card). */
	onDelta?: (accumulated: string) => void;
	now?: () => number;
}

/**
 * Create a fresh side thread for a standalone (non-fullscreen) question,
 * capturing the current main-session branch as background context.
 */
export function prepareStandaloneState(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	settings: BtwSettings,
	store: BtwStateStore,
	now: () => number = Date.now,
): BtwThreadState {
	const branch = ctx.sessionManager.getBranch();
	const { text, info } = buildConversationContextWithMeta(branch);
	const createdAt = now();
	const state: BtwThreadState = {
		id: newBtwId(),
		thread: createSideThread(text),
		thinkingLevel: settings.thinkingLevel ?? pi.getThinkingLevel(),
		contextInfo: info,
		createdAt,
		updatedAt: createdAt,
	};
	store.rememberThread(state);
	return state;
}

/**
 * Run a standalone side question (one shot or follow-up on an existing
 * thread) outside the fullscreen workspace. Used by the TUI inline card
 * (host "tui") and the headless RPC flow (host "rpc"); the difference is only
 * rendering — events and persistence are identical.
 */
export async function runStandaloneBtw(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	question: string,
	state: BtwThreadState,
	store: BtwStateStore,
	host: BtwEntryHost,
	deps: StandaloneBtwDeps,
): Promise<BtwEntryData | undefined> {
	const selected = await deps.resolveModel();
	if (!selected) {
		if (host === "rpc") {
			emitBtwHostEvent(ctx, {
				event: "failed",
				id: state.id,
				question,
				error: "model_unavailable",
				model: null,
			});
		} else {
			try {
				ctx.ui.notify("No available model for /btw", "error");
			} catch {
				// Async continuations may finish after their ExtensionContext is replaced.
			}
		}
		return undefined;
	}

	const thinkingLevel = clampThinkingLevel(
		selected.model,
		state.thinkingLevel ?? deps.settings.thinkingLevel ?? pi.getThinkingLevel(),
	);
	const contextInfo: BtwEntryContextInfo = state.contextInfo ?? {
		mode: state.thread.conversationContext ? "branch" : "none",
		entries: 0,
		chars: state.thread.conversationContext.length,
		truncated: false,
	};
	return runSideQuestion({
		pi,
		ctx,
		question,
		state,
		selected,
		thinkingLevel,
		host,
		contextInfo,
		activeRuns: store.activeRuns,
		streamSimple: deps.streamSimple,
		onDelta: deps.onDelta,
		now: deps.now,
	});
}

/** Parse "/btw:follow <id> <question>" args into a thread reference + question. */
export function parseFollowArgs(args: string): { ref: string; question: string } | undefined {
	const trimmed = args.trim();
	if (!trimmed) return undefined;
	const firstSpace = trimmed.search(/\s/);
	if (firstSpace < 0) return { ref: trimmed, question: "" };
	return { ref: trimmed.slice(0, firstSpace), question: trimmed.slice(firstSpace + 1).trim() };
}

export function formatEntryTitle(question: string): string {
	return sanitizeSingleLine(question) || "Untitled side thread";
}
