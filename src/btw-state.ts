import type { Api, Model } from "@earendil-works/pi-ai";
import type { BtwEntryContextInfo, BtwEntryHost } from "./btw-entries.js";
import type { BtwThinkingLevel, SideQuestionAuth, SideThread } from "./side-thread.js";

/** Resolved model + credentials for one side question (see btw.ts resolveBtwModel). */
export interface ResolvedBtwModel {
	model: Model<Api>;
	auth: SideQuestionAuth;
}

export interface BtwThreadState {
	id: string;
	title?: string;
	thread: SideThread;
	thinkingLevel: BtwThinkingLevel;
	/** Context snapshot metadata from thread creation, reused by follow-up entries. */
	contextInfo?: BtwEntryContextInfo;
	createdAt: number;
	updatedAt: number;
}

/** One in-flight side question; cancellable via /btw:cancel or session_shutdown. */
export interface ActiveBtwRun {
	id: string;
	threadId: string;
	question: string;
	host: BtwEntryHost;
	controller: AbortController;
	startedAt: number;
}

/**
 * State shared by the /btw command family: resumable threads (in-memory plus
 * rebuilt from persisted entries) and in-flight runs. Pi creates a fresh
 * extension instance after session replacement, so this lives per-instance and
 * is rebuilt from custom entries on session_start.
 */
export class BtwStateStore {
	readonly threads = new Map<string, BtwThreadState>();
	readonly activeRuns = new Map<string, ActiveBtwRun>();
	/** In-flight standalone/inline runs, awaited on session_shutdown. */
	readonly pendingRuns = new Set<Promise<unknown>>();
	/** Legacy counter for threads created by the upstream fullscreen flow. */
	nextThreadNumber = 1;

	track<T>(promise: Promise<T>): Promise<T> {
		this.pendingRuns.add(promise);
		const release = () => this.pendingRuns.delete(promise);
		promise.then(release, release);
		return promise;
	}

	rememberThread(state: BtwThreadState): void {
		this.threads.delete(state.id);
		this.threads.set(state.id, state);
	}

	findThread(idOrPrefix: string): BtwThreadState | undefined {
		const direct = this.threads.get(idOrPrefix);
		if (direct) return direct;
		const matches = [...this.threads.keys()].filter((id) => id.startsWith(idOrPrefix));
		return matches.length === 1 ? this.threads.get(matches[0]) : undefined;
	}

	latestActiveRun(): ActiveBtwRun | undefined {
		let latest: ActiveBtwRun | undefined;
		for (const run of this.activeRuns.values()) {
			if (!latest || run.startedAt >= latest.startedAt) latest = run;
		}
		return latest;
	}
}
