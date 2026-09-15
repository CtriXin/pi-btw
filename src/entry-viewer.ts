import { getMarkdownTheme, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Key,
	Markdown,
	matchesKey,
	ScrollView,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { SideThreadTurn } from "./side-thread.js";
import { buildTranscriptComponents, renderTranscriptLines } from "./transcript-pager.js";

const OVERLAY_VERTICAL_MARGIN = 4;

/**
 * Read-only overlay viewer for one persisted /btw thread (`/btw:open`).
 * Scrolls with ↑/↓/PgUp/PgDn/Home/End; Esc or q closes. This is the only /btw
 * surface that takes input focus, and only on explicit user request.
 */
export class BtwEntryViewer implements Component, Focusable {
	private readonly transcriptComponents: Component[];
	private readonly scrollView: ScrollView;
	private isFocused = false;
	private finished = false;
	private lastContentLineCount = 0;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		content: readonly SideThreadTurn[] | string,
		private readonly title: string,
		private readonly onClose: () => void,
	) {
		this.transcriptComponents =
			typeof content === "string"
				? [new Markdown(content, 1, 1, getMarkdownTheme())]
				: buildTranscriptComponents(content, theme);
		const transcript: Component = {
			render: (width) => {
				const lines = renderTranscriptLines(this.transcriptComponents, width);
				this.lastContentLineCount = lines.length;
				return lines;
			},
			invalidate: () => {
				for (const component of this.transcriptComponents) component.invalidate();
			},
		};
		this.scrollView = new ScrollView(transcript, { follow: "none", primary: true });
	}

	get focused(): boolean {
		return this.isFocused;
	}

	set focused(value: boolean) {
		this.isFocused = value;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const safeWidth = Math.max(1, width);
		const frameWidth = safeWidth;
		const innerWidth = Math.max(0, frameWidth - 2);
		const viewportHeight = Math.max(1, this.tui.terminal.rows - OVERLAY_VERTICAL_MARGIN - 4);
		const contentLines = renderTranscriptLines(this.transcriptComponents, innerWidth);
		this.lastContentLineCount = contentLines.length;
		this.scrollView.updateLayout(contentLines.length, viewportHeight, () =>
			this.tui.requestRender(),
		);
		const title = truncateToWidth(`─ /btw ${this.title} `, innerWidth, "");
		const position = `${this.scrollView.scrollTop + 1}-${Math.min(
			this.scrollView.scrollTop + viewportHeight,
			this.lastContentLineCount,
		)}/${this.lastContentLineCount}`;
		const footer = truncateToWidth(`${position} ↑↓ PgUp/PgDn • [Esc] close`, innerWidth, "");
		const body = contentLines.slice(
			this.scrollView.scrollTop,
			this.scrollView.scrollTop + viewportHeight,
		);
		const horizontal = "─".repeat(innerWidth);
		const frame = (left: string, content: string, right: string, role: ThemeColor) => {
			if (frameWidth === 1) {
				return this.theme.bg("customMessageBg", truncateToWidth(content, frameWidth, ""));
			}
			if (frameWidth === 2) {
				return this.theme.bg(
					"customMessageBg",
					`${this.theme.fg(role, left)}${this.theme.fg(role, right)}`,
				);
			}
			const clipped = truncateToWidth(content, innerWidth, "");
			const padded = `${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))}`;
			return this.theme.bg(
				"customMessageBg",
				`${this.theme.fg(role, left)}${padded}${this.theme.fg(role, right)}`,
			);
		};
		const top = frame("┌", title.replace(/^─/u, "─"), "┐", "accent");
		const bottom = frame("└", horizontal, "┘", "accent");
		return [
			top,
			...body.map((line) => frame("│", line, "│", "borderMuted")),
			frame("│", footer, "│", "muted"),
			bottom,
		];
	}

	handleInput(data: string): void {
		if (this.finished) return;
		if (matchesKey(data, Key.escape) || data === "q") {
			this.finished = true;
			this.onClose();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.scrollView.scrollBy(-1);
		} else if (matchesKey(data, Key.down)) {
			this.scrollView.scrollBy(1);
		} else if (matchesKey(data, Key.pageUp)) {
			this.scrollView.scrollBy(-Math.max(1, this.scrollView.viewportHeight));
		} else if (matchesKey(data, Key.pageDown)) {
			this.scrollView.scrollBy(Math.max(1, this.scrollView.viewportHeight));
		} else if (matchesKey(data, Key.home)) {
			this.scrollView.scrollToStart();
		} else if (matchesKey(data, Key.end)) {
			this.scrollView.scrollToEnd();
		} else {
			return;
		}
		this.tui.requestRender();
	}

	invalidate(): void {
		this.scrollView.invalidate();
	}

	dispose(): void {
		if (this.finished) return;
		this.finished = true;
		this.onClose();
	}
}
