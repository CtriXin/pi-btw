import {
	type Api,
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Model,
	type ProviderHeaders,
} from "@earendil-works/pi-ai";
import {
	BorderedLoader,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { MenuContext, RunMenuResult } from "@narumitw/pi-tui-kit";
import {
	type BtwBringToMainSegment,
	type BtwBringToMainSummary,
	BtwTextRangeSelector,
	type BtwTextRangeSelectorState,
	buildQuickBringToMainSegments,
	estimateBringToMainTokens,
	formatBtwBringToMain,
	getAnsweredTurns,
	summarizeBringToMain,
} from "./bring-to-main.js";
import { buildConversationContext } from "./btw-context.js";
import {
	collectBtwEntries,
	newBtwId,
	rebuildBtwThreads,
	registerBtwEntryRenderer,
} from "./btw-entries.js";
import type { BtwThreadState, ResolvedBtwModel } from "./btw-state.js";
import { BtwStateStore } from "./btw-state.js";
import { BtwEntryViewer } from "./entry-viewer.js";
import { type RunBtwFullscreen, runBtwFullscreen } from "./fullscreen-ui.js";
import { emitBtwHostEvent } from "./host-events.js";
import { runInlineBtw } from "./inline-card.js";
import { pickMainEntry } from "./main-tree-picker.js";
import {
	type BtwCommandMenuResult,
	type BtwResumeThreadSummary,
	runBtwMenuPreservingEditor,
	showBtwCommandMenu,
	showBtwCustomPreservingEditor,
} from "./menu.js";
import {
	type BtwSettings,
	effectiveFullscreenCopyOnSelect,
	effectiveRememberThinkingLevelChanges,
	parseBtwModelReference,
	readBtwSettings,
	updateBtwSettings,
} from "./settings.js";
import {
	BTW_THINKING_LEVELS,
	type BtwThinkingLevel,
	type CompleteSimpleFunction,
	completeSideThreadTurn,
	createSideThread,
	type SideQuestionAuth,
	type SideThread,
	type StreamSimpleFunction,
} from "./side-thread.js";
import { parseFollowArgs, prepareStandaloneState, runStandaloneBtw } from "./standalone.js";
import { sanitizeSingleLine } from "./text.js";
import {
	BtwAnsweringView,
	type BtwThinkingControl,
	BtwTranscriptPager,
	type TranscriptPagerAction,
} from "./transcript-pager.js";

export { buildConversationContext } from "./btw-context.js";
export { BTW_ENTRY_TYPE } from "./btw-entries.js";
export type { BtwThreadState, ResolvedBtwModel } from "./btw-state.js";
export {
	BTW_SETTINGS_FILE,
	type BtwSettings,
	type BtwSettingsLoadResult,
	normalizeBtwSettings,
	parseBtwModelReference,
	readBtwSettings,
} from "./settings.js";
export {
	BTW_THINKING_LEVELS,
	type BtwThinkingLevel,
	buildUserPrompt,
	completeSideQuestion,
} from "./side-thread.js";
export { sanitizeSingleLine } from "./text.js";

interface LoadBtwThinkingLevelOptions {
	settingsPath?: string;
	warn?: (message: string) => void;
}

type BtwModelRegistry = Pick<
	ExtensionCommandContext["modelRegistry"],
	"find" | "getApiKeyAndHeaders"
>;

type BtwProviderRegistry = Pick<ExtensionCommandContext["modelRegistry"], "getProvider">;

export function createModelRegistryCompleteSimple(
	modelRegistry: BtwProviderRegistry,
): CompleteSimpleFunction {
	return async (model, context, options) => {
		const provider = modelRegistry.getProvider(model.provider);
		if (!provider) throw new Error(`No provider registered for model provider: ${model.provider}`);
		return provider.streamSimple(model, context, options).result();
	};
}

/** Raw streaming accessor used by the standalone (inline/headless) flow. */
export function createModelRegistryStreamSimple(
	modelRegistry: BtwProviderRegistry,
): StreamSimpleFunction {
	return (model, context, options) => {
		const provider = modelRegistry.getProvider(model.provider);
		if (!provider) throw new Error(`No provider registered for model provider: ${model.provider}`);
		return provider.streamSimple(model, context, options);
	};
}

interface ResolveBtwModelOptions {
	settings: BtwSettings;
	currentModel: Model<Api> | undefined;
	modelRegistry: BtwModelRegistry;
	warn?: (message: string) => void;
}

export async function resolveBtwModel({
	settings,
	currentModel,
	modelRegistry,
	warn,
}: ResolveBtwModelOptions): Promise<ResolvedBtwModel | undefined> {
	const reportWarning = (message: string) => warn?.(sanitizeSingleLine(message));
	if (settings.model) {
		const fallback = currentModel
			? `${currentModel.provider}/${currentModel.id}`
			: "the current model";
		const reference = parseBtwModelReference(settings.model);
		if (!reference) {
			reportWarning(`pi-btw model ${settings.model} is invalid; falling back to ${fallback}.`);
			return resolveBtwModel({ settings: {}, currentModel, modelRegistry, warn: reportWarning });
		}
		const configuredModel = modelRegistry.find(reference.provider, reference.modelId);
		if (!configuredModel) {
			reportWarning(`pi-btw model ${settings.model} was not found; falling back to ${fallback}.`);
		} else {
			const sameAsCurrent =
				configuredModel === currentModel ||
				(configuredModel.provider === currentModel?.provider &&
					configuredModel.id === currentModel.id);
			const fallbackAction = sameAsCurrent
				? "no distinct current model is available"
				: `falling back to ${fallback}`;
			try {
				const auth = await modelRegistry.getApiKeyAndHeaders(configuredModel);
				if (auth.ok && hasRequestAuth(auth)) {
					return {
						model: auth.baseUrl ? { ...configuredModel, baseUrl: auth.baseUrl } : configuredModel,
						auth,
					};
				}
				const reason = auth.ok ? "has no request credentials" : auth.error;
				reportWarning(
					`pi-btw model ${settings.model} is unavailable (${reason}); ${fallbackAction}.`,
				);
			} catch (error: unknown) {
				reportWarning(
					`pi-btw model ${settings.model} credentials failed (${formatError(error)}); ${fallbackAction}.`,
				);
			}
			if (sameAsCurrent) return undefined;
		}
	}

	if (!currentModel) return undefined;
	try {
		const auth = await modelRegistry.getApiKeyAndHeaders(currentModel);
		if (auth.ok && hasRequestAuth(auth)) {
			// Direct provider streams bypass Pi's request preparation, including OAuth routing.
			return {
				model: auth.baseUrl ? { ...currentModel, baseUrl: auth.baseUrl } : currentModel,
				auth,
			};
		}
	} catch {
		// The caller reports the final lack of an available model.
	}
	return undefined;
}

function hasRequestAuth(auth: SideQuestionAuth): boolean {
	return Boolean(
		auth.apiKey ||
			providerHeadersHaveValue(auth.headers) ||
			(auth.env && Object.keys(auth.env).length > 0),
	);
}

function providerHeadersHaveValue(headers: ProviderHeaders | undefined): boolean {
	return headers !== undefined && Object.values(headers).some((value) => value !== null);
}

export async function loadBtwThinkingLevel(
	currentThinkingLevel: BtwThinkingLevel,
	options: LoadBtwThinkingLevelOptions = {},
): Promise<BtwThinkingLevel> {
	const settings = await readBtwSettings(options.settingsPath);
	if (settings.kind === "missing") return currentThinkingLevel;
	if (settings.kind === "loaded") {
		return settings.settings.thinkingLevel ?? currentThinkingLevel;
	}

	options.warn?.(
		sanitizeSingleLine(
			`pi-btw settings ignored: ${settings.reason}; expected optional model "provider/model-id", omitted thinkingLevel for Same as main thread or thinkingLevel "${BTW_THINKING_LEVELS.join('" | "')}", boolean rememberThinkingLevelChanges, and boolean fullscreenCopyOnSelect. Using current Pi thinking level.`,
		),
	);
	return currentThinkingLevel;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readBtwSessionId(ctx: ExtensionCommandContext): string | undefined {
	const getSessionId = ctx.sessionManager.getSessionId;
	if (typeof getSessionId !== "function") return undefined;
	const sessionId = getSessionId.call(ctx.sessionManager);
	return sessionId.length > 0 ? sessionId : undefined;
}

function notifySafely(
	ctx: ExtensionCommandContext,
	message: string,
	level: Parameters<ExtensionCommandContext["ui"]["notify"]>[1],
): void {
	try {
		ctx.ui.notify(sanitizeSingleLine(message), level);
	} catch {
		// Async command continuations may finish after their ExtensionContext is replaced.
	}
}

// Keep this slightly-over-1,000-line command coordinator intact: its injectable menu,
// request, resume, and delivery flows share the same thread-state and test seams;
// settings, keybinding policy, terminal ownership, and rendering live in separate modules.
export interface BtwExtensionDependencies {
	showCommandMenu?: (
		pi: ExtensionAPI,
		ctx: ExtensionCommandContext,
		resumeThreads: readonly BtwResumeThreadSummary[],
	) => Promise<BtwCommandMenuResult>;
	pickMainEntry?: typeof pickMainEntry;
	loadSettings?: typeof loadSettingsForCommand;
	resolveModel?: typeof resolveBtwModelWithLoader;
	runThread?: typeof runBtwThread;
	runFullscreen?: RunBtwFullscreen;
	runStandalone?: typeof runStandaloneBtw;
	runInline?: typeof runInlineBtw;
}

export type BtwThreadResult = { kind: "closed" };

type BtwThreadThinkingControl = Omit<BtwThinkingControl, "keybindings">;

interface BtwThreadSteeringControl {
	questions: readonly string[];
	submit: (question: string) => void;
	thinking: BtwThreadThinkingControl;
}

type BtwBringToMainChoice =
	| BtwThreadResult
	| {
			kind: "bringToMain";
			draft: string;
			summary: BtwBringToMainSummary;
			selectionState?: BtwTextRangeSelectorState;
	  }
	| { kind: "back" };

type BtwBringToMainDelivery = "loaded" | "back" | "closed";

export default function btw(pi: ExtensionAPI, dependencies: BtwExtensionDependencies = {}) {
	const showCommandMenu = dependencies.showCommandMenu ?? showCommandMenuForBtw;
	const pickEntry = dependencies.pickMainEntry ?? pickMainEntry;
	const loadSettings = dependencies.loadSettings ?? loadSettingsForCommand;
	const resolveModel = dependencies.resolveModel ?? resolveBtwModelWithLoader;
	const runThread = dependencies.runThread ?? runBtwThread;
	const runFullscreen = dependencies.runFullscreen ?? runBtwFullscreen;
	const runStandalone = dependencies.runStandalone ?? runStandaloneBtw;
	const runInline = dependencies.runInline ?? runInlineBtw;
	// Pi creates a fresh extension instance after session replacement or reload;
	// threads are rebuilt from persisted custom entries on every session_start.
	const store = new BtwStateStore();
	registerBtwEntryRenderer(pi);

	const listResumeThreads = (): BtwResumeThreadSummary[] =>
		[...store.threads.values()]
			.reverse()
			.filter((state) => state.thread.turns.length > 0 && state.title)
			.sort(
				(first, second) => second.updatedAt - first.updatedAt || second.createdAt - first.createdAt,
			)
			.map((state) => ({
				id: state.id,
				title: state.title ?? "Untitled side thread",
				questionCount: state.thread.turns.length,
			}));

	const resolveModelSilently = (settings: BtwSettings, ctx: ExtensionCommandContext) =>
		resolveBtwModel({
			settings,
			currentModel: ctx.model,
			modelRegistry: ctx.modelRegistry,
			warn: (message) => notifySafely(ctx, message, "warning"),
		});

	// Shared by the TUI inline card and the headless RPC flow; identical events
	// and persistence, different rendering only.
	const runStandaloneCommand = async (
		question: string,
		ctx: ExtensionCommandContext,
		existingState?: BtwThreadState,
	): Promise<void> => {
		const settings = await loadSettings(ctx);
		const state = existingState ?? prepareStandaloneState(pi, ctx, settings, store);
		const deps = {
			settings,
			resolveModel: () => resolveModelSilently(settings, ctx),
			streamSimple: createModelRegistryStreamSimple(ctx.modelRegistry),
		};
		if (ctx.mode === "rpc") {
			await store.track(runStandalone(pi, ctx, question, state, store, "rpc", deps));
			return;
		}
		await store.track(runInline(pi, ctx, question, state, store, deps));
	};

	const runFullscreenFlow = async (
		ctx: ExtensionCommandContext,
		question: string,
		withMenu: boolean,
	): Promise<void> => {
		let menuResult: BtwCommandMenuResult = "start";
		let selectedConversationContext: string | undefined;
		if (withMenu) {
			while (true) {
				menuResult = await showCommandMenu(pi, ctx, listResumeThreads());
				if (menuResult === "closed") return;
				if (menuResult !== "tree") break;

				const treeResult = await pickEntry(pi, ctx);
				if (treeResult.kind === "closed") return;
				if (treeResult.kind === "back") continue;
				try {
					if (!ctx.sessionManager.getEntry(treeResult.entryId)) {
						notifySafely(ctx, "The selected main-thread entry is no longer available", "warning");
						continue;
					}
					const branch = ctx.sessionManager.getBranch(treeResult.entryId);
					if (branch.at(-1)?.id !== treeResult.entryId) {
						notifySafely(ctx, "The selected main-thread branch is no longer available", "warning");
						continue;
					}
					selectedConversationContext = buildConversationContext(branch);
					menuResult = "start";
					break;
				} catch {
					return;
				}
			}
		}

		const settings = await loadSettings(ctx);
		const sameAsMainThinkingLevel = settings.thinkingLevel === undefined;
		const resolution = await resolveModel(settings, ctx);
		if (resolution.kind === "cancelled") {
			notifySafely(ctx, "Cancelled", "info");
			return;
		}
		if (resolution.kind === "unavailable") {
			notifySafely(ctx, "No available model for /btw", "error");
			return;
		}

		let state = typeof menuResult === "object" ? store.threads.get(menuResult.threadId) : undefined;
		if (typeof menuResult === "object" && !state) {
			notifySafely(ctx, "The selected /btw side thread is no longer available", "warning");
			return;
		}
		try {
			await runFullscreen(
				ctx,
				(fullscreenCtx) => {
					if (!state) {
						const createdAt = Date.now();
						state = {
							id: `btw-${store.nextThreadNumber}`,
							thread: createSideThread(
								selectedConversationContext ??
									buildConversationContext(fullscreenCtx.sessionManager.getBranch()),
							),
							thinkingLevel: settings.thinkingLevel ?? pi.getThinkingLevel(),
							createdAt,
							updatedAt: createdAt,
						};
						store.nextThreadNumber += 1;
					}
					return runThread({
						initialQuestion: question || undefined,
						selected: resolution.selected,
						thinkingLevel: state.thinkingLevel,
						rememberThinkingLevelChanges:
							!sameAsMainThinkingLevel && effectiveRememberThinkingLevelChanges(settings),
						state,
						ctx: fullscreenCtx,
					});
				},
				{
					copyOnSelect: effectiveFullscreenCopyOnSelect(settings),
					...(settings.keybindings ? { keybindings: settings.keybindings } : {}),
				},
			);
		} finally {
			if (state?.title && state.thread.turns.length > 0) {
				store.rememberThread(state);
			}
		}
	};

	pi.registerCommand("btw", {
		description: "Ask a quick side question without adding it to the main conversation",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (question) {
				if (ctx.mode === "tui" || ctx.mode === "rpc") {
					try {
						await runStandaloneCommand(question, ctx);
					} catch (error: unknown) {
						notifySafely(ctx, `/btw failed: ${formatError(error)}`, "error");
					}
					return;
				}
				notifySafely(ctx, "/btw questions require interactive TUI or RPC mode", "error");
				return;
			}
			if (ctx.mode === "rpc") {
				emitBtwHostEvent(ctx, { event: "failed", id: newBtwId(), error: "question_required" });
				return;
			}
			if (ctx.mode !== "tui") {
				notifySafely(ctx, "/btw requires interactive TUI mode", "error");
				return;
			}
			await runFullscreenFlow(ctx, "", true);
		},
	});

	pi.registerCommand("btw:thread", {
		description: "Open the fullscreen /btw side-thread workspace (upstream behavior)",
		handler: async (args, ctx) => {
			if (ctx.mode === "rpc") {
				emitBtwHostEvent(ctx, { event: "failed", id: newBtwId(), error: "tui_required" });
				return;
			}
			if (ctx.mode !== "tui") {
				notifySafely(ctx, "/btw:thread requires interactive TUI mode", "error");
				return;
			}
			await runFullscreenFlow(ctx, args.trim(), false);
		},
	});

	pi.registerCommand("btw:cancel", {
		description: "Cancel an in-flight /btw side question (latest when no id is given)",
		handler: async (args, ctx) => {
			const ref = args.trim();
			const run = ref ? findActiveRun(store, ref) : store.latestActiveRun();
			if (!run) {
				notifySafely(ctx, "No active /btw question to cancel", "info");
				return;
			}
			run.controller.abort();
			notifySafely(ctx, `Cancelling ${run.id}…`, "info");
		},
	});

	pi.registerCommand("btw:history", {
		description: "List recent /btw side questions persisted in this session",
		handler: async (_args, ctx) => {
			const items = collectBtwEntries(ctx.sessionManager.getBranch()).slice(-20).reverse();
			if (ctx.mode === "rpc") {
				emitBtwHostEvent(ctx, { event: "history", id: "btw-history", items });
				return;
			}
			if (ctx.mode !== "tui") {
				notifySafely(ctx, "/btw:history requires interactive TUI or RPC mode", "error");
				return;
			}
			if (items.length === 0) {
				notifySafely(ctx, "No /btw history in this session", "info");
				return;
			}
			const lines = items
				.map(
					(item) =>
						`- **${item.status}** · \`${item.id}\` · ${sanitizeSingleLine(item.question)}${item.error ? ` — ${item.error}` : ""}`,
				)
				.join("\n");
			await ctx.ui.custom(
				(tui, theme, _keybindings, done) =>
					new BtwEntryViewer(tui, theme, lines, "history", () => done(null)),
				{ overlay: true },
			);
		},
	});

	pi.registerCommand("btw:open", {
		description: "Read a persisted /btw answer in a scrollable overlay (latest when no id)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				notifySafely(
					ctx,
					"/btw:open requires interactive TUI mode; RPC hosts read custom/btw entries via get_entries",
					"error",
				);
				return;
			}
			const data = findEntryData(ctx, args.trim() || undefined);
			if (!data) {
				notifySafely(ctx, "No matching /btw entry found", "warning");
				return;
			}
			const threadId = data.threadId || data.id;
			const threadEntries = collectBtwEntries(ctx.sessionManager.getBranch()).filter(
				(entry) => (entry.threadId || entry.id) === threadId && entry.status !== "cancelled",
			);
			const turns = rebuildBtwThreads(threadEntries)[0]?.turns ?? [];
			if (turns.length === 0) {
				notifySafely(ctx, "That /btw thread has no readable content", "warning");
				return;
			}
			await ctx.ui.custom(
				(tui, theme, _keybindings, done) =>
					new BtwEntryViewer(tui, theme, turns, sanitizeSingleLine(data.question), () =>
						done(null),
					),
				{ overlay: true },
			);
		},
	});

	pi.registerCommand("btw:bring", {
		description: "Load a /btw answer into the main editor without sending it",
		handler: async (args, ctx) => {
			const data = findEntryData(ctx, args.trim() || undefined);
			if (data?.status !== "completed" || !data.answer) {
				notifySafely(ctx, "No completed /btw answer found to bring", "warning");
				return;
			}
			try {
				const existing = ctx.ui.getEditorText();
				ctx.ui.setEditorText(existing.trim() ? `${existing}\n\n${data.answer}` : data.answer);
				notifySafely(
					ctx,
					`Loaded ${data.id} into the main editor. Review and submit when ready.`,
					"info",
				);
			} catch {
				notifySafely(ctx, "Could not load the answer into the main editor", "error");
			}
		},
	});

	pi.registerCommand("btw:follow", {
		description: "Ask a follow-up on an existing /btw thread: /btw:follow <id> <question>",
		handler: async (args, ctx) => {
			const parsed = parseFollowArgs(args);
			if (!parsed?.question) {
				const message = "Usage: /btw:follow <id> <question>";
				if (ctx.mode === "rpc") {
					emitBtwHostEvent(ctx, { event: "failed", id: newBtwId(), error: message });
				} else {
					notifySafely(ctx, message, "warning");
				}
				return;
			}
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
				notifySafely(ctx, "/btw:follow requires interactive TUI or RPC mode", "error");
				return;
			}
			const entry = findEntryData(ctx, parsed.ref);
			const threadId = entry ? entry.threadId || entry.id : parsed.ref;
			const state = store.findThread(threadId);
			if (!state) {
				const message = `No /btw thread found for ${parsed.ref}`;
				if (ctx.mode === "rpc") {
					emitBtwHostEvent(ctx, { event: "failed", id: newBtwId(), error: message });
				} else {
					notifySafely(ctx, message, "warning");
				}
				return;
			}
			try {
				await runStandaloneCommand(parsed.question, ctx, state);
			} catch (error: unknown) {
				notifySafely(ctx, `/btw:follow failed: ${formatError(error)}`, "error");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		try {
			const rebuilt = rebuildBtwThreads(collectBtwEntries(ctx.sessionManager.getBranch()));
			for (const thread of rebuilt) {
				if (store.threads.has(thread.threadId)) continue;
				store.rememberThread({
					id: thread.threadId,
					title: thread.title,
					thread: { conversationContext: "", turns: thread.turns },
					thinkingLevel: isBtwThinkingLevel(thread.thinkingLevel)
						? thread.thinkingLevel
						: pi.getThinkingLevel(),
					createdAt: thread.createdAt,
					updatedAt: thread.updatedAt,
				});
			}
		} catch {
			// Rebuilding resumable threads is best-effort; entries stay in the session.
		}
	});

	pi.on("session_shutdown", async () => {
		for (const run of [...store.activeRuns.values()]) {
			run.controller.abort();
		}
		// Give in-flight runs a chance to write their terminal cancelled entries.
		await Promise.allSettled([...store.pendingRuns]);
	});
}

