import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option, PubSub, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { expect, it, vi } from "vitest";
import type { OpenCodeInstanceEvent } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { OrchestrationEngineTag } from "../../../src/lib/domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import type { ProjectRelay } from "../../../src/lib/relay/relay-stack.js";
import {
	makeMockOpenCodeAPI,
	makeOpenCodeInstancesStub,
} from "../../helpers/mock-factories.js";
import { createTestProjectRelay as createProjectRelay } from "../../helpers/project-relay.js";

it.each([
	"ready",
	"failed",
	"hung",
] as const)("wires a confirmed instance stop to the relay's exact pending send with %s shell readiness", async (readiness) => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-stop-recovery-"));
	const filename = join(dir, "events.db");
	const client = makeMockOpenCodeAPI();
	vi.spyOn(client.session, "statuses").mockResolvedValue({
		s: { type: "busy" },
	});
	const bus = await Effect.runPromise(
		PubSub.unbounded<OpenCodeInstanceEvent>(),
	);
	const instances = {
		...makeOpenCodeInstancesStub({ opencode: client }),
		events: () => Stream.fromPubSub(bus),
	};
	const server = createServer();
	const shellEnv = { SYNTHETIC_ENV: "process-fallback" };
	const prepareShellEnv = vi.fn(() => {
		if (readiness === "failed")
			return Promise.reject(new Error("Capture failed"));
		if (readiness === "hung") return new Promise<boolean>(() => {});
		return Promise.resolve(true);
	});
	let relay: ProjectRelay | undefined;
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				yield* store.appendBatch([
					canonicalEvent("session.created", "s", {
						sessionId: "s",
						provider: "opencode",
						title: "Stop",
					}),
					canonicalEvent(
						"run.started",
						"s",
						{ inputId: "native-user", requestedRunId: "r" },
						{ metadata: { runId: "r" } },
					),
				]);
			}).pipe(
				Effect.provide(makePersistenceEffectLayer(filename, "stop-recovery"), {
					local: true,
				}),
			),
		);
		relay = await createProjectRelay({
			shellEnv: () => shellEnv,
			prepareShellEnv,
			httpServer: server,
			opencodeUrl: "http://opencode.test",
			openCodeInstances: instances,
			projectDir: dir,
			slug: "stop-recovery",
			configDir: dir,
			persistenceDbPath: filename,
			publishGlobalSetting: () => Effect.void,
			log: createSilentLogger(),
		});
		let result: string | undefined;
		const deliver = vi.spyOn(
			relay.orchestration.openCodeInstance,
			"sendTurnEffect",
		);
		if (readiness === "hung")
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const send = relay.effectRuntime.runtime
			.runPromise(
				Effect.gen(function* () {
					const engine = yield* OrchestrationEngineTag;
					return yield* engine.dispatchEffect({
						type: "send_turn",
						commandId: "input",
						providerId: "opencode",
						input: {
							sessionId: "s",
							inputId: "input",
							runId: "r",
							prompt: "Continue",
							history: [],
							providerState: {},
							workspaceRoot: dir,
							extraFolders: [],
							abortSignal: new AbortController().signal,
							eventSink: {
								push: () => Effect.void,
								requestPermission: () => Effect.succeed({ decision: "once" }),
								requestQuestion: () => Effect.succeed({}),
								resolvePermission: () => Effect.void,
								resolveQuestion: () => Effect.void,
							},
						},
					});
				}),
			)
			.then((completion) => {
				result = completion.status;
				return completion;
			});
		// Relay disposal interrupts this waiter if an earlier assertion fails.
		void send.catch(() => undefined);
		if (readiness === "hung") {
			await vi.waitFor(() => expect(prepareShellEnv).toHaveBeenCalledWith(dir));
			expect(deliver).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(10_000);
		}
		await vi.waitFor(() =>
			expect(client.session.prompt).toHaveBeenCalledTimes(1),
		);
		expect(prepareShellEnv).toHaveBeenCalledWith(dir);
		expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ shellEnv }));
		await Effect.runPromise(
			PubSub.publish(bus, {
				_tag: "connection",
				instanceId: "opencode",
				state: "stopped",
				managedStopped: true,
				health: {
					connected: false,
					lastEventAt: null,
					reconnectCount: 0,
					stale: false,
				},
			}),
		);
		await vi.waitFor(() => expect(result).toBe("interrupted"), {
			timeout: 500,
			interval: 10,
		});
		expect((await send).error?.code).toBe("interrupted");
		expect(
			await relay.effectRuntime.runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					return {
						runs: yield* sql`SELECT status FROM provider_runs WHERE id = 'r'`,
						commands:
							yield* sql`SELECT status FROM provider_command_outbox WHERE command_id = 'input'`,
					};
				}),
			),
		).toEqual({
			runs: [{ status: "interrupted" }],
			commands: [{ status: "failed" }],
		});
	} finally {
		vi.useRealTimers();
		await relay?.stop();
		server.close();
		await Effect.runPromise(PubSub.shutdown(bus));
		rmSync(dir, { recursive: true, force: true });
	}
});

