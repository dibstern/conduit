// What a project's startup recovers from a store an earlier daemon left
// behind: historical sessions, and Claude approvals a crash left pending.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option, PubSub, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { expect, it, vi } from "vitest";
import type { OpenCodeInstanceEvent } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { ProviderAdapters } from "../../../src/lib/domain/daemon/Services/provider-adapters.js";
import { OrchestrationEngineTag } from "../../../src/lib/domain/relay/Services/services.js";
import { projectSessionManager } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { OpenCodeProviderInstance } from "../../../src/lib/provider/opencode-provider-instance.js";
import {
	createDaemonProject,
	type DaemonProject,
	FixedShellEnv,
} from "../../helpers/in-process-daemon.js";
import {
	makeMockOpenCodeAPI,
	makeOpenCodeInstancesStub,
} from "../../helpers/mock-factories.js";

/** Starts a project on a store the seed wrote before the daemon ran. */
async function withSeededProject<A>(
	slug: string,
	seed: Effect.Effect<void, unknown, EventStoreEffectTag | ReadQueryEffectTag>,
	body: (project: DaemonProject) => Promise<A>,
	options: Omit<
		NonNullable<Parameters<typeof createDaemonProject>[1]>,
		"configDir" | "slug"
	> = {},
): Promise<A> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sr-")));
	const configDir = join(root, "config");
	mkdirSync(configDir);
	await Effect.runPromise(
		seed.pipe(
			Effect.provide(
				makePersistenceEffectLayer(join(configDir, "events.db"), slug),
				{ local: true },
			),
		),
	);
	const project = await createDaemonProject("chat-simple", {
		...options,
		configDir,
		slug,
	});
	try {
		return await body(project);
	} finally {
		await project.stop();
		rmSync(root, { recursive: true, force: true });
	}
}