function findActiveRun(store: BtwStateStore, ref: string) {
	const matches = [...store.activeRuns.values()].filter(
		(run) => run.id === ref || run.id.startsWith(ref) || run.threadId.startsWith(ref),
	);
	return matches.length === 1 ? matches[0] : undefined;
}

function findEntryData(ctx: ExtensionCommandContext, ref?: string) {
	const entries = collectBtwEntries(ctx.sessionManager.getBranch());
	if (!ref) {
		return entries.filter((entry) => entry.status === "completed").at(-1) ?? entries.at(-1);
	}
	const exact = entries.find((entry) => entry.id === ref);
	if (exact) return exact;
	const matches = entries.filter((entry) => entry.id.startsWith(ref));
	return matches.length === 1 ? matches[0] : undefined;
}

function isBtwThinkingLevel(value: unknown): value is BtwThinkingLevel {
	return typeof value === "string" && (BTW_THINKING_LEVELS as readonly string[]).includes(value);
}

async function showCommandMenuForBtw(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	resumeThreads: readonly BtwResumeThreadSummary[],
): Promise<BtwCommandMenuResult> {
	const currentModel = ctx.model;
	const availableModels = ctx.modelRegistry.getAll();
	const currentThinkingLevel = pi.getThinkingLevel();
	const loaded = await readBtwSettings();
	const settings = loaded.kind === "loaded" ? loaded.settings : {};
	const configured = settings.model ? parseBtwModelReference(settings.model) : undefined;
	const configuredModel = configured
		? availableModels.find(
				(model) => model.provider === configured.provider && model.id === configured.modelId,
			)
		: undefined;
	const model = configuredModel ?? currentModel;
	return showBtwCommandMenu(ctx, {
		currentThinkingLevel,
		availableThinkingLevels: model ? getSupportedThinkingLevels(model) : BTW_THINKING_LEVELS,
		resumeThreads,
	});
}