for (const native of [
	"matching",
	"other-session",
	"other-directory",
	"moved-idle",
	"moved-busy",
	"reset-idle",
	"reset-busy",
] as const) {
	it(`validates ${native} native session before accepting an omitted startup status`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-native-recovery-"));
		const filename = join(dir, "events.db");
		const nativeDirectory = join(dir, "native-extra");
		const moved = native === "moved-idle" || native === "moved-busy";
		const reset = native === "reset-idle" || native === "reset-busy";
		const client = makeMockOpenCodeAPI();
		vi.spyOn(client.session, "statuses").mockImplementation(async (scope) =>
			(native === "moved-busy" && scope === dir) ||
			(native === "reset-busy" && scope === nativeDirectory)
				? { s: { type: "busy" } }
				: {},
		);
		const detail = await client.session.get("s");
		vi.spyOn(client.session, "get").mockResolvedValue({
			...detail,
			id: native === "other-session" ? "unrelated" : "s",
			directory: native === "other-directory" || moved ? dir : nativeDirectory,
		});
		const directories: (string | null | undefined)[] = [];
		const instances = {
			...makeOpenCodeInstancesStub({ opencode: client }),
			ifRunning: (_instanceId: string, directory?: string | null) =>
				Effect.sync(() => {
					directories.push(directory);
					return Option.some(client);
				}),
		};
		const server = createServer();
		let relay: ProjectRelay | undefined;
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* EventStoreEffectTag;
					yield* store.appendBatch([
						canonicalEvent(
							"session.created",
							"s",
							{ sessionId: "s", provider: "opencode", title: "Native" },
							{ metadata: { nativeDirectory: moved ? dir : nativeDirectory } },
						),
						...(moved
							? [
									canonicalEvent("session.workspace_changed", "s", {
										sessionId: "s",
										path: nativeDirectory,
										cause: "user",
										origin: "existing",
										worktrees: { [dir]: nativeDirectory },
									}),
								]
							: []),
						...(reset
							? [
									canonicalEvent("session.workspace_changed", "s", {
										sessionId: "s",
										path: dir,
										cause: "user",
										origin: "existing",
										worktrees: {},
									}),
								]
							: []),
						canonicalEvent(
							"run.started",
							"s",
							{ inputId: "native-user", requestedRunId: "r" },
							{ metadata: { runId: "r" } },
						),
					]);
				}).pipe(
					Effect.provide(
						makePersistenceEffectLayer(filename, "native-recovery"),
						{ local: true },
					),
				),
			);
			relay = await createProjectRelay({
				shellEnv: () => ({}),
				httpServer: server,
				opencodeUrl: "http://opencode.test",
				openCodeInstances: instances,
				projectDir: dir,
				extraFolders: [nativeDirectory],
				slug: "native-recovery",
				configDir: dir,
				persistenceDbPath: filename,
				publishGlobalSetting: () => Effect.void,
				log: createSilentLogger(),
			});
			expect(directories).toContain(reset ? dir : nativeDirectory);
			expect(
				await relay.effectRuntime.runtime.runPromise(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						return yield* sql`SELECT status FROM provider_runs WHERE id = 'r'`;
					}),
				),
			).toEqual([
				{
					status:
						native === "matching" ||
						native === "moved-idle" ||
						native === "reset-idle"
							? "interrupted"
							: "running",
				},
			]);
		} finally {
			await relay?.stop();
			server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

it("recovers historical sessions before startup can create a live session", async () => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-startup-recovery-"));
	const filename = join(dir, "events.db");
	const server = createServer();
	let relay: ProjectRelay | undefined;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
		const request = input instanceof Request ? input : new Request(input);
		const path = new URL(request.url).pathname;
		if (path === "/event") return new Response(null, { status: 503 });
		return Response.json(
			path === "/path"
				? { state: dir, config: dir, worktree: dir, directory: dir }
				: path === "/session"
					? []
					: {},
		);
	});
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				yield* store.append(
					canonicalEvent(
						"session.created",
						"historical",
						{
							sessionId: "historical",
							title: "Historical",
							provider: "claude",
						},
						{ provider: "claude" },
					),
				);
				const query = yield* ReadQueryEffectTag;
				expect(
					yield* query.listSessions({ projectIds: ["startup-recovery"] }),
				).toEqual([]);
			}).pipe(
				Effect.provide(
					makePersistenceEffectLayer(filename, "startup-recovery"),
					{ local: true },
				),
			),
		);

		relay = await createProjectRelay({
			shellEnv: () => ({}),
			httpServer: server,
			opencodeUrl: "http://opencode.test",
			projectDir: dir,
			slug: "startup-recovery",
			configDir: dir,
			persistenceDbPath: filename,
			publishGlobalSetting: () => Effect.void,
			log: createSilentLogger(),
		});
		const sessions = await relay.effectRuntime.runtime.runPromise(
			Effect.gen(function* () {
				const manager = yield* SessionManagerServiceTag;
				const live = yield* manager.createSession("Live", {
					pick: {
						harness: "claude",
						model: { providerId: "claude", modelId: "sonnet" },
						effort: "",
						contextWindow: "",
					},
				});
				const rows = yield* manager.listSessions();
				return { liveId: live.id, ids: rows.map((row) => row.id) };
			}),
		);
		expect(sessions.ids).toContain("historical");
		expect(sessions.ids).toContain(sessions.liveId);
		expect(relay.initialSessionId).toBe("historical");
	} finally {
		await relay?.stop();
		server.close();
		vi.unstubAllGlobals();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("rejects Claude permissions a crash left pending and leaves OpenCode's alone", async () => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-orphaned-permissions-"));
	const filename = join(dir, "events.db");
	const server = createServer();
	let relay: ProjectRelay | undefined;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
		const request = input instanceof Request ? input : new Request(input);
		const path = new URL(request.url).pathname;
		if (path === "/event") return new Response(null, { status: 503 });
		return Response.json(
			path === "/path"
				? { state: dir, config: dir, worktree: dir, directory: dir }
				: path === "/session" || path === "/permission"
					? []
					: {},
		);
	});
	const seed = (provider: "claude" | "opencode") =>
		Effect.gen(function* () {
			const store = yield* EventStoreEffectTag;
			const sessionId = `${provider}-session`;
			yield* store.append(
				canonicalEvent(
					"session.created",
					sessionId,
					{ sessionId, title: provider, provider },
					{ provider },
				),
			);
			yield* store.append(
				canonicalEvent(
					"permission.asked",
					sessionId,
					{
						id: `${provider}-permission`,
						sessionId,
						toolName: "Bash",
						input: { command: "ls" },
					},
					{ provider },
				),
			);
			yield* store.append(
				canonicalEvent(
					"question.asked",
					sessionId,
					{ id: `${provider}-question`, sessionId, questions: [] },
					{ provider },
				),
			);
		});
	try {
		await Effect.runPromise(
			Effect.all([seed("claude"), seed("opencode")]).pipe(
				Effect.provide(
					makePersistenceEffectLayer(filename, "orphaned-permissions"),
					{ local: true },
				),
			),
		);

		relay = await createProjectRelay({
			shellEnv: () => ({}),
			httpServer: server,
			opencodeUrl: "http://opencode.test",
			projectDir: dir,
			slug: "orphaned-permissions",
			configDir: dir,
			persistenceDbPath: filename,
			publishGlobalSetting: () => Effect.void,
			log: createSilentLogger(),
		});
		const approvals = await relay.effectRuntime.runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{
					id: string;
					status: string;
					decision: string | null;
				}>`
					SELECT id, status, decision FROM pending_approvals ORDER BY id`;
			}),
		);
		expect(approvals).toEqual([
			{ id: "claude-permission", status: "resolved", decision: "reject" },
			{ id: "claude-question", status: "pending", decision: null },
			{ id: "opencode-permission", status: "pending", decision: null },
			{ id: "opencode-question", status: "pending", decision: null },
		]);
	} finally {
		await relay?.stop();
		server.close();
		vi.unstubAllGlobals();
		rmSync(dir, { recursive: true, force: true });
	}
});
