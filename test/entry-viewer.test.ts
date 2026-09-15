import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { BtwEntryViewer } from "../src/entry-viewer.js";

function theme() {
	return {
		fg: (_role: string, text: string) => text,
		bg: (_role: string, text: string) => text,
		bold: (text: string) => text,
	};
}

test("entry viewer paints an opaque, width-stable frame", () => {
	const viewer = new BtwEntryViewer(
		{ terminal: { rows: 12 }, requestRender() {} } as never,
		theme() as never,
		"A long answer that should remain inside the viewer frame.",
		"A question",
		() => undefined,
	);
	const lines = viewer.render(40);
	assert.ok(lines.length >= 3);
	assert.ok(
		lines.every((line) => visibleWidth(line) === 40),
		JSON.stringify(lines.map((line) => visibleWidth(line))),
	);
	assert.equal(lines[0]?.startsWith("┌"), true);
	assert.equal(lines.at(-1)?.startsWith("└"), true);
	assert.ok(lines.every((line) => line.endsWith("┐") || line.endsWith("│") || line.endsWith("┘")));
	assert.ok(lines.slice(1, -1).every((line) => line.startsWith("│")));
	assert.match(lines.join("\n"), /A long answer/);
});

test("entry viewer clamps narrow widths without producing overflow", () => {
	const viewer = new BtwEntryViewer(
		{ terminal: { rows: 8 }, requestRender() {} } as never,
		theme() as never,
		"宽度很窄时也必须留在边框内",
		"问题",
		() => undefined,
	);
	for (const width of [1, 2, 3, 5, 12]) {
		assert.ok(viewer.render(width).every((line) => visibleWidth(line) <= Math.max(1, width)));
	}
});
test("entry viewer scroll keeps the opaque frame on every page", () => {
	const viewer = new BtwEntryViewer(
		{ terminal: { rows: 8 }, requestRender() {} } as never,
		theme() as never,
		Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"),
		"Question",
		() => undefined,
	);
	const before = viewer.render(32);
	viewer.handleInput("\u001b[B");
	const after = viewer.render(32);
	assert.ok(
		before.every((line) => visibleWidth(line) === 32),
		JSON.stringify(before.map((line) => visibleWidth(line))),
	);
	assert.ok(
		after.every((line) => visibleWidth(line) === 32),
		JSON.stringify(after.map((line) => visibleWidth(line))),
	);
	assert.ok(after.slice(1, -1).every((line) => line.startsWith("│")));
	assert.notDeepEqual(after, before);
});