async function loadSettingsForCommand(ctx: ExtensionCommandContext): Promise<BtwSettings> {
	const settingsResult = await readBtwSettings();
	if (settingsResult.kind === "loaded") return settingsResult.settings;
	if (settingsResult.kind === "invalid") {
		notifySafely(ctx, `pi-btw settings ignored: ${settingsResult.reason}`, "warning");
	}
	return {};
}

type ModelResolutionOutcome =
	| { kind: "cancelled" }
	| { kind: "unavailable" }
	| { kind: "selected"; selected: ResolvedBtwModel };

async function resolveBtwModelWithLoader(
	settings: BtwSettings,
	ctx: ExtensionCommandContext,
): Promise<ModelResolutionOutcome> {
	return ctx.ui.custom<ModelResolutionOutcome>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, "Resolving /btw model credentials...");
		let settled = false;
		loader.onAbort = () => {
			if (settled) return;
			settled = true;
			done({ kind: "cancelled" });
		};

		resolveBtwModel({
			settings,
			currentModel: ctx.model,
			modelRegistry: ctx.modelRegistry,
			warn: (message) => {
				if (!settled) notifySafely(ctx, message, "warning");
			},
		})
			.then((selected) => {
				if (settled) return;
				settled = true;
				done(selected ? { kind: "selected", selected } : { kind: "unavailable" });
			})
			.catch(() => {
				if (settled) return;
				settled = true;
				done({ kind: "unavailable" });
			});

		return loader;
	});
}

