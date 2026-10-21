import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, expect, it, vi } from "vitest";
import type { DaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { PersistenceProjectTag } from "../../../src/lib/domain/persistence/Services/persistence-service.js";
import { PendingInteractionServiceLive } from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import { ProviderRuntimeIngestionLive } from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { ConfigTag } from "../../../src/lib/domain/relay/Services/services.js";
import { makeOverridesStateLive } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import {
	makePersistenceProjectLayer,
	makePersistenceStoreLayer,
} from "../../../src/lib/persistence/effect/live.js";
import { makeClaudeProviderRuntime } from "../../../src/lib/provider/claude/claude-provider-runtime.js";
import { settleUnclaimedRunnerCommands } from "../../../src/lib/provider/runner/runner-recovery.js";
import * as runnerRegistry from "../../../src/lib/provider/runner/runner-registry.js";
import { discoverRunners } from "../../../src/lib/provider/runner/runner-registry.js";
import { makeMockConfig } from "../../helpers/mock-factories.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

let harness: ProcessHarness | undefined;
let proof: Record<string, unknown> | undefined;
const proofs: Record<string, unknown>[] = [];

afterEach(async () => {
	if (harness) {
		await harness.dispose();
		expect(harness.remainingRunnerPids()).toEqual([]);
		if (proof) {
			proofs.push({ ...proof, cleanup: harness.proof() });
			writeFileSync(
				"/tmp/82tn9-2-runner-provenance.json",
				JSON.stringify({ proofs }, null, 2),
			);
		}
		proof = undefined;
		harness = undefined;
	}
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

// Failures: the relay's project rejects A's retained runner, restored bindings
// lose A's input/run identity, or a partial registry scan settles B's command.
it.each([
	false,
	true,
])("adopts a previous-layout runner by stored session provenance with two projects registered, shared root %s", async (sharedRoot) => {
	const fixture = ProcessHarness.create({ dist: "dist", restartProof: true });
	harness = fixture;
	const projectB = sharedRoot
		? fixture.projectDir
		: join(fixture.root, "project-b");
	mkdirSync(projectB, { recursive: true });
	const configPath = join(fixture.configDir, "daemon.json");
	const config = JSON.parse(readFileSync(configPath, "utf8")) as DaemonConfig;
	writeFileSync(
		configPath,
		JSON.stringify({
			...config,
			projects: [
				{
					path: fixture.projectDir,
					folders: [fixture.projectDir],
					slug: "process-test",
					addedAt: 1,
				},
				{ path: projectB, folders: [projectB], slug: "project-b", addedAt: 2 },
			],
		} satisfies DaemonConfig),
	);
	await fixture.restart();
	const registered = await fixture.requestRpc({ _tag: "GetProjects" });
	expect(registered.projects.map((project) => project.slug).sort()).toEqual([
		"process-test",
		"project-b",
	]);
	const a = await fixture.connect();
	const b = await fixture.connect(undefined, undefined, "project-b");
	const sessionA = await a.createSession("Retained A");
	const sessionB = await b.createSession("Retained B");
	const sends = [a, b].map((browser, index) =>
		browser
			.send(index === 0 ? sessionA : sessionB, "upgrade-long-turn")
			.catch(() => undefined),
	);
	await vi.waitFor(
		() => {
			const held = readFileSync(join(fixture.root, "sdk-proof.ndjson"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>)
				.filter((mark) => mark["kind"] === "assistant-held");
			expect(held).toHaveLength(2);
		},
		{ timeout: 10_000 },
	);
	const runnerA = discoverRunners(fixture.projectDir, fixture.configDir).find(
		(registration) => registration.sessionId === sessionA,
	);
	const runnerB = discoverRunners(projectB, fixture.configDir).find(
		(registration) => registration.sessionId === sessionB,
	);
	if (!runnerA || !runnerB) throw new Error("Missing retained runners");
	await fixture.kill();
	await Promise.all(sends);

	// Pin the old on-disk layout independently of runnerDirectory(). Registries
	// before driver extraction had no driverKind and used the Claude namespace.
	const oldDirectory = join(
		resolve(fixture.configDir),
		"r",
		createHash("sha256")
			.update(resolve(fixture.projectDir))
			.digest("hex")
			.slice(0, 12),
	);
	expect(runnerA.socketPath).toBe(join(oldDirectory, runnerA.runnerId));
	const { driverKind: _driver, ...legacyRegistration } = runnerA;
	writeFileSync(
		`${runnerA.socketPath}.json`,
		JSON.stringify(legacyRegistration),
	);

	let db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		const commandB = () =>
			db
				.prepare(
					"SELECT project_key, session_id, command_id, run_id, status, attempt_count, error_code FROM provider_command_outbox WHERE session_id = ?",
				)
				.all(sessionB);
		const beforeB = commandB();
		expect(beforeB).toMatchObject([{ status: "running" }]);
		db.close();
		// Construct under B, then scan A. Construction must not capture ownership;
		// invocation scope bounds the scan, while SQLite owns each session's SQL.
		const persistenceStore = makePersistenceStoreLayer(
			fixture.daemonStorePath(),
		);
		const persistence = makePersistenceProjectLayer("project-b").pipe(
			Layer.provideMerge(persistenceStore),
		);
		const ownerPersistence = makePersistenceProjectLayer("process-test").pipe(
			Layer.provideMerge(persistenceStore),
		);
		// Disable test IPC marks in this Vitest process; its IPC uses another codec.
		vi.stubEnv("NODE_ENV", "development");
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					// All project persistence services belong to B at construction.
					// Only output ingestion follows A, as supplied by the recovery caller.
					yield* sql`INSERT INTO pending_approvals (id, session_id, type, status, created_at, provider_process_id)
						VALUES ('stale-a-question', ${sessionA}, 'question', 'pending', 1, 'old-a'),
							('stale-a-permission', ${sessionA}, 'permission', 'pending', 1, 'old-a'),
							('current-a', ${sessionA}, 'question', 'pending', 1, ${runnerA.runnerId}),
							('legacy-a', ${sessionA}, 'question', 'pending', 1, NULL),
							('stale-b', ${sessionB}, 'question', 'pending', 1, 'old-b')`;
					// Startup may reclaim the store; open the independent reader afterward.
					db = new Database(fixture.daemonStorePath(), { readonly: true });
					const runner = yield* makeClaudeProviderRuntime({
						workspaceRoot: projectB,
						daemonConfigDir: fixture.configDir,
					}).pipe(
						Effect.provideService(PersistenceProjectTag, {
							projectId: "project-b",
						}),
					);
					yield* runner.recoverRunnerEffect;
					expect(yield* runner.hasLiveProcessEffect(sessionA)).toBe(true);
					expect(yield* runner.hasLiveProcessEffect(sessionB)).toBe(false);
					expect(commandB()).toEqual(beforeB);
					expect(
						yield* sql`SELECT id, status FROM pending_approvals ORDER BY id`,
					).toEqual([
						{ id: "current-a", status: "pending" },
						{ id: "legacy-a", status: "pending" },
						{ id: "stale-a-permission", status: "resolved" },
						{ id: "stale-a-question", status: "resolved" },
						{ id: "stale-b", status: "pending" },
					]);
					yield* settleUnclaimedRunnerCommands(
						sql,
						new Set([sessionA]),
						"claude",
						() => "claude",
						(_sinkId, turn) =>
							Effect.die(new Error(`Partial scan orphaned ${turn.sessionId}`)),
					);
					expect(
						discoverRunners(fixture.projectDir, fixture.configDir),
					).toContainEqual({ ...legacyRegistration, driverKind: "claude" });
					writeFileSync(join(fixture.root, "release-upgrade-turn"), "release");
					yield* Effect.tryPromise(() =>
						vi.waitFor(
							() => {
								expect(
									db
										.prepare(
											"SELECT status FROM provider_command_outbox WHERE session_id = ?",
										)
										.all(sessionA),
								).toEqual([{ status: "completed" }]);
							},
							{ timeout: 10_000 },
						),
					);
					expect(commandB()).toEqual(beforeB);
				}),
			).pipe(
				Effect.provideService(
					ConfigTag,
					makeMockConfig({ projectDir: fixture.projectDir }),
				),
				Effect.provideService(PersistenceProjectTag, {
					projectId: "process-test",
				}),
				Effect.provide(
					Layer.mergeAll(
						persistence,
						ProviderRuntimeIngestionLive.pipe(Layer.provide(ownerPersistence)),
						PendingInteractionServiceLive,
						makeOverridesStateLive(),
					),
				),
			),
		);
		const completedA = db
			.prepare(
				"SELECT status FROM provider_command_outbox WHERE session_id = ?",
			)
			.all(sessionA);
		const receiptsA = db
			.prepare(
				"SELECT status FROM command_receipts WHERE session_id = ? AND command_type = 'send_turn'",
			)
			.all(sessionA);
		expect(completedA).toEqual([{ status: "completed" }]);
		expect(receiptsA).toEqual([{ status: "side_effect_completed" }]);
		const afterPartialScanB = commandB();
		vi.unstubAllEnvs();
		db.close();
		await fixture.restart();
		db = new Database(fixture.daemonStorePath(), { readonly: true });
		await vi.waitFor(
			() => expect(commandB()).toMatchObject([{ status: "completed" }]),
			{ timeout: 10_000 },
		);
		expect(
			discoverRunners(fixture.projectDir, fixture.configDir),
		).toContainEqual({ ...legacyRegistration, driverKind: "claude" });
		expect(discoverRunners(projectB, fixture.configDir)).toContainEqual(
			runnerB,
		);
		expect(
			fixture
				.claudeOptions()
				.filter(({ prompt }) => prompt === "upgrade-long-turn"),
		).toHaveLength(2);
		proof = {
			sharedRoot,
			registeredProjects: registered.projects.map((project) => project.slug),
			sessionA,
			sessionB,
			legacyRegistration,
			runnerB,
			beforeB,
			afterPartialScanB,
			afterRestartB: commandB(),
			completedA,
			receiptsA,
		};
	} finally {
		db.close();
	}
}, 60_000);

