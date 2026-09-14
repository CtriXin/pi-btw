import type { BtwEntryContextInfo } from "./btw-entries.js";

export const MAX_CONTEXT_CHARS = 40_000;
const TRUNCATION_MARKER = "[Earlier context omitted; showing the last";

type MessageContentBlock = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: unknown;
	result?: unknown;
};

type SessionMessage = {
	role?: string;
	content?: unknown;
	stopReason?: string;
};

export type SessionEntry = {
	type: string;
	id?: string;
	message?: SessionMessage;
};

export interface ConversationContext {
	text: string;
	info: BtwEntryContextInfo;
}

export function buildConversationContext(entries: readonly SessionEntry[]) {
	return buildConversationContextWithMeta(entries).text;
}

export function buildConversationContextWithMeta(
	entries: readonly SessionEntry[],
): ConversationContext {
	const sections: string[] = [];
	let usedEntries = 0;

	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;

		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;

		const contentLines = extractContentLines(entry.message.content);
		if (contentLines.length === 0) continue;

		const label = role === "user" ? "User" : "Assistant";
		const status =
			entry.message.stopReason && entry.message.stopReason !== "stop"
				? ` (${entry.message.stopReason})`
				: "";
		sections.push(`${label}${status}: ${contentLines.join("\n")}`);
		usedEntries += 1;
	}

	const joined = sections.join("\n\n");
	const truncated = joined.length > MAX_CONTEXT_CHARS;
	const text = truncated ? truncateFromStart(joined, MAX_CONTEXT_CHARS) : joined;
	const leafId = entries.at(-1)?.id;
	return {
		text,
		info: {
			mode: text ? "branch" : "none",
			entries: usedEntries,
			chars: text.length,
			truncated,
			...(leafId ? { leafId } : {}),
		},
	};
}

export function isTruncatedContextText(text: string): boolean {
	return text.startsWith(TRUNCATION_MARKER);
}

function extractContentLines(content: unknown): string[] {
	if (typeof content === "string") return [content.trim()].filter(Boolean);
	if (!Array.isArray(content)) return [];

	const lines: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as MessageContentBlock;
		if (block.type === "text" && typeof block.text === "string") {
			lines.push(block.text.trim());
		} else if (block.type === "toolCall" && typeof block.name === "string") {
			lines.push(`Tool call: ${block.name}(${formatJson(block.arguments)})`);
		} else if (block.type === "toolResult" && typeof block.name === "string") {
			lines.push(`Tool result from ${block.name}: ${formatJson(block.result)}`);
		}
	}
	return lines.filter(Boolean);
}

function formatJson(value: unknown) {
	if (value === undefined) return "";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function truncateFromStart(text: string, maxChars: number) {
	return `[Earlier context omitted; showing the last ${maxChars} characters.]\n${text.slice(-maxChars)}`;
}