interface RunBtwThreadDependencies {
	ask?: typeof askThreadQuestion;
	interact?: typeof showThreadComposer;
	chooseBringToMain?: typeof chooseBringToMain;
	deliverBringToMain?: typeof loadBringToMainDraft;
	persistThinkingLevel?: (level: BtwThinkingLevel) => Promise<unknown>;
	now?: () => number;
}

interface RunBtwThreadOptions {
	initialQuestion?: string;
	selected: ResolvedBtwModel;
	thinkingLevel: BtwThinkingLevel;
	rememberThinkingLevelChanges?: boolean;
	settingsPath?: string;
	state?: BtwThreadState;
	ctx: ExtensionCommandContext;
	dependencies?: RunBtwThreadDependencies;
}

export async function runBtwThread({
	initialQuestion,
	selected,
	thinkingLevel,
	rememberThinkingLevelChanges = false,
	settingsPath,
	state,
	ctx,
	dependencies = {},
}: RunBtwThreadOptions): Promise<BtwThreadResult> {
	const ask = dependencies.ask ?? askThreadQuestion;
	const interact = dependencies.interact ?? showThreadComposer;
	const chooseBringToMainAction = dependencies.chooseBringToMain ?? chooseBringToMain;
	const deliverBringToMainDraft = dependencies.deliverBringToMain ?? loadBringToMainDraft;
	const persistThinkingLevel =
		dependencies.persistThinkingLevel ??
		((level: BtwThinkingLevel) => updateBtwSettings({ thinkingLevel: level }, { settingsPath }));
	const now = dependencies.now ?? Date.now;
	const thread =
		state?.thread ?? createSideThread(buildConversationContext(ctx.sessionManager.getBranch()));
	const thinkingLevels = getSupportedThinkingLevels(selected.model);
	const pendingWrites = new Set<Promise<void>>();
	const steeringQuestions: string[] = [];
	let activeThinkingLevel = clampThinkingLevel(
		selected.model,
		state?.thinkingLevel ?? thinkingLevel,
	);
	if (state) state.thinkingLevel = activeThinkingLevel;
	let pendingQuestion = initialQuestion;
	let composerDraft: string | undefined;
	const createThinkingControl = (): BtwThreadThinkingControl => ({
		level: activeThinkingLevel,
		levels: thinkingLevels,
		onChange: (level) => {
			if (!thinkingLevels.includes(level)) return;
			activeThinkingLevel = level;
			if (state) state.thinkingLevel = level;
			if (!rememberThinkingLevelChanges) return;
			let write!: Promise<void>;
			write = Promise.resolve()
				.then(() => persistThinkingLevel(level))
				.then(() => undefined)
				.catch((error: unknown) => {
					notifySafely(
						ctx,
						`Thinking level changed to ${level}, but could not be remembered in pi-btw.json: ${formatError(error)}`,
						"warning",
					);
				})
				.finally(() => pendingWrites.delete(write));
			pendingWrites.add(write);
		},
	});

	try {
		while (true) {
			if (!pendingQuestion) {
				const action = await interact(
					thread,
					thread.turns.length > 0,
					ctx,
					composerDraft,
					createThinkingControl(),
				);
				if (action.kind === "close") return { kind: "closed" };
				if (action.kind === "bringToMain") {
					const choice = await chooseBringToMainAction(thread, ctx);
					if (choice.kind === "closed") return choice;
					if (choice.kind === "back") {
						composerDraft = action.questionDraft;
						continue;
					}
					const delivery = await deliverBringToMainDraft(choice.draft, ctx, choice.summary);
					if (delivery === "loaded" || delivery === "closed") return { kind: "closed" };
					composerDraft = action.questionDraft;
					continue;
				}
				composerDraft = undefined;
				pendingQuestion = action.question;
			}

			const result = await ask(thread, pendingQuestion, selected, activeThinkingLevel, ctx, {
				questions: steeringQuestions,
				submit: (question) => steeringQuestions.push(question),
				thinking: createThinkingControl(),
			});
			if (result.kind === "aborted") {
				notifySafely(ctx, "Cancelled", "info");
				return { kind: "closed" };
			}
			if (result.kind === "error") {
				thread.turns.push({
					kind: "error",
					question: pendingQuestion,
					answer: result.message,
				});
			}
			if (state) {
				state.title ||= sanitizeSingleLine(pendingQuestion) || "Untitled side thread";
				state.updatedAt = now();
			}

			pendingQuestion = steeringQuestions.shift();
		}
	} finally {
		await Promise.allSettled([...pendingWrites]);
	}
}

