import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// End-to-end RPC verification against the real installed `pi` binary and a
// local mock OpenAI-compatible upstream. Run: node scripts/e2e-rpc.mjs

const packageRoot = resolve(new URL("..", import.meta.url).pathname);
const PI_BIN = process.env.PI_BTW_E2E_PI ?? "pi";

interface RpcMessage {
	type?: string;
	command?: string;
	success?: boolean;
	data?: Record<string, never>;
	method?: string;
	message?: string;
	[key: string]: unknown;
}

class RpcClient {
	private buffer = "";
	private waiters: Array<{
		predicate: (message: RpcMessage) => boolean;
		resolve: (message: RpcMessage) => void;
		reject: (error: Error) => void;
		timer: NodeJS.Timeout;
	}> = [];
	readonly log: RpcMessage[] = [];
	readonly child;

	constructor(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
		this.child = spawn(PI_BIN, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => {
			if (process.env.PI_BTW_E2E_DEBUG) process.stderr.write(`[stderr] ${chunk}`);
		});
		this.child.on("exit", (code) => {
			if (process.env.PI_BTW_E2E_DEBUG) {
				process.stderr.write(
					`[exit] ${code}\n[exit-log-tail] ${JSON.stringify(this.log.slice(-8))}\n`,
				);
			}
		});
	}

	private onData(chunk: string) {
		this.buffer += chunk;
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			newline = this.buffer.indexOf("\n");
			if (!line) continue;
			let message: RpcMessage;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			this.log.push(message);
			for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
				const waiter = this.waiters[index];
				if (!waiter.predicate(message)) continue;
				this.waiters.splice(index, 1);
				clearTimeout(waiter.timer);
				waiter.resolve(message);
			}
		}
	}

	send(command: Record<string, unknown>): void {
		this.child.stdin.write(`${JSON.stringify(command)}\n`);
	}

	waitFor(predicate: (message: RpcMessage) => boolean, timeoutMs = 20_000): Promise<RpcMessage> {
		const existing = this.log.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolvePromise, rejectPromise) => {
			const timer = setTimeout(() => {
				if (process.env.PI_BTW_E2E_DEBUG) {
					process.stderr.write(`[timeout] last msgs: ${JSON.stringify(this.log.slice(-6))}\n`);
				}
				rejectPromise(new Error("timed out waiting for RPC message"));
			}, timeoutMs);
			this.waiters.push({ predicate, resolve: resolvePromise, reject: rejectPromise, timer });
		});
	}

	async close(): Promise<void> {
		this.child.stdin.end();
		if (this.child.exitCode !== null || this.child.killed) return;
		await new Promise((resolvePromise) => {
			this.child.on("exit", resolvePromise);
			setTimeout(() => this.child.kill("SIGKILL"), 5_000).unref();
		});
		for (const waiter of this.waiters.splice(0)) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error("client closed"));
		}
	}
}

function sseChunk(content: string): string {
	return `data: ${JSON.stringify({
		id: "mock",
		object: "chat.completion.chunk",
		choices: [{ index: 0, delta: { content } }],
	})}\n\n`;
}

async function startMockUpstream(): Promise<{ server: Server; port: number }> {
	const server = createServer((request, response) => {
		if (request.method !== "POST" || !request.url?.includes("chat/completions")) {
			response.writeHead(404).end();
			return;
		}
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			// Side questions carry the fork's system prompt; the branch context can
			// legitimately contain the SLOWMAIN marker, so classify by role first.
			const isSide = body.includes("quick side questions for a coding-agent user");
			const slow = body.includes("SLOWMAIN") || body.includes("SLOWSIDE");
			const chunks = isSide
				? body.includes("SLOWSIDE")
					? Array.from({ length: 12 }, (_, index) => `side-chunk-${index} `)
					: ["Side answer: 4."]
				: slow
					? Array.from({ length: 8 }, (_, index) => `main-chunk-${index} `)
					: ["Main answer."];
			const delay = isSide ? (body.includes("SLOWSIDE") ? 350 : 0) : slow ? 350 : 0;
			response.writeHead(200, { "content-type": "text/event-stream" });
			let index = 0;
			const push = () => {
				if (index >= chunks.length) {
					response.write(
						`data: ${JSON.stringify({
							id: "mock",
							object: "chat.completion.chunk",
							choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						})}\n\n`,
					);
					response.write("data: [DONE]\n\n");
					response.end();
					return;
				}
				response.write(sseChunk(chunks[index] ?? ""));
				index += 1;
				setTimeout(push, delay);
			};
			push();
		});
	});
	await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	if (address === null || (typeof address === "object" && !address.port)) {
		throw new Error("mock upstream did not bind");
	}
	return { server, port: (address as { port: number }).port };
}

