import { randomBytes } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import type { SideThreadTurn } from "./side-thread.js";
import { sanitizeSingleLine } from "./text.js";

// Data contract v1 for the "btw" custom entry. Custom entries persist in the
// session file and never participate in the LLM context (docs/extensions.md).
export const BTW_ENTRY_TYPE = "btw";
export const BTW_ENTRY_VERSION = 1;

export type BtwEntryStatus = "completed" | "failed" | "cancelled";
export type BtwEntryHost = "tui" | "rpc";

export interface BtwEntryUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number | null;
}

export interface BtwEntryContextInfo {
	mode: "branch" | "excerpt" | "none";
	entries: number;
	chars: number;
	truncated: boolean;
	leafId?: string;
}

export interface BtwEntryData {
	v: typeof BTW_ENTRY_VERSION;
	/** Unique id of this question/answer turn, e.g. "btw-1a2b3c4d5e6f". */
	id: string;
	/** Stable id shared by all turns of one side thread (first turn id). */
	threadId: string;
	question: string;
	status: BtwEntryStatus;
	answer: string;
	error: string | null;
	model: { provider: string; id: string } | null;
	thinkingLevel: string;
	usage: BtwEntryUsage | null;
	context: BtwEntryContextInfo;
	createdAt: string;
	completedAt: string;
	host: BtwEntryHost;
}

export function newBtwId(): string {
	return `btw-${randomBytes(6).toString("hex")}`;
}

export function appendBtwEntry(pi: ExtensionAPI, data: BtwEntryData): void {
	pi.appendEntry(BTW_ENTRY_TYPE, data);
}

type SessionEntryLike = {
	type: string;
	customType?: string;
	data?: unknown;
};

export function isBtwEntryData(value: unknown): value is BtwEntryData {
	if (value === null || typeof value !== "object") return false;
	const candidate = value as Partial<BtwEntryData>;
	return (
		candidate.v === BTW_ENTRY_VERSION &&
		typeof candidate.id === "string" &&
		typeof candidate.question === "string" &&
		(candidate.status === "completed" ||
			candidate.status === "failed" ||
			candidate.status === "cancelled")
	);
}

/** Read all persisted /btw turns from the current session, oldest first. */
export function collectBtwEntries(entries: readonly SessionEntryLike[]): BtwEntryData[] {
	const collected: BtwEntryData[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== BTW_ENTRY_TYPE) continue;
		if (isBtwEntryData(entry.data)) collected.push(entry.data);
	}
	return collected;
}

export interface RebuiltBtwThread {
	threadId: string;
	title: string;
	turns: SideThreadTurn[];
	thinkingLevel?: string;
	createdAt: number;
	updatedAt: number;
}

/**
 * Rebuild resumable side threads from persisted entries after restart/resume.
 * Assistant responses are synthesized from the stored answer text; usage and
 * provider metadata on the synthesized message are placeholders and never
 * re-sent anywhere (they only feed buildSideThreadMessages).
 */
export function rebuildBtwThreads(entries: readonly BtwEntryData[]): RebuiltBtwThread[] {
	const byThread = new Map<string, RebuiltBtwThread>();
	for (const data of entries) {
		const threadId = data.threadId || data.id;
		let thread = byThread.get(threadId);
		if (!thread) {
			thread = {
				threadId,
				title: sanitizeSingleLine(data.question) || "Untitled side thread",
				turns: [],
				createdAt: Date.parse(data.createdAt) || 0,
				updatedAt: Date.parse(data.completedAt) || 0,
			};
			byThread.set(threadId, thread);
		}
		thread.updatedAt = Math.max(thread.updatedAt, Date.parse(data.completedAt) || 0);
		if (typeof data.thinkingLevel === "string") thread.thinkingLevel = data.thinkingLevel;
		if (data.status === "completed") {
			thread.turns.push({
				kind: "answered",
				question: data.question,
				answer: data.answer,
				response: synthesizeAssistantMessage(data),
			});
		} else if (data.status === "failed") {
			thread.turns.push({
				kind: "error",
				question: data.question,
				answer: data.error ?? "The side question failed.",
			});
		}
		// Cancelled turns carry no answer and are not replayed into the thread.
	}
	return [...byThread.values()];
}

function synthesizeAssistantMessage(data: BtwEntryData): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: data.answer }],
		api: "unknown" as AssistantMessage["api"],
		provider: (data.model?.provider ?? "unknown") as AssistantMessage["provider"],
		model: data.model?.id ?? "unknown",
		usage: {
			input: data.usage?.input ?? 0,
			output: data.usage?.output ?? 0,
			cacheRead: data.usage?.cacheRead ?? 0,
			cacheWrite: data.usage?.cacheWrite ?? 0,
			totalTokens: (data.usage?.input ?? 0) + (data.usage?.output ?? 0),
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: data.usage?.cost ?? 0,
			},
		},
		stopReason: "stop",
		timestamp: Date.parse(data.completedAt) || 0,
	};
}

const COLLAPSED_QUESTION_CHARS = 72;

/**
 * Transcript renderer for persisted /btw entries. Collapsed: one status line.
 * Expanded (Pi's expand toggle): full question and answer. Long-answer reading
 * with scrolling lives in the /btw:open overlay.
 */
export function registerBtwEntryRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer(BTW_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		if (!isBtwEntryData(entry.data)) {
			box.addChild(new Text(theme.fg("warning", "/btw entry: unrecognized data"), 0, 0));
			return box;
		}
		const data = entry.data;
		const statusColor =
			data.status === "completed" ? "success" : data.status === "cancelled" ? "dim" : "error";
		const question = sanitizeSingleLine(data.question);
		const title =
			question.length > COLLAPSED_QUESTION_CHARS
				? `${question.slice(0, COLLAPSED_QUESTION_CHARS - 1)}…`
				: question;
		box.addChild(
			new Text(
				`${theme.bold(theme.fg("accent", "/btw"))} ${title}  ${theme.fg(statusColor, data.status)}${theme.fg("dim", `  ${data.id}`)}`,
				0,
				0,
			),
		);
		if (expanded) {
			box.addChild(new Text(theme.fg("dim", `Q: ${data.question}`), 0, 0));
			if (data.answer) {
				box.addChild(new Markdown(data.answer, 0, 0, getMarkdownTheme()));
			}
			if (data.error) {
				box.addChild(new Text(theme.fg("error", data.error), 0, 0));
			}
			box.addChild(
				new Text(
					theme.fg(
						"dim",
						`${data.host} · ${data.model ? `${data.model.provider}/${data.model.id}` : "no model"} · ${data.createdAt}`,
					),
					0,
					0,
				),
			);
		}
		return box;
	});
}