interface ChooseBringToMainDependencies {
	showMenu?: typeof showBtwMenu;
	showPreview?: typeof showBringToMainPreview;
}

export async function chooseBringToMain(
	thread: SideThread,
	ctx: ExtensionCommandContext,
	dependencies: ChooseBringToMainDependencies = {},
): Promise<BtwBringToMainChoice> {
	const answered = getAnsweredTurns(thread.turns);
	if (answered.length === 0) return { kind: "back" };
	const showMenu = dependencies.showMenu ?? showBtwMenu;
	const showPreview = dependencies.showPreview ?? showBringToMainPreview;
	const makeChoice = (segments: readonly BtwBringToMainSegment[]) => ({
		kind: "bringToMain" as const,
		draft: formatBtwBringToMain(segments),
		summary: summarizeBringToMain(segments),
	});

	const latestSegments = buildQuickBringToMainSegments(thread.turns, { kind: "latest" });
	const entireSegments = buildQuickBringToMainSegments(thread.turns, { kind: "entire" });
	const latestOption = `Latest question and answer  1 Q&A · ~${estimateBringToMainTokens(latestSegments)} tokens`;
	const fromOption = "From a question onward…  Choose a starting question";
	const exactOption = "Select exact text…  Lines or characters";
	const entireOption = `Entire side thread  ${answered.length} Q&A · ~${estimateBringToMainTokens(entireSegments)} tokens`;
	const cancelOption = "Cancel  Return to the side thread";
	let selectedScope: string | undefined;

	while (true) {
		const scopeResult = await showMenu(
			ctx,
			"Bring what back to the main thread?",
			[latestOption, fromOption, exactOption, entireOption, cancelOption],
			selectedScope,
		);
		if (scopeResult.kind === "close") return { kind: "closed" };
		if (scopeResult.kind === "back" || scopeResult.value === cancelOption) return { kind: "back" };
		const scope = scopeResult.value;
		selectedScope = scope;
		if (scope === latestOption) return makeChoice(latestSegments);
		if (scope === entireOption) {
			const choice = makeChoice(entireSegments);
			const preview = await showPreview(ctx, choice.draft, choice.summary);
			if (preview.kind === "close") return { kind: "closed" };
			if (preview.kind === "back") continue;
			return choice;
		}
		if (scope === fromOption) {
			const questions = answered.map(
				(turn, index) => `${index + 1}. ${truncatePreview(sanitizeSingleLine(turn.question))}`,
			);
			let selectedQuestion: string | undefined;
			while (true) {
				const questionResult = await showMenu(
					ctx,
					"Start from which question?",
					questions,
					selectedQuestion,
				);
				if (questionResult.kind === "close") return { kind: "closed" };
				if (questionResult.kind === "back") break;
				const answeredTurnIndex = questions.indexOf(questionResult.value);
				if (answeredTurnIndex < 0) continue;
				selectedQuestion = questionResult.value;
				const choice = makeChoice(
					buildQuickBringToMainSegments(thread.turns, { kind: "from", answeredTurnIndex }),
				);
				const preview = await showPreview(ctx, choice.draft, choice.summary);
				if (preview.kind === "close") return { kind: "closed" };
				if (preview.kind === "back") continue;
				return choice;
			}
			continue;
		}

		if (scope !== exactOption) continue;
		let selectionState: BtwTextRangeSelectorState | undefined;
		while (true) {
			const selectedRange = await showBtwCustomPreservingEditor<BtwBringToMainChoice>(
				ctx,
				(tui, theme, keybindings, done) => {
					let selector: BtwTextRangeSelector;
					selector = new BtwTextRangeSelector(
						tui,
						theme,
						keybindings,
						thread.turns,
						(action) => {
							if (action.kind === "back") done({ kind: "back" });
							else if (action.kind === "close") done({ kind: "closed" });
							else done({ ...makeChoice(action.segments), selectionState: selector.getState() });
						},
						selectionState,
					);
					return selector;
				},
			);
			if (!selectedRange) return { kind: "closed" };
			if (selectedRange.kind === "closed") return selectedRange;
			if (selectedRange.kind === "back") break;
			const preview = await showPreview(ctx, selectedRange.draft, selectedRange.summary);
			if (preview.kind === "close") return { kind: "closed" };
			if (preview.kind === "back") {
				selectionState = selectedRange.selectionState;
				continue;
			}
			return {
				kind: "bringToMain",
				draft: selectedRange.draft,
				summary: selectedRange.summary,
			};
		}
	}
}