async function createAgentDir(port: number): Promise<{ agentDir: string; projectDir: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-btw-e2e-"));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	await mkdir(agentDir, { recursive: true });
	await mkdir(projectDir, { recursive: true });
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				mock: {
					name: "mock-upstream",
					baseUrl: `http://127.0.0.1:${port}/v1`,
					api: "openai-completions",
					apiKey: "e2e-test-key",
					models: [
						{
							id: "mock-model",
							name: "mock-model",
							input: ["text"],
							contextWindow: 128000,
							maxTokens: 4096,
						},
					],
				},
			},
		}),
	);
	return { agentDir, projectDir };
}

function piEnv(agentDir: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		// Keep the e2e run hermetic: no telemetry, no user theme/state surprises.
		PI_TELEMETRY: "0",
		TERM: "dumb",
	};
}

function btwEvents(client: RpcClient) {
	return client.log
		.filter(
			(message) =>
				message.type === "extension_ui_request" &&
				message.method === "notify" &&
				typeof message.message === "string" &&
				message.message.startsWith("BTW_EVENT:"),
		)
		.map(
			(message) =>
				JSON.parse((message.message as string).slice("BTW_EVENT:".length)) as Record<
					string,
					unknown
				>,
		);
}

const hasPi = await new Promise<boolean>((resolvePromise) => {
	const probe = spawn("sh", ["-c", `command -v ${PI_BIN}`]);
	probe.on("exit", (code) => resolvePromise(code === 0));
	probe.on("error", () => resolvePromise(false));
});

if (!hasPi) {
	console.error(`SKIP: ${PI_BIN} binary not found on PATH`);
	process.exit(0);
}

