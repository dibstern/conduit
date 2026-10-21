import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { RpcTest } from "effect/rpc";
import { SqlClient } from "effect/sql";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { __setProbeOverrideForTesting } from "../../../src/lib/provider/claude/claude-capabilities-probe.js";
import type { SDKUserMessage } from "../../../src/lib/provider/claude/types.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import type { ProjectRelayConfig } from "../../../src/lib/types.js";
import { claudeSdk as fakeClaudeSdk } from "../../helpers/fake-claude-process-sdk.js";
import { createTestProjectRelay as createProjectRelay } from "../../helpers/project-relay.js";

// Failure modes at the browser RPC -> durable inbox/outbox -> provider seam:
// - A queued input retains its text but loses attachments during replay.
// - Runner serialization drops a file, its filename/MIME, or decoded bytes.
// - A direct RPC bypasses attachment validation and writes an input/command,
//   or creates a Side Thread before discovering the invalid attachment.
// Only SDK/HTTP transports are faked; relay, admission, queues and runners are real.
describe("Integration: attachment delivery through the relay", () => {
	const text = 'export const greeting = "héllo";\n';
	const pdf = Buffer.from(
		"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
	);
	const files = [
		`data:text/plain;name=notes.ts;base64,${Buffer.from(text).toString("base64")}`,
		`data:application/pdf;name=design.pdf;base64,${pdf.toString("base64")}`,
	];
	const cleanups: (() => Promise<void>)[] = [];

	afterEach(async () => {
		for (const cleanup of cleanups.reverse()) await cleanup();
		cleanups.length = 0;
		vi.restoreAllMocks();
		__setProbeOverrideForTesting(undefined);
	});

	async function startRelay() {
		__setProbeOverrideForTesting(async () => ({
			models: [{ id: "claude-sonnet-4", name: "Sonnet", providerId: "claude" }],
			commands: [],
			agents: [],
		}));
		const root = mkdtempSync(join(tmpdir(), "conduit-attachment-delivery-"));
		const sdkConfig = join(root, "claude");
		mkdirSync(sdkConfig);
		const claudeReceived: SDKUserMessage["message"]["content"][] = [];
		const openCodeReceived: { parts: unknown[] }[] = [];
		const sessions: Record<string, unknown> = {};
		const sdk: NonNullable<ProjectRelayConfig["claudeSdk"]> = {
			...fakeClaudeSdk,
			query: (params) =>
				fakeClaudeSdk.query({
					...params,
					options: {
						...params.options,
						env: { ...params.options?.env, CLAUDE_CONFIG_DIR: sdkConfig },
					},
					prompt: {
						async *[Symbol.asyncIterator]() {
							for await (const message of params.prompt) {
								claudeReceived.push(message.message.content);
								yield message;
							}
						},
					},
				}),
		};
		// Exercise the production OpenCode SDK's HTTP serialization without a
		// listener. This is the same fetch boundary used by relay tracing tests.
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request =
				input instanceof Request ? input : new Request(input, init);
			const pathname = new URL(request.url).pathname;
			const json = (value: unknown) =>
				new Response(JSON.stringify(value), {
					headers: { "Content-Type": "application/json" },
				});
			if (pathname === "/path")
				return json({
					state: root,
					config: root,
					worktree: root,
					directory: root,
				});
			if (pathname === "/config") return json({});
			if (pathname === "/provider")
				return json({
					all: [
						{
							id: "openai",
							name: "OpenAI",
							models: {
								"gpt-4": {
									id: "gpt-4",
									name: "GPT-4",
									limit: { context: 8192, output: 4096 },
								},
							},
						},
					],
					default: { openai: "gpt-4" },
					connected: ["openai"],
				});
			if (pathname === "/event" || pathname === "/global/event")
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(
									'data: {"payload":{"type":"server.connected","properties":{}}}\n\n',
								),
							);
							request.signal.addEventListener(
								"abort",
								() => controller.close(),
								{ once: true },
							);
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			if (pathname === "/session/status") return json({});
			if (
				["/permission", "/question", "/agent", "/command", "/skill"].includes(
					pathname,
				)
			)
				return json([]);
			if (pathname === "/session") {
				if (request.method === "POST") {
					const id = randomUUID();
					const session = {
						id,
						projectID: "attachment-delivery",
						directory: root,
						title: "Attachments",
						version: "1",
						time: { created: Date.now(), updated: Date.now() },
					};
					sessions[id] = session;
					return json(session);
				}
				return json(Object.values(sessions));
			}
			const prompt = /^\/session\/([^/]+)\/prompt_async$/.exec(pathname);
			if (prompt && request.method === "POST") {
				openCodeReceived.push((await request.json()) as { parts: unknown[] });
				return new Response(null, { status: 204 });
			}
			if (/^\/session\/[^/]+\/message$/.test(pathname)) return json([]);
			const session = /^\/session\/([^/]+)$/.exec(pathname)?.[1];
			if (session && sessions[session]) return json(sessions[session]);
			return new Response("Not found", { status: 404 });
		});
		const server = createServer();
		const relay = await createProjectRelay({
			httpServer: server,
			noServer: true,
			opencodeUrl: "http://opencode.test",
			projectDir: root,
			configDir: join(root, "config"),
			persistenceDbPath: join(root, "events.db"),
			slug: "attachment-delivery",
			claudeSdk: sdk,
			publishGlobalSetting: () => Effect.void,
			statusPollerInterval: 60_000,
			messagePollerInterval: 60_000,
			log: createSilentLogger(),
		});
		cleanups.push(async () => {
			await relay.stop();
			server.close();
			rmSync(root, { recursive: true, force: true });
		});
		const rpcContext = relay.rpcWsHandler.context;
		if (!rpcContext) throw new Error("Expected the relay's RPC context");
		const context = await Effect.runPromise(rpcContext);
		return { context, claudeReceived, openCodeReceived };
	}

	for (const provider of ["claude", "opencode"] as const) {
		it(`delivers queued text and PDF bytes to ${provider}`, async () => {
			const { context, claudeReceived, openCodeReceived } = await startRelay();
			await Effect.runPromise(
				Effect.gen(function* () {
					const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
						Effect.provide(WsRpcServerLayer),
					);
					const { sessionId } = yield* client.CreateSession({
						projectSlug: "attachment-delivery",
						originId: `browser-${provider}`,
						providerId: provider,
						permissionMode: "ask",
						model: {
							providerId: provider === "claude" ? "claude" : "openai",
							modelId: provider === "claude" ? "claude-sonnet-4" : "gpt-4",
							variant: "",
							contextWindow: "",
						},
					});
					const persist = yield* ClaudeEventPersistEffectTag;
					const runId = randomUUID();
					yield* persist.persistEvent(
						canonicalEvent(
							"run.requested",
							sessionId,
							{ runId, inputId: "blocking-input" },
							{ provider, metadata: { runId } },
						),
					);
					yield* persist.persistEvent(
						canonicalEvent("session.status", sessionId, {
							sessionId,
							status: "busy",
						}),
					);
					const inputId = randomUUID();
					expect(
						yield* client["input.submit"]({
							sessionId,
							inputId,
							text: "",
							images: files,
							delivery: "queue",
						}),
					).toEqual({ ok: true, sessionId, handedOff: false });
					const sql = yield* SqlClient.SqlClient;
					const [queued] = yield* sql<{
						state: string;
						request: string;
					}>`SELECT state, request FROM pending_inputs WHERE input_id = ${inputId}`;
					expect(queued?.state).toBe("queued");
					expect(JSON.parse(queued?.request ?? "null")).toMatchObject({
						text: "",
						images: files,
					});
					expect(
						yield* sql`SELECT command_id FROM provider_command_outbox WHERE command_id = ${inputId}`,
					).toHaveLength(0);
					yield* persist.persistEvent(
						provider === "opencode"
							? canonicalEvent(
									"session.status",
									sessionId,
									{ sessionId, status: "idle" },
									{ provider, metadata: { runId } },
								)
							: canonicalEvent(
									"turn.completed",
									sessionId,
									{ messageId: "" },
									{ provider, metadata: { runId } },
								),
					);
					yield* Effect.promise(() =>
						vi.waitFor(
							() => {
								if (provider === "claude")
									expect(claudeReceived).toHaveLength(1);
								else expect(openCodeReceived).toHaveLength(1);
							},
							{ timeout: 5_000, interval: 20 },
						),
					);
					expect(
						yield* sql`SELECT command_id FROM provider_command_outbox WHERE command_id = ${inputId} AND effect_type = 'send_turn'`,
					).toHaveLength(1);
				}).pipe(Effect.provide(context), Effect.scoped),
			);

			if (provider === "claude") {
				const content = claudeReceived[0];
				expect(content).toEqual([
					{
						type: "document",
						title: "notes.ts",
						source: { type: "text", media_type: "text/plain", data: text },
					},
					{
						type: "document",
						title: "design.pdf",
						source: {
							type: "base64",
							media_type: "application/pdf",
							data: pdf.toString("base64"),
						},
					},
				]);
				if (typeof content === "string")
					throw new Error("Expected Claude document blocks");
				const source = content?.[1];
				if (source?.type !== "document" || source.source.type !== "base64")
					throw new Error("Expected a PDF content block");
				expect(Buffer.from(source.source.data, "base64")).toEqual(pdf);
			} else {
				expect(openCodeReceived[0]?.parts).toEqual([
					{
						type: "file",
						mime: "text/plain",
						filename: "notes.ts",
						url: `data:text/plain;base64,${Buffer.from(text).toString("base64")}`,
					},
					{
						type: "file",
						mime: "application/pdf",
						filename: "design.pdf",
						url: `data:application/pdf;base64,${pdf.toString("base64")}`,
					},
				]);
				const parts = openCodeReceived[0]?.parts as { url: string }[];
				expect(
					parts.map(({ url }) =>
						Buffer.from(url.slice(url.indexOf(",") + 1), "base64"),
					),
				).toEqual([Buffer.from(text), pdf]);
			}
		}, 15_000);
	}

	it("rejects invalid direct RPC attachments before inbox, outbox or Side Thread writes", async () => {
		const { context, claudeReceived, openCodeReceived } = await startRelay();
		await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
					Effect.provide(WsRpcServerLayer),
				);
				const { sessionId } = yield* client.CreateSession({
					projectSlug: "attachment-delivery",
					originId: "invalid-attachments",
					providerId: "claude",
					permissionMode: "ask",
					model: {
						providerId: "claude",
						modelId: "claude-sonnet-4",
						variant: "",
						contextWindow: "",
					},
				});
				const sql = yield* SqlClient.SqlClient;
				const before = yield* sql`SELECT id FROM sessions ORDER BY id`;
				const commandsBefore =
					yield* sql`SELECT request_sequence FROM provider_command_outbox ORDER BY request_sequence`;
				for (const invalid of [
					{
						url: `data:text/plain;base64,${Buffer.alloc(4 * 1024 * 1024, "x").toString("base64")}`,
						error: /5 MiB|5 MB|too large|size limit|exceed/i,
					},
					{
						url: `data:image/png;base64,${Buffer.alloc(4 * 1024 * 1024, "x").toString("base64")}`,
						error: /5 MiB|5 MB|too large|size limit|exceed/i,
					},
					{
						url: "data:application/zip;base64,UEsDBA==",
						error: /unsupported attachment|plain text|PDF/i,
					},
				]) {
					for (const method of ["input.submit", "StartSideThread"] as const) {
						const inputId = randomUUID();
						const result = yield* Effect.result(
							method === "input.submit"
								? client["input.submit"]({
										sessionId,
										inputId,
										text: "Review",
										images: [invalid.url],
										delivery: "queue",
										originId: inputId,
									}).pipe(Effect.asVoid)
								: client
										.StartSideThread({
											sessionId,
											inputId,
											title: "Side Thread",
											text: "Review",
											images: [invalid.url],
											originId: inputId,
										})
										.pipe(Effect.asVoid),
						);
						expect(result._tag).toBe("Failure");
						if (result._tag === "Failure")
							expect(String(result.failure)).toMatch(invalid.error);
						expect(
							yield* sql`SELECT input_id FROM pending_inputs WHERE input_id = ${inputId}`,
						).toHaveLength(0);
						expect(
							yield* sql`SELECT sequence FROM events WHERE type = 'input.admitted' AND json_extract(data, '$.inputId') = ${inputId}`,
						).toHaveLength(0);
						expect(
							yield* sql`SELECT command_id FROM provider_command_outbox WHERE command_id = ${inputId}`,
						).toHaveLength(0);
						expect(yield* sql`SELECT id FROM sessions ORDER BY id`).toEqual(
							before,
						);
						expect(
							yield* sql`SELECT request_sequence FROM provider_command_outbox ORDER BY request_sequence`,
						).toEqual(commandsBefore);
					}
				}
			}).pipe(Effect.provide(context), Effect.scoped),
		);
		expect(claudeReceived).toHaveLength(0);
		expect(openCodeReceived).toHaveLength(0);
	}, 15_000);
});