type BtwMenuSelectorAction =
	| { kind: "select"; value: string }
	| { kind: "back" }
	| { kind: "close" };

type BtwBringToMainPreviewAction = { kind: "bring" } | { kind: "back" } | { kind: "close" };

async function showBringToMainPreview(
	ctx: ExtensionCommandContext,
	draft: string,
	summary: BtwBringToMainSummary,
): Promise<BtwBringToMainPreviewAction> {
	const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
	if (ctx.signal?.aborted) return { kind: "close" };
	let confirmed = false;
	const count = summary.messages === 1 ? "1 message" : `${summary.messages} messages`;
	const lineCount = summary.lines === 1 ? "1 line" : `${summary.lines} lines`;
	const menu = defineMenu<void, "preview", "bring", MenuContext>({
		start: "preview",
		screens: {
			preview: () => ({
				kind: "review",
				title: `Preview · ${count} · ${lineCount} · ~${summary.tokens} tokens`,
				content: draft,
				viewportSize: "adaptive",
				hint: "back",
				confirm: { id: "bring", label: "Bring", action: "bring" },
			}),
		},
		actions: {
			bring: async () => {
				confirmed = true;
				return { kind: "close" } as const;
			},
		},
	});
	const result = await runBtwMenuPreservingEditor(ctx, (menuContext) =>
		runMenu(menuContext, menu, { getState: () => undefined }),
	);
	if (confirmed && result.kind === "closed" && result.reason === "close") {
		return { kind: "bring" };
	}
	return terminalBtwMenuAction(result);
}