it("retires prompts through the stored owner when adoption is refused and sends after restart", async () => {
	const fixture = ProcessHarness.create({
		dist: "dist",
		restartProof: true,
		runnerLifecycle: {
			runnerHelloAfterFirst: true,
			runnerHelloProtocolVersion: 999,
		},
	});
	harness = fixture;
	await fixture.restart();
	const browser = await fixture.connect();
	const sessionId = await browser.createSession("Foreign-scope refusal");
	const sending = browser
		.send(sessionId, "question-adoption-refusal")
		.catch(() => undefined);
	await browser.waitFor((frame) => frame["type"] === "question_pending");
	await fixture.kill();
	await sending;
	// The sandbox denies ps in this Vitest process. Use the same isolated,
	// runner-written argv evidence as the process harness's identity fallback.
	vi.spyOn(runnerRegistry, "runnerPidMatchesRegistration").mockImplementation(
		(registration) => {
			const argv = JSON.parse(
				readFileSync(
					join(fixture.root, `runner-argv-${registration.pid}.json`),
					"utf8",
				),
			) as string[];
			return (
				argv.includes(registration.socketPath) &&
				argv.includes(registration.runnerId)
			);
		},
	);
	const store = makePersistenceStoreLayer(fixture.daemonStorePath());
	const persistence = makePersistenceProjectLayer("project-b").pipe(
		Layer.provideMerge(store),
	);
	const ownerPersistence = makePersistenceProjectLayer("process-test").pipe(
		Layer.provideMerge(store),
	);
	vi.stubEnv("NODE_ENV", "development");
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO pending_approvals (id, session_id, type, status, created_at)
			VALUES ('legacy-question', ${sessionId}, 'question', 'pending', 1),
				('legacy-permission', ${sessionId}, 'permission', 'pending', 1)`;
				const runner = yield* makeClaudeProviderRuntime({
					workspaceRoot: fixture.projectDir,
					daemonConfigDir: fixture.configDir,
				});
				yield* runner.recoverRunnerEffect.pipe(
					Effect.provideService(PersistenceProjectTag, {
						projectId: "process-test",
					}),
				);
				expect(yield* runner.hasLiveProcessEffect(sessionId)).toBe(false);
				expect(
					yield* sql`SELECT status FROM pending_approvals WHERE session_id = ${sessionId}`,
				).toEqual([
					{ status: "resolved" },
					{ status: "resolved" },
					{ status: "resolved" },
				]);
				expect(
					yield* sql`SELECT status FROM provider_command_outbox WHERE session_id = ${sessionId}`,
				).toEqual([{ status: "failed" }]);
				expect(
					yield* sql`SELECT project_id FROM events WHERE session_id = ${sessionId} AND type IN ('question.resolved', 'permission.resolved')`,
				).toEqual([
					{ project_id: "process-test" },
					{ project_id: "process-test" },
					{ project_id: "process-test" },
				]);
			}),
		).pipe(
			Effect.provide(
				Layer.mergeAll(
					persistence,
					ProviderRuntimeIngestionLive.pipe(Layer.provide(ownerPersistence)),
					PendingInteractionServiceLive,
					makeOverridesStateLive(),
				),
			),
		),
	);
	vi.unstubAllEnvs();
	await fixture.restart();
	const restored = await fixture.connect(sessionId);
	expect(
		(await restored.send(sessionId, "after-adoption-refusal")).done["status"],
	).toBe("idle");
	proof = {
		scenario: "cross-project adoption refusal",
		sessionId,
		promptResolutions: 3,
		sentAfterRestart: true,
	};
}, 45_000);
