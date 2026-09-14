import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	BtwEntryContextInfo,
	BtwEntryData,
	BtwEntryStatus,
	BtwEntryUsage,
} from "./btw-entries.js";

// Host event contract v1 (see docs/btw-plugin/00-PLAN.md §4.3). Emitted only in
// RPC mode via ctx.ui.notify with the BTW_EVENT: prefix; the host driver parses
// the prefix and routes the JSON payload instead of showing a notification.
export const BTW_EVENT_PREFIX = "BTW_EVENT:";
export const BTW_EVENT_VERSION = 1;

export type BtwHostEventKind =
	| "accepted"
	| "running"
	| "delta"
	| "completed"
	| "failed"
	| "cancelled"
	| "history";

export interface BtwHostEvent {
	v: typeof BTW_EVENT_VERSION;
	event: BtwHostEventKind;
	id: string;
	question?: string;
	/** Delta chunk for "delta"; full answer for terminal events. */
	text?: string;
	error?: string;
	usage?: BtwEntryUsage | null;
	context?: BtwEntryContextInfo;
	model?: { provider: string; id: string } | null;
	at: string;
	/** Only for "history": recent terminal entries, newest first. */
	items?: BtwEntryData[];
}

type NotifyLevel = Parameters<ExtensionCommandContext["ui"]["notify"]>[1];

export function emitBtwHostEvent(
	ctx: ExtensionCommandContext,
	event: Omit<BtwHostEvent, "v" | "at"> & { at?: string },
): void {
	if (ctx.mode !== "rpc") return;
	const payload: BtwHostEvent = {
		v: BTW_EVENT_VERSION,
		at: event.at ?? new Date().toISOString(),
		...event,
	};
	try {
		ctx.ui.notify(BTW_EVENT_PREFIX + JSON.stringify(payload), "info" satisfies NotifyLevel);
	} catch {
		// The RPC client may already be gone; events are best-effort, entries are durable.
	}
}

/** Terminal host event mirroring the persisted entry exactly (contract §4.3). */
export function terminalEventFromEntry(ctx: ExtensionCommandContext, data: BtwEntryData): void {
	emitBtwHostEvent(ctx, {
		event: data.status as BtwEntryStatus,
		id: data.id,
		question: data.question,
		text: data.status === "cancelled" ? undefined : data.answer,
		error: data.error ?? undefined,
		usage: data.usage,
		context: data.context,
		model: data.model,
	});
}

/**
 * Rate-limit delta events to at most `minIntervalMs` between emissions
 * (contract: ≤4 per second). The final state is always delivered by the
 * terminal event, so dropped deltas lose nothing.
 */
export class DeltaThrottle {
	private lastEmittedAt = Number.NEGATIVE_INFINITY;
	constructor(
		private readonly minIntervalMs = 250,
		private readonly now: () => number = Date.now,
	) {}

	/** Returns true when this delta may be emitted now. */
	allow(): boolean {
		const current = this.now();
		if (current - this.lastEmittedAt < this.minIntervalMs) return false;
		this.lastEmittedAt = current;
		return true;
	}
}