async function showBtwMenu(
	ctx: ExtensionCommandContext,
	title: string,
	options: readonly string[],
	initialValue?: string,
): Promise<BtwMenuSelectorAction> {
	const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
	if (ctx.signal?.aborted) return { kind: "close" };
	const items = options.map((label, index) => ({ id: `option-${index}`, label }));
	const initialIndex = initialValue === undefined ? -1 : options.indexOf(initialValue);
	let selectedValue: string | undefined;
	const menu = defineMenu<void, "choices", "select", MenuContext>({
		start: "choices",
		screens: {
			choices: () => ({
				kind: "choice",
				title,
				items,
				action: "select",
				initialItemId: initialIndex >= 0 ? `option-${initialIndex}` : undefined,
				hint: "back",
			}),
		},
		actions: {
			select: async ({ itemId }: { itemId: string }) => {
				const index = Number.parseInt(itemId.slice("option-".length), 10);
				selectedValue = options[index];
				return selectedValue === undefined
					? ({ kind: "stay" } as const)
					: ({ kind: "close" } as const);
			},
		},
	});
	const result = await runBtwMenuPreservingEditor(ctx, (menuContext) =>
		runMenu(menuContext, menu, { getState: () => undefined }),
	);
	return selectedValue !== undefined && result.kind === "closed" && result.reason === "close"
		? { kind: "select", value: selectedValue }
		: terminalBtwMenuAction(result);
}