it("recovers historical sessions before startup can create a live session", async () => {
	const seed = Effect.gen(function* () {
		const store = yield* EventStoreEffectTag;
		yield* store.append(
			canonicalEvent(
				"session.created",
				"historical",
				{ sessionId: "historical", title: "Historical", provider: "claude" },
				{ provider: "claude" },
			),
		);
		const query = yield* ReadQueryEffectTag;
		expect(
			yield* query.listSessions({ projectIds: ["startup-recovery"] }),
		).toEqual([]);
	});
	const sessions = await withSeededProject(
		"startup-recovery",
		seed,
		(project) =>
			project.run(
				Effect.gen(function* () {
					const manager = yield* projectSessionManager;
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
			),
	);
	expect(sessions.ids).toContain("historical");
	expect(sessions.ids).toContain(sessions.liveId);
});

// Runner recovery retires every prompt an unclaimed Claude session left pending,
// questions too: the process that asked is gone (provider-process-expired).
it("retires the prompts a crash left pending on Claude sessions and leaves OpenCode's alone", async () => {
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
	await withSeededProject(
		"orphaned-permissions",
		Effect.all([seed("claude"), seed("opencode")], { discard: true }),
		(project) =>
			vi.waitFor(async () =>
				expect(
					await project.run(
						Effect.gen(function* () {
							const sql = yield* SqlClient.SqlClient;
							return yield* sql`
								SELECT id, status, decision FROM pending_approvals ORDER BY id`;
						}),
					),
				).toEqual([
					{ id: "claude-permission", status: "resolved", decision: "reject" },
					{ id: "claude-question", status: "resolved", decision: "{}" },
					{ id: "opencode-permission", status: "pending", decision: null },
					{ id: "opencode-question", status: "pending", decision: null },
				]),
			),
	);
});

const tempProjectDir = () =>
	realpathSync(mkdtempSync(join(tmpdir(), "sr-project-")));

const runStatus = (project: DaemonProject) =>
	project.run(
		Effect.flatMap(
			SqlClient.SqlClient,
			(sql) => sql`SELECT status FROM provider_runs WHERE id = 'r'`,
		),
	);

it.each([
	"ready",
	"failed",
	"hung",
] as const)("settles the exact pending send when its OpenCode server is confirmed stopped, with %s shell readiness", async (readiness) => {
	const dir = tempProjectDir();
	const client = makeMockOpenCodeAPI();
	vi.spyOn(client.session, "statuses").mockResolvedValue({
		s: { type: "busy" },
	});
	const bus = await Effect.runPromise(
		PubSub.unbounded<OpenCodeInstanceEvent>(),
	);
	const shellEnv = { SYNTHETIC_ENV: "process-fallback" };
	let markPrepared = () => {};
	const prepared = new Promise<void>((resolve) => {
		markPrepared = resolve;
	});
	let markPrompted = () => {};
	const prompted = new Promise<void>((resolve) => {
		markPrompted = resolve;
	});
	vi.spyOn(client.session, "prompt").mockImplementation(async () => {
		markPrompted();
	});
	const prepareShellEnv = vi.fn((_directory: string) => {
		markPrepared();
		if (readiness === "failed")
			return Promise.reject(new Error("Capture failed"));
		if (readiness === "hung") return new Promise<boolean>(() => {});
		return Promise.resolve(true);
	});
	const seed = Effect.gen(function* () {
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
	});
	try {
		await withSeededProject(
			"stop-recovery",
			seed,
			async (project) => {
				const opencode = await project.run(
					Effect.flatMap(ProviderAdapters, (adapters) =>
						adapters.registry.getInstanceEffect("opencode"),
					),
				);
				if (!(opencode instanceof OpenCodeProviderInstance))
					throw new Error("Expected the OpenCode adapter");
				const deliver = vi.spyOn(opencode, "sendTurnEffect");
				if (readiness === "hung")
					vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
				const send = project.run(
					Effect.flatMap(OrchestrationEngineTag, (engine) =>
						engine.dispatchEffect({
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
						}),
					),
				);
				// Daemon disposal interrupts this waiter if an earlier assertion fails.
				void send.catch(() => undefined);
				if (readiness === "hung") {
					await prepared;
					expect(deliver).not.toHaveBeenCalled();
					await vi.advanceTimersByTimeAsync(10_000);
				}
				await prompted;
				expect(client.session.prompt).toHaveBeenCalledTimes(1);
				expect(prepareShellEnv).toHaveBeenCalledWith(dir);
				expect(deliver).toHaveBeenCalledWith(
					expect.objectContaining({ shellEnv }),
				);
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
				// Let the reactor's outcome poll advance while awaiting the send itself.
				if (readiness === "hung") vi.setTimerTickMode("nextTimerAsync");
				const completion = await send;
				expect(completion.status).toBe("interrupted");
				expect(completion.error?.code).toBe("interrupted");
				expect(
					await project.run(
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
			},
			{
				projectDir: dir,
				openCodeInstances: {
					...makeOpenCodeInstancesStub({ opencode: client }),
					events: () => Stream.fromPubSub(bus),
				},
				shellEnv: new FixedShellEnv(shellEnv, prepareShellEnv),
			},
		);
	} finally {
		vi.useRealTimers();
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
		const dir = tempProjectDir();
		const nativeDirectory = join(dir, "native-extra");
		mkdirSync(nativeDirectory);
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
		const seed = Effect.gen(function* () {
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
		});
		try {
			await withSeededProject(
				"native-recovery",
				seed,
				async (project) => {
					expect(directories).toContain(reset ? dir : nativeDirectory);
					expect(await runStatus(project)).toEqual([
						{
							status:
								native === "matching" ||
								native === "moved-idle" ||
								native === "reset-idle"
									? "interrupted"
									: "running",
						},
					]);
				},
				{
					projectDir: dir,
					extraFolders: [nativeDirectory],
					openCodeInstances: {
						...makeOpenCodeInstancesStub({ opencode: client }),
						ifRunning: (_instanceId, directory) =>
							Effect.sync(() => {
								directories.push(directory);
								return Option.some(client);
							}),
					},
					shellEnv: new FixedShellEnv({}),
				},
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
