/**
 * 82tn.81: record a native OpenCode fork on the wire, modelled on t3code's
 * opencode2_fork (two turns, fork before the second user message, a turn on
 * the fork). The requests follow conduit's own (classic `prompt_async`, the
 * reads a daemon makes at start), so MockOpenCodeServer can replay the trace
 * behind a daemon: test/integration/flows/opencode-fork-run-ownership.
 *
 * RUN_EXPENSIVE_E2E=1 pnpm exec vitest run --config vitest.e2e.config.ts \
 *   test/e2e/provider/opencode-fork-wire-capture.test.ts
 *
 * Spawns the installed opencode-ai with a scripted local model (no network),
 * records every REST call and SSE event through a RecordingProxy, and writes
 * test/e2e/fixtures/recorded/opencode-native-fork.opencode.json.gz after its
 * assertions pass. Review the recording before committing it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { resolveRealOpenCode } from "../../helpers/real-opencode.js";
import { RecordingProxy } from "../../helpers/recording-proxy.js";
import type { OpenCodeRecording } from "../fixtures/recorded/types.js";
import { spawnOpenCode } from "../helpers/opencode-spawner.js";

const RUN_EXPENSIVE = process.env["RUN_EXPENSIVE_E2E"] === "1";
const RECORDING = join(
	import.meta.dirname,
	"../fixtures/recorded/opencode-native-fork.opencode.json.gz",
);
const MODEL = { providerID: "fork-test", modelID: "fork" };

interface WireEvent {
	readonly type: string;
	readonly properties: Record<string, unknown>;
}
interface WireMessage {
	readonly info: { id: string; role: string; sessionID: string };
	readonly parts: ReadonlyArray<{ type: string; text?: string }>;
}

describe.skipIf(!RUN_EXPENSIVE)("OpenCode fork wire capture", () => {
	it("records two turns, a fork before the second, and a turn on the fork", async () => {
		// Answers "Heard <fork-x>." to the last user turn, and keeps every request's user turns.
		const modelInputs: string[][] = [];
		const model = createServer(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += String(chunk);
			const input = JSON.parse(body) as {
				messages: Array<{ role: string; content: unknown }>;
			};
			const users = input.messages
				.filter(({ role }) => role === "user")
				.map(({ content }) =>
					typeof content === "string" ? content : JSON.stringify(content),
				);
			modelInputs.push(users);
			const asked = /\b(fork-[\w-]+)/.exec(users.at(-1) ?? "")?.[1];
			const chunk = (delta: object, finish: string | null) =>
				`data: ${JSON.stringify({ id: "fork", created: 1, model: "fork", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`;
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.write(
				chunk(
					{ role: "assistant", content: `Heard ${asked ?? "nothing"}.` },
					null,
				),
			);
			response.write(chunk({}, "stop"));
			response.end("data: [DONE]\n\n");
		});
		await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
		const address = model.address();
		if (!address || typeof address === "string") throw new Error("No port");
		const directory = mkdtempSync(join(tmpdir(), "opencode-fork-work-"));
		const spawned = await spawnOpenCode({
			env: {
				PATH: `${dirname(resolveRealOpenCode())}:${process.env["PATH"] ?? ""}`,
				OPENCODE_CONFIG_CONTENT: JSON.stringify({
					enabled_providers: ["fork-test"],
					model: "fork-test/fork",
					small_model: "fork-test/fork",
					permission: { "*": "allow" },
					provider: {
						"fork-test": {
							npm: "@ai-sdk/openai-compatible",
							options: {
								baseURL: `http://127.0.0.1:${address.port}/v1`,
								apiKey: "test",
							},
							models: {
								fork: {
									name: "Scripted fork",
									limit: { context: 16384, output: 1024 },
									cost: { input: 0, output: 0 },
								},
							},
						},
					},
				}),
			},
		});
		const proxy = new RecordingProxy(spawned.url);
		const controller = new AbortController();
		try {
			await proxy.start();
			const url = (path: string) =>
				`${proxy.url}${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`;
			// The proxy forwards OpenCode's content-encoding over a decoded body.
			const headers = {
				"accept-encoding": "identity",
				"content-type": "application/json",
			};
			const get = async <T>(path: string): Promise<T> =>
				(await (await fetch(url(path), { headers })).json()) as T;
			const post = async <T>(path: string, body: unknown): Promise<T> => {
				const text = await (
					await fetch(url(path), {
						method: "POST",
						headers,
						body: JSON.stringify(body),
					})
				).text();
				return (text ? JSON.parse(text) : undefined) as T;
			};
			const events: WireEvent[] = [];
			// Resolves the turn waiting on a session when OpenCode reports it idle.
			const idled = new Map<string, () => void>();
			const reader = (
				await fetch(url("/event"), { signal: controller.signal })
			).body?.getReader();
			if (!reader) throw new Error("No SSE body");
			const pump = (async () => {
				const decoder = new TextDecoder();
				let buffer = "";
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) return;
						buffer += decoder.decode(value, { stream: true });
						const blocks = buffer.split("\n\n");
						buffer = blocks.pop() ?? "";
						for (const line of blocks.flatMap((b) => b.split("\n"))) {
							if (!line.startsWith("data: ")) continue;
							const event = JSON.parse(line.slice(6)) as WireEvent;
							events.push(event);
							if (event.type === "session.idle")
								idled.get(String(event.properties["sessionID"]))?.();
						}
					}
				} catch {
					// Aborted at the end.
				}
			})();
			const turn = async (sessionID: string, text: string) => {
				// A daemon reads the session before it prompts.
				await get(`/session/${sessionID}`);
				const idle = new Promise<void>((done) => idled.set(sessionID, done));
				await post(`/session/${sessionID}/prompt_async`, {
					parts: [{ type: "text", text }],
					model: MODEL,
				});
				await idle;
				return get<WireMessage[]>(`/session/${sessionID}/message`);
			};
			// The reads a daemon makes at start, so a replay serves them.
			for (const path of [
				"/path",
				"/session",
				"/session/status",
				"/permission",
				"/question",
				"/provider",
				"/agent",
			])
				await get(path);
			const source = await post<{ id: string }>("/session", {
				title: "OpenCode source",
			});
			await turn(source.id, "Remember fork-one.");
			const before = await turn(source.id, "Remember fork-two.");
			const cut = before.filter((m) => m.info.role === "user")[1]?.info.id;
			const fork = await post<{ id: string; title: string }>(
				`/session/${source.id}/fork`,
				{ messageID: cut },
			);
			await get(`/session/${fork.id}/message?limit=1`);
			const copies = await get<WireMessage[]>(`/session/${fork.id}/message`);
			const after = await turn(fork.id, "Now fork-three.");
			await get("/session");
			await get("/session/status");
			controller.abort();
			await pump;
			const transcript = (messages: readonly WireMessage[]) =>
				messages.map(
					(m) =>
						`${m.info.role}: ${m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("")}`,
				);
			expect(fork.id).not.toBe(source.id);
			expect(transcript(copies)).toEqual([
				"user: Remember fork-one.",
				"assistant: Heard fork-one.",
			]);
			// Every copy is a new message under the fork.
			expect(
				copies.filter((m) =>
					before.some((original) => original.info.id === m.info.id),
				),
			).toEqual([]);
			expect(transcript(after).slice(2)).toEqual([
				"user: Now fork-three.",
				"assistant: Heard fork-three.",
			]);
			expect(modelInputs.at(-1)).toEqual([
				"Remember fork-one.",
				"Now fork-three.",
			]);
			const recording: OpenCodeRecording = {
				name: "opencode-native-fork",
				recordedAt: new Date().toISOString(),
				opencodeVersion: (
					(await (await fetch(`${spawned.url}/global/health`)).json()) as {
						version: string;
					}
				).version,
				interactions: proxy.getRecording(),
			};
			mkdirSync(dirname(RECORDING), { recursive: true });
			writeFileSync(
				RECORDING,
				gzipSync(
					JSON.stringify(recording, null, 1).replaceAll(directory, "/tmp/fork"),
				),
			);
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/opencode-fork-wire-capture.json",
				JSON.stringify(
					{
						opencodeVersion: recording.opencodeVersion,
						source: source.id,
						fork: fork.id,
						title: fork.title,
						interactions: recording.interactions.length,
						copies: copies.map((m) => m.info.id),
						modelInputs,
					},
					null,
					2,
				),
			);
		} finally {
			controller.abort();
			await proxy.stop();
			spawned.stop();
			model.closeAllConnections();
			model.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