function terminalBtwMenuAction(result: RunMenuResult): { kind: "back" } | { kind: "close" } {
	if (result.kind === "closed") return { kind: result.reason };
	if (result.kind === "error") throw result.error;
	return { kind: "close" };
}

export async function loadBringToMainDraft(
	draft: string,
	ctx: ExtensionCommandContext,
	summary: BtwBringToMainSummary,
): Promise<BtwBringToMainDelivery> {
	const describeContent = () =>
		`${summary.messages} ${summary.messages === 1 ? "message" : "messages"} (~${summary.tokens} ${summary.tokens === 1 ? "token" : "tokens"})`;
	const existing = ctx.ui.getEditorText();
	if (!existing.trim()) {
		ctx.ui.setEditorText(draft);
		ctx.ui.notify(
			`Brought ${describeContent()} to the main editor. Review and submit when ready.`,
			"info",
		);
		return "loaded";
	}

	const appendOption = "Append after current draft  Recommended";
	const replaceOption = "⚠ Replace current draft  Discards current editor text";
	const cancelOption = "Cancel  Return to the side thread";
	while (true) {
		const action = await showBtwMenu(ctx, "The main editor already has a draft", [
			appendOption,
			replaceOption,
			cancelOption,
		]);
		if (action.kind === "close") return "closed";
		if (action.kind === "back" || action.value === cancelOption) return "back";
		if (action.value === appendOption) {
			ctx.ui.setEditorText(`${ctx.ui.getEditorText()}\n\n${draft}`);
			ctx.ui.notify(
				`Appended ${describeContent()} to the existing main-editor draft. Review and submit when ready.`,
				"info",
			);
			return "loaded";
		}
		if (action.value !== replaceOption) continue;

		const current = ctx.ui.getEditorText();
		const characters = [...current].length;
		const confirmed = await showBtwMenu(
			ctx,
			`Replace the current ${characters}-character editor draft?`,
			["Back  Keep current editor text", "⚠ Replace current draft  Cannot be undone"],
		);
		if (confirmed.kind === "close") return "closed";
		if (confirmed.kind === "back" || confirmed.value === "Back  Keep current editor text") continue;
		if (confirmed.value !== "⚠ Replace current draft  Cannot be undone") continue;
		if (ctx.ui.getEditorText() !== current) {
			ctx.ui.notify(
				"The main editor changed during confirmation. Review the updated draft and choose again.",
				"warning",
			);
			continue;
		}
		ctx.ui.setEditorText(draft);
		ctx.ui.notify(
			`Replaced the main-editor draft with ${describeContent()}. Review and submit when ready.`,
			"info",
		);
		return "loaded";
	}
}

function truncatePreview(text: string): string {
	return text.length <= 72 ? text : `${text.slice(0, 69)}…`;
}

async function askThreadQuestion(
	thread: SideThread,
	question: string,
	selected: ResolvedBtwModel,
	thinkingLevel: BtwThinkingLevel,
	ctx: ExtensionCommandContext,
	steering: BtwThreadSteeringControl,
) {
	return ctx.ui.custom<Awaited<ReturnType<typeof completeSideThreadTurn>>>(
		(tui, theme, keybindings, done) => {
			let settled = false;
			const view = new BtwAnsweringView(
				tui,
				theme,
				thread.turns,
				question,
				() => {
					if (settled) return;
					settled = true;
					done({ kind: "aborted" });
				},
				thinkingLevel,
				{
					steering: {
						questions: steering.questions,
						onSubmit: steering.submit,
						thinking: { ...steering.thinking, keybindings },
					},
				},
			);
			completeSideThreadTurn({
				thread,
				question,
				model: selected.model,
				thinkingLevel,
				auth: selected.auth,
				signal: view.signal,
				completeSimple: createModelRegistryCompleteSimple(ctx.modelRegistry),
				sessionId: readBtwSessionId(ctx),
			}).then((result) => {
				if (settled) return;
				settled = true;
				view.finish();
				done(result);
			});
			return view;
		},
	);
}

async function showThreadComposer(
	thread: SideThread,
	startAtBottom: boolean,
	ctx: ExtensionCommandContext,
	initialQuestion: string | undefined,
	thinking: BtwThreadThinkingControl,
): Promise<TranscriptPagerAction> {
	return ctx.ui.custom<TranscriptPagerAction>(
		(tui, theme, keybindings, done) =>
			new BtwTranscriptPager(tui, theme, thread.turns, done, {
				startAtBottom,
				initialQuestion,
				thinking: { ...thinking, keybindings },
			}),
	);
}