const step = (name: string) => process.stderr.write(`[step] ${name}\n`);
await (async () => {
	const { server, port } = await startMockUpstream();
	const { agentDir, projectDir } = await createAgentDir(port);
	const extension = join(packageRoot, "dist", "index.ts");
	const client = new RpcClient(
		["--mode", "rpc", "--no-extensions", "-e", extension, "--model", "mock/mock-model"],
		piEnv(agentDir),
		projectDir,
	);
	try {
		// Sanity: the extension command is listed.
		step("get_commands");
		client.send({ type: "get_commands" });
		const commands = await client.waitFor(
			(message) => message.type === "response" && message.command === "get_commands",
		);
		assert.equal(commands.success, true, JSON.stringify(commands));

		// A2: /btw during an active main agent run.
		step("prompt slowmain");
		client.send({ type: "prompt", message: "SLOWMAIN keep streaming slowly" });
		await client.waitFor((message) => message.type === "agent_start");
		step("prompt btw");
		client.send({ type: "prompt", message: "/btw what is 2+2?" });
		const promptAck = await client.waitFor(
			(message) =>
				message.type === "response" && message.command === "prompt" && message.success === true,
		);
		assert.ok(promptAck);

		step("wait completed");
		await client.waitFor(() => btwEvents(client).some((event) => event.event === "completed"));
		step("completed seen");
		const events = btwEvents(client);
		const kinds = events.map((event) => event.event);
		assert.deepEqual(
			kinds.filter((kind) => kind !== "delta"),
			["accepted", "running", "completed"],
		);
		const completed = events.at(-1) as Record<string, unknown> & {
			id: string;
			text: string;
			context: { mode: string };
		};
		assert.equal(completed.text, "Side answer: 4.");
		assert.equal(completed.context.mode, "branch");

		// Main run finishes; then inspect session integrity.
		step("wait agent_end");
		await client.waitFor((message) => message.type === "agent_end", 30_000);
		step("get_messages");
		client.send({ type: "get_messages" });
		const messagesResponse = await client.waitFor(
			(message) => message.type === "response" && message.command === "get_messages",
		);
		const mainMessages = (messagesResponse.data as { messages: Array<{ role?: string }> }).messages;
		const serialized = JSON.stringify(mainMessages);
		assert.equal(serialized.includes("what is 2+2"), false, "side question stayed out of context");
		assert.equal(serialized.includes("Side answer"), false, "side answer stayed out of context");

		step("get_entries");
		client.send({ type: "get_entries" });
		const entriesResponse = await client.waitFor(
			(message) => message.type === "response" && message.command === "get_entries",
		);
		const entries = (entriesResponse.data as { entries: Array<Record<string, unknown>> }).entries;
		const btwEntries = entries.filter(
			(entry) => entry.type === "custom" && entry.customType === "btw",
		);
		assert.equal(btwEntries.length, 1, "exactly one custom/btw entry was appended");
		const entryData = btwEntries[0]?.data as { status: string; answer: string; id: string };
		assert.equal(entryData.status, "completed");
		assert.equal(entryData.answer, "Side answer: 4.");

		// A4: restart with --continue; history survives, context stays clean.
		await client.close();
		step("resume start");
		const resumed = new RpcClient(
			["--mode", "rpc", "--no-extensions", "-e", extension, "-c", "--model", "mock/mock-model"],
			piEnv(agentDir),
			projectDir,
		);
		try {
			step("resumed history");
			resumed.send({ type: "prompt", message: "/btw:history" });
			await resumed.waitFor(() =>
				btwEvents(resumed).some((event) => event.event === "history" && Array.isArray(event.items)),
			);
			const history = btwEvents(resumed).find((event) => event.event === "history") as {
				items: Array<{ question: string; status: string }>;
			};
			assert.equal(history.items.length, 1);
			assert.equal(history.items[0]?.question, "what is 2+2?");

			resumed.send({ type: "get_messages" });
			const resumedMessages = await resumed.waitFor(
				(message) => message.type === "response" && message.command === "get_messages",
			);
			assert.equal(
				JSON.stringify(resumedMessages.data).includes("Side answer"),
				false,
				"resumed main context has no side answer",
			);
		} finally {
			await resumed.close();
		}

		// A3: cancel a slow side question via /btw:cancel.
		const { agentDir: cancelAgentDir, projectDir: cancelProjectDir } = await createAgentDir(port);
		step("cancel scenario");
		const cancelling = new RpcClient(
			["--mode", "rpc", "--no-extensions", "-e", extension, "--model", "mock/mock-model"],
			piEnv(cancelAgentDir),
			cancelProjectDir,
		);
		try {
			step("cancel prompt");
			cancelling.send({ type: "prompt", message: "/btw SLOWSIDE stream slowly" });
			step("cancel wait");
			await cancelling.waitFor(() =>
				btwEvents(cancelling).some((event) => event.event === "accepted"),
			);
			const accepted = btwEvents(cancelling).find((event) => event.event === "accepted") as {
				id: string;
			};
			cancelling.send({ type: "prompt", message: `/btw:cancel ${accepted.id}` });
			await cancelling.waitFor(
				() => btwEvents(cancelling).some((event) => event.event === "cancelled"),
				10_000,
			);
			const cancelledEvent = btwEvents(cancelling).find((event) => event.event === "cancelled");
			assert.equal(cancelledEvent?.id, accepted.id);
			assert.equal(cancelledEvent?.text, undefined);

			cancelling.send({ type: "get_entries" });
			const cancelEntries = await cancelling.waitFor(
				(message) => message.type === "response" && message.command === "get_entries",
			);
			const cancelBtwEntries = (
				cancelEntries.data as { entries: Array<Record<string, unknown>> }
			).entries.filter((entry) => entry.type === "custom" && entry.customType === "btw");
			assert.equal(cancelBtwEntries.length, 1);
			const cancelData = cancelBtwEntries[0]?.data as { status: string; answer: string };
			assert.equal(cancelData.status, "cancelled");
			assert.equal(cancelData.answer, "", "no partial answer leaked into the entry");
		} finally {
			await cancelling.close();
		}
	} finally {
		await client.close().catch(() => undefined);
		server.closeAllConnections?.();
		server.close();
	}
})();
console.log("E2E RPC OK: A2 (in-stream /btw), A3 (cancel), A4 (resume history) verified");
process.exit(0);
