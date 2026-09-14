import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text } from "@earendil-works/pi-tui";
import type { BtwStateStore, BtwThreadState } from "./btw-state.js";
import { DeltaThrottle } from "./host-events.js";
import { runStandaloneBtw, type StandaloneBtwDeps } from "./standalone.js";
import { sanitizeSingleLine } from "./text.js";

// The streaming card intentionally caps its body so a long answer cannot push
// the editor off screen; the full answer lands in the transcript entry and is
// readable via /btw:open.
const CARD_MAX_BODY_CHARS = 1500;
const CARD_TITLE_CHARS = 96;

export function createInlineCardComponent(
	theme: Theme,
	question: string,
	accumulated: string,
	finished: boolean,
): Component {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	const title = sanitizeSingleLine(question);
	const clippedTitle =
		title.length > CARD_TITLE_CHARS ? `${title.slice(0, CARD_TITLE_CHARS - 1)}…` : title;
	box.addChild(new Text(theme.fg("accent", theme.bold(`/btw ${clippedTitle}`)), 0, 0));
	let body = accumulated.trim();
	if (!body) {
		box.addChild(new Text(theme.fg("dim", "Answering…"), 0, 0));
	} else {
		if (body.length > CARD_MAX_BODY_CHARS) {
			body = `…${body.slice(-CARD_MAX_BODY_CHARS)}`;
		}
		box.addChild(new Text(finished ? body : theme.fg("customMessageText", body), 0, 0));
	}
	return box;
}

export interface InlineBtwDeps extends Omit<StandaloneBtwDeps, "onDelta"> {}

/**
 * Grok-style inline flow for `/btw <question>` in TUI mode: the editor stays
 * usable, a bordered widget above it shows the streaming answer, and the final
 * answer persists as a transcript entry when the widget clears.
 */
export async function runInlineBtw(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	question: string,
	state: BtwThreadState,
	store: BtwStateStore,
	deps: InlineBtwDeps,
): Promise<void> {
	const widgetKey = `btw:${state.id}`;
	const throttle = new DeltaThrottle(250, deps.now ?? Date.now);
	let accumulated = "";
	const paint = (finished: boolean) => {
		try {
			ctx.ui.setWidget(widgetKey, (_tui, theme) =>
				createInlineCardComponent(theme, question, accumulated, finished),
			);
		} catch {
			// The extension context may be replaced mid-run; the entry is the durable record.
		}
	};
	paint(false);
	try {
		const entry = await runStandaloneBtw(pi, ctx, question, state, store, "tui", {
			...deps,
			onDelta: (text) => {
				accumulated = text;
				if (throttle.allow()) paint(false);
			},
		});
		if (!entry) return;
		// Final paint ensures the tail beyond the last throttled frame is visible
		// before the widget hands over to the persistent transcript entry.
		accumulated = entry.answer;
		paint(true);
	} finally {
		try {
			ctx.ui.setWidget(widgetKey, undefined);
		} catch {
			// Best effort cleanup.
		}
	}
}
