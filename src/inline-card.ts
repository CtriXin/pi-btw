import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Key, matchesKey, Text } from "@earendil-works/pi-tui";
import type { BtwStateStore, BtwThreadState } from "./btw-state.js";
import { DeltaThrottle } from "./host-events.js";
import { runStandaloneBtw, type StandaloneBtwDeps } from "./standalone.js";
import { sanitizeSingleLine } from "./text.js";

// The streaming card intentionally caps its body so a long answer cannot push
// the editor off screen; the full answer remains visible in the card after
// completion until the user submits another input or presses Escape.
// The transcript entry remains the durable record and is readable via /btw:open.
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
	box.addChild(
		new Text(
			theme.fg("accent", theme.bold(`/btw ${clippedTitle}`)) +
				(finished ? theme.fg("dim", "  [Esc]收起") : ""),
			0,
			0,
		),
	);
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
	let completed = false;
	let clearRequested = false;
	let unsubscribeInput: (() => void) | undefined;
	const clearWidget = () => {
		if (clearRequested) return;
		clearRequested = true;
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		try {
			ctx.ui.setWidget(widgetKey, undefined);
		} catch {
			// Best effort cleanup when the TUI context is already stale.
		}
	};
	const paint = (finished: boolean) => {
		try {
			ctx.ui.setWidget(widgetKey, (_tui, theme) =>
				createInlineCardComponent(theme, question, accumulated, finished),
			);
		} catch {
			// The extension context may be replaced mid-run; the entry is the durable record.
		}
	};
	unsubscribeInput = ctx.ui.onTerminalInput?.((data) => {
		if (!completed) return undefined;
		// Escape is Pi's abort key: while the main run streams, it cancels that run
		// (interactive-mode `onEscape` -> `restoreQueuedMessagesToEditor({abort:true})`).
		// The finished card advertises [Esc] as "collapse", so swallow that key here --
		// dismissing the card must never abort the user's main task. A second Escape,
		// once the card is gone, reaches Pi and aborts as usual. Every other key falls
		// through unchanged so typing both clears the card and reaches the editor.
		const dismissedByEscape = matchesKey(data, Key.escape);
		clearWidget();
		return dismissedByEscape ? { consume: true } : undefined;
	});
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
		// Keep the completed answer visible in the inline card. The next terminal
		// input, including Escape or a new prompt, clears it at the user's pace.
		accumulated = entry.answer;
		completed = true;
		paint(true);
	} finally {
		if (!completed) clearWidget();
	}
}
