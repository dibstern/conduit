// Failure modes are recorded before these tests in
// docs/plans/2026-10-16-shared-store-scope-failure-modes.md.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Database from "better-sqlite3";
import { Effect, Layer, ManagedRuntime, Ref, Stream } from "effect";
import { SqlClient } from "effect/sql";
import * as Statement from "effect/sql/Statement";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { DEFAULT_WORKTREE_CLEANUP } from "../../../src/lib/contracts/worktree.js";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import {
	countRunningProjectSessions,
	hasColdAutoSettleCandidate,
	hasProviderRecoveryCandidate,
} from "../../../src/lib/domain/daemon/Services/daemon-session-reader.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { Usage } from "../../../src/lib/domain/daemon/Services/usage.js";
import { readColdWorktreeCleanupCandidates } from "../../../src/lib/domain/daemon/Services/worktree-cleanup-reader.js";
import { WorktreeServiceTag } from "../../../src/lib/domain/daemon/Services/worktree-service.js";
import { PersistenceProjectTag } from "../../../src/lib/domain/persistence/Services/persistence-service.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { SessionGitLive } from "../../../src/lib/domain/relay/Layers/session-git-layer.js";
import { AgentServiceTag } from "../../../src/lib/domain/relay/Services/agent-service.js";
import { AlertsLive } from "../../../src/lib/domain/relay/Services/alerts.js";
import { makeContinuation } from "../../../src/lib/domain/relay/Services/continuation.js";
import { makeEffectOpenCodeRuntimeIngress } from "../../../src/lib/domain/relay/Services/opencode-runtime-ingress-service.js";
import { ProviderRuntimeIngestionLive } from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { ProviderTurnServiceTag } from "../../../src/lib/domain/relay/Services/provider-turn-service.js";
import { resolveOrphanedClaudePermissions } from "../../../src/lib/domain/relay/Services/resolve-orphaned-claude-permissions.js";
import {
	AgentLivenessTag,
	BackgroundLivenessTag,
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { announceBackgroundWork } from "../../../src/lib/domain/relay/Services/session-attention.js";
import { SessionGitServiceTag } from "../../../src/lib/domain/relay/Services/session-git-service.js";
import { SessionInboxTag } from "../../../src/lib/domain/relay/Services/session-inbox.js";
import { restoreSessionSettings } from "../../../src/lib/domain/relay/Services/session-model-settings.js";
import {
	makeOverridesStateLive,
	OverridesStateTag,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { backfillSessionPicks } from "../../../src/lib/domain/relay/Services/session-pick.js";
import {
	SessionSetupLive,
	SessionSetupTag,
} from "../../../src/lib/domain/relay/Services/session-setup.js";
import { SessionWorkspaceTag } from "../../../src/lib/domain/relay/Services/session-workspace.js";
import { worktreeUsers } from "../../../src/lib/domain/relay/Services/session-worktree-deletion.js";
import {
	SSEStreamLive,
	SSEStreamTag,
} from "../../../src/lib/domain/relay/Services/sse-stream-service.js";
import { LocalPtyServiceTag } from "../../../src/lib/domain/relay/Services/terminal-service.js";
import { daemonSessionGitCache } from "../../../src/lib/git/session-git.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import {
	EventStoreEffectTag,
	makeEventStoreEffect,
} from "../../../src/lib/persistence/effect/event-store-effect.js";
import {
	makePersistenceEffectLayer,
	PersistenceStore,
	type PersistenceStoreContext,
} from "../../../src/lib/persistence/effect/live.js";
import {
	makeProjectionRunnerEffect,
	ProjectionRunnerEffectTag,
} from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	makeProjectorCursorEffect,
	ProjectorCursorEffectTag,
} from "../../../src/lib/persistence/effect/projector-cursor-effect.js";
import { createAllEffectProjectors } from "../../../src/lib/persistence/effect/projectors-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../src/lib/persistence/events.js";
import { DurableCommandCommitRepository } from "../../../src/lib/provider/orchestration-command-commit.js";
import { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import { CommandReadModelRepository } from "../../../src/lib/provider/orchestration-read-model.js";
import { ProviderSideEffectReactor } from "../../../src/lib/provider/orchestration-side-effect-reactor.js";
import {
	ProviderRegistry,
	ProviderRegistryTag,
} from "../../../src/lib/provider/provider-registry.js";
import {
	runningRunnerCommands,
	settleUnclaimedRunnerCommands,
} from "../../../src/lib/provider/runner/runner-recovery.js";
import * as relayStartup from "../../../src/lib/relay/project-relay-startup.js";
import { settleIdleSessions } from "../../../src/lib/session/auto-settle-sweep.js";
import {
	cleanUpProjectWorktrees,
	readWorktreeCleanupPaths,
} from "../../../src/lib/session/worktree-cleanup-sweep.js";
import { projectManifest } from "../../helpers/daemon-store-import-manifest.js";
import {
	makeMockAccountDirectory,
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeMockWebSocketHandler,
	makeOpenCodeInstancesStub,
} from "../../helpers/mock-factories.js";
import {
	makeSSEEvent,
	makeUnknownSSEEvent,
} from "../../helpers/sse-factories.js";
import { usageReading } from "../../helpers/usage.js";

const A = "alpha";
const B = "beta";
const NOW = 10_000_000;
const kinds = [
	"pending",
	"retry",
	"runner",
	"permission",
	"setup",
	"settle",
	"worktree",
	"pick",
	"settings",
	"workspace",
	"continuation",
] as const;
type Kind = (typeof kinds)[number];
const id = (project: string, kind: Kind) => `${project}-${kind}`;
type Evidence = {
	sweep: string;
	foreignRowsTouched: number;
	ownRowsActedOn: number;
};
const evidence = new Map<string, Evidence>();

// This adapter deliberately selects by B's ownership through the independent
// importer manifest helper, including command tables and session-owned tables.
const daemonStoreManifest = (
	filename: string,
	source?: ReturnType<typeof projectManifest>,
) => {
	const manifest = projectManifest(filename, B, source);
	const db = new Database(filename, { readonly: true });
	try {
		return {
			...manifest,
			rawVersions: {
				sessions: db
					.prepare(
						"SELECT id, project_id, version FROM sessions WHERE project_id = ? ORDER BY id",
					)
					.all(B),
				sidebar: db
					.prepare(
						"SELECT session_id, project_id, version, json_extract(row, '$.version') AS row_version FROM session_sidebar WHERE project_id = ? ORDER BY session_id",
					)
					.all(B),
			},
		};
	} finally {
		db.close();
	}
};
type ScopeManifest = ReturnType<typeof daemonStoreManifest>;
const manifestBytes = (manifest: ScopeManifest) =>
	JSON.stringify({
		tables: manifest.tables,
		rawVersions: manifest.rawVersions,
	});
function changedRows(before: ScopeManifest, after: ScopeManifest): number {
	return (
		Number(
			JSON.stringify(before.rawVersions) !== JSON.stringify(after.rawVersions),
		) +
		Object.keys(before.tables).reduce((count, table) => {
			const oldRows = (before.tables[table] ?? []).map((row) =>
				JSON.stringify(row),
			);
			const newRows = (after.tables[table] ?? []).map((row) =>
				JSON.stringify(row),
			);
			return (
				count +
				oldRows.filter((row) => !newRows.includes(row)).length +
				newRows.filter((row) => !oldRows.includes(row)).length
			);
		}, 0)
	);
}

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "conduit-shared-scope-"));
	const filename = join(root, "events.db");
	// Open only A's production layer. In particular, B must never run the
	// store-opening provenance stamp over A's already-existing rows.
	const runtime = ManagedRuntime.make(
		Layer.effect(
			PersistenceStore,
			Effect.context<PersistenceStoreContext>(),
		).pipe(Layer.provideMerge(makePersistenceEffectLayer(filename, A))),
	);
	await runtime.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const runnerA = yield* ProjectionRunnerEffectTag;
			yield* runnerA.recover();
			for (const project of [A, B]) {
				const store = yield* makeEventStoreEffect.pipe(
					Effect.provideService(PersistenceProjectTag, { projectId: project }),
				);
				const cursors = yield* makeProjectorCursorEffect.pipe(
					Effect.provideService(PersistenceProjectTag, { projectId: project }),
				);
				const runner = yield* makeProjectionRunnerEffect(
					createAllEffectProjectors(),
				).pipe(
					Effect.provideService(ProjectorCursorEffectTag, cursors),
					Effect.provideService(PersistenceProjectTag, { projectId: project }),
				);
				yield* runner.markRecovered();
				const events: CanonicalEvent[] = kinds.map((kind) =>
					canonicalEvent(
						"session.created",
						id(project, kind),
						{
							sessionId: id(project, kind),
							title: kind,
							provider: kind === "workspace" ? "opencode" : "claude",
						},
						{ provider: "claude", createdAt: 1000 },
					),
				);
				events.push(
					canonicalEvent(
						"session.settled",
						id(project, "worktree"),
						{ sessionId: id(project, "worktree") },
						{ provider: "claude", createdAt: 1000 },
					),
					canonicalEvent(
						"message.created",
						id(project, "continuation"),
						{
							sessionId: id(project, "continuation"),
							messageId: `${project}-continuation-user`,
							role: "user",
						},
						{ provider: "claude", createdAt: 1000 },
					),
					canonicalEvent(
						"session.usage_limited",
						id(project, "continuation"),
						{
							instanceId: "claude",
							rateLimitType: "seven_day",
							cutOffMessageId: `${project}-continuation-user`,
							resetsAt: 5,
						},
						{ provider: "claude", createdAt: 1000 },
					),
					canonicalEvent(
						"session.resume_scheduled",
						id(project, "continuation"),
						{ instanceId: "claude", at: 10 },
						{ provider: "claude", createdAt: 1000 },
					),
					canonicalEvent(
						"message.created",
						id(project, "settle"),
						{
							sessionId: id(project, "settle"),
							messageId: `${project}-settle-message`,
							role: "assistant",
						},
						{ provider: "claude", createdAt: 1000 },
					),
					canonicalEvent(
						"permission.asked",
						id(project, "permission"),
						{
							id: `${project}-ask`,
							sessionId: id(project, "permission"),
							toolName: "Bash",
							input: { command: "pwd" },
						},
						{ provider: "claude", createdAt: 1000 },
					),
					canonicalEvent(
						"session.setup_started",
						id(project, "setup"),
						{ sessionId: id(project, "setup"), source: "file" },
						{ provider: "claude", createdAt: 1000 },
					),
					canonicalEvent(
						"session.workspace_changed",
						id(project, "worktree"),
						{
							sessionId: id(project, "worktree"),
							worktrees: { [root]: join(root, `${project}-launch`) },
							cause: "launch",
							origin: "conduit",
							ownership: [
								{
									folder: root,
									path: join(root, `${project}-launch`),
									branchName: `${project}-branch`,
									head: "launch-head",
								},
							],
						},
						{ provider: "claude", createdAt: 1000 },
					),
					canonicalEvent(
						"session.workspace_changed",
						id(project, "workspace"),
						{
							sessionId: id(project, "workspace"),
							worktrees: { [root]: join(root, `${project}-workspace`) },
							cause: "user",
							origin: "existing",
						},
						{ provider: "opencode", createdAt: 1000 },
					),
					canonicalEvent(
						"session.model_changed",
						id(project, "settings"),
						{
							sessionId: id(project, "settings"),
							modelId: "saved-model",
							providerId: "anthropic",
						},
						{ provider: "claude", createdAt: 1000 },
					),
					canonicalEvent(
						"session.model_changed",
						id(project, "pick"),
						{
							sessionId: id(project, "pick"),
							modelId: "historical-model",
							providerId: "anthropic",
						},
						{ provider: "claude", createdAt: 1000 },
					),
				);
				yield* runner.projectBatch(yield* store.appendBatch(events));
				// There is no service for the migration-owned queue. Leave its singleton
				// intact while making only this session a missing-pick candidate.
				yield* sql`INSERT OR REPLACE INTO session_pick_backfill (session_id, retry_reason) VALUES (${id(project, "pick")}, 'pending')`;
				const repository = new DurableCommandCommitRepository(sql, project);
				for (const [index, kind] of (
					["pending", "retry", "runner"] as const
				).entries()) {
					const commandId = `${project}-${kind}-command`;
					const sequence = (project === A ? 100 : 200) + index;
					yield* repository.commit({
						events: [],
						readModelRows: [],
						receipt: {
							commandId,
							commandType: "send_turn",
							sessionId: id(project, kind),
							status: "side_effect_requested",
							fingerprintHash: "fixture",
							fingerprintVersion: 2,
							acceptedSequence: sequence,
							sideEffectSequence: sequence,
							createdAt: 1000,
							updatedAt: 1000,
						},
						outboxRequests: [
							{
								requestSequence: sequence,
								commandId,
								sessionId: id(project, kind),
								providerId: "claude",
								effectType: "send_turn",
								payloadJson: JSON.stringify({
									prompt: "fixture",
									inputId: `${project}-${kind}-input`,
									workspaceRoot: root,
								}),
							},
						],
					});
					// Status transitions normally come from a live runner. No provider is
					// launched in this fixture; these model its crash-time durable state.
					if (kind !== "pending")
						yield* sql`UPDATE provider_command_outbox SET status = ${kind === "retry" ? "retryable_failed" : "running"}, next_attempt_at = ${kind === "retry" ? 1000 : null}, attempt_count = 1 WHERE command_id = ${commandId}`;
				}
			}
			yield* sql`UPDATE session_pick_backfill_state SET initialized = 1 WHERE singleton = 1`;
		}),
	);
	return { root, filename, runtime };
}

describe("shared-store relay project scope", () => {
	let store: Awaited<ReturnType<typeof fixture>>;
	beforeEach(async () => {
		store = await fixture();
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await store?.runtime.dispose();
		if (store) rmSync(store.root, { recursive: true, force: true });
	});
	afterAll(() => {
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/82tn6-scope.json",
			`${JSON.stringify(
				[...evidence.values()].sort((a, b) => a.sweep.localeCompare(b.sweep)),
				null,
				2,
			)}\n`,
		);
	});
	function record(
		sweep: string,
		before: ScopeManifest,
		own: number,
		foreignRuntime = 0,
	) {
		const after = daemonStoreManifest(store.filename, before);
		evidence.set(sweep, {
			sweep,
			foreignRowsTouched: changedRows(before, after) + foreignRuntime,
			ownRowsActedOn: own,
		});
		expect.soft(own, `${sweep} must reach A's seed`).toBeGreaterThan(0);
		expect
			.soft(foreignRuntime, `${sweep} must exclude B from runtime outputs`)
			.toBe(0);
		expect(
			manifestBytes(after),
			`${sweep} must preserve B's normalized manifest`,
		).toBe(manifestBytes(before));
	}
	const config = () =>
		makeMockConfig({ slug: A, projectDir: store.root, configDir: store.root });

	it("outbox pending sweep executes only A", async () => {
		const before = daemonStoreManifest(store.filename);
		const acted = await store.runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const options = {
					sql,
					projectId: A,
					registry: new ProviderRegistry(),
					ingestion: { ingest: () => Effect.succeed(0) },
					nowMs: () => NOW,
				};
				yield* new ProviderSideEffectReactor(options).drain();
				return (
					(yield* sql<{
						n: number;
					}>`SELECT COUNT(*) AS n FROM provider_command_outbox WHERE project_key = ${A} AND status = 'failed'`)[0]
						?.n ?? 0
				);
			}),
		);
		expect(acted).toBe(2);
		record("outbox-pending-and-due-retry", before, acted);
	});

	it("runner recovery reads only A", async () => {
		const before = daemonStoreManifest(store.filename);
		const rows = await store.runtime.runPromise(
			Effect.gen(function* () {
				return yield* runningRunnerCommands(
					yield* SqlClient.SqlClient,
					"claude",
					() => "claude",
				);
			}),
		);
		record(
			"running-runner-commands",
			before,
			rows.filter((row) => row.project_key === A).length,
			rows.filter((row) => row.project_key === B).length,
		);
	});

	it("unclaimed Claude runner settlement changes only A", async () => {
		const before = daemonStoreManifest(store.filename);
		const failures: string[] = [];
		await store.runtime.runPromise(
			Effect.gen(function* () {
				yield* settleUnclaimedRunnerCommands(
					yield* SqlClient.SqlClient,
					new Set(),
					"claude",
					() => "claude",
					(_sink, turn) =>
						Effect.sync(() => {
							failures.push(turn.sessionId);
						}),
				);
			}),
		);
		record(
			"settle-unclaimed-claude-commands",
			before,
			failures.filter((session) => session.startsWith(`${A}-`)).length,
			failures.filter((session) => session.startsWith(`${B}-`)).length,
		);
	});

	it("orphaned Claude permission recovery rejects only A", async () => {
		const before = daemonStoreManifest(store.filename);
		const count = await store.runtime.runPromise(
			resolveOrphanedClaudePermissions,
		);
		record("orphaned-claude-permissions", before, count);
	});

	it("setup crash recovery finishes only A", async () => {
		const before = daemonStoreManifest(store.filename);
		const acted = await store.runtime.runPromise(
			Effect.gen(function* () {
				const setup = yield* SessionSetupTag;
				yield* setup.recover;
				const sql = yield* SqlClient.SqlClient;
				return (
					(yield* sql<{
						n: number;
					}>`SELECT COUNT(*) AS n FROM events WHERE project_id = ${A} AND type = 'session.setup_finished'`)[0]
						?.n ?? 0
				);
			}).pipe(
				Effect.provide(
					SessionSetupLive.pipe(
						Layer.provide(
							Layer.mergeAll(
								Layer.succeed(ConfigTag)(config()),
								Layer.succeed(LoggerTag)(makeMockLogger()),
								Layer.succeed(OpenCodeAPITag)(makeMockOpenCodeAPI()),
								Layer.succeed(AccountDirectory)(makeMockAccountDirectory()),
							),
						),
					),
				),
			),
		);
		record("session-setup-recover", before, acted);
	});

	it("auto settlement reaches only A's eligible session", async () => {
		const before = daemonStoreManifest(store.filename);
		const sessions: string[] = [];
		await store.runtime.runPromise(
			Effect.gen(function* () {
				const commit = yield* makeCommitAndSignal;
				return yield* settleIdleSessions(
					{
						hasViewer: () => false,
						hasLiveBackgroundWork: () => false,
						setSettled: (sessionId) =>
							commit([
								canonicalEvent(
									"session.settled",
									sessionId,
									{ sessionId },
									{ createdAt: NOW },
								),
							]).pipe(
								Effect.tap(() =>
									Effect.sync(() => {
										sessions.push(sessionId);
									}),
								),
								Effect.as(true),
							),
					},
					1000,
					NOW,
				);
			}),
		);
		record(
			"auto-settle",
			before,
			sessions.filter((session) => session === id(A, "settle")).length,
			sessions.filter((session) => session.startsWith(`${B}-`)).length,
		);
	});

	it("worktree cleanup discovery returns only A's launch events", async () => {
		const before = daemonStoreManifest(store.filename);
		const rows = await store.runtime.runPromise(readWorktreeCleanupPaths);
		record(
			"worktree-cleanup-discovery",
			before,
			rows.filter((row) => row.session_id === id(A, "worktree")).length,
			rows.filter((row) => row.session_id.startsWith(`${B}-`)).length,
		);
	});

	it("cold worktree cleanup probe returns only A's launch paths", async () => {
		for (const project of [A, B])
			mkdirSync(join(store.root, `${project}-launch`));
		const before = daemonStoreManifest(store.filename);
		const rows = await store.runtime.runPromise(
			readColdWorktreeCleanupCandidates(
				{ slug: A, folders: [store.root] },
				DEFAULT_WORKTREE_CLEANUP,
				NOW,
			),
		);
		record(
			"cold-worktree-cleanup",
			before,
			rows.filter((row) => row.session_id === id(A, "worktree")).length,
			rows.filter((row) => row.session_id.startsWith(`${B}-`)).length,
		);
	});

	it("worktree cleanup removes only A's eligible checkout", async () => {
		for (const project of [A, B])
			mkdirSync(join(store.root, `${project}-launch`));
		const before = daemonStoreManifest(store.filename);
		const removed: string[] = [];
		const unused = () => Effect.die("Unexpected cleanup service call");
		const worktrees: WorktreeServiceTag["Service"] = {
			withCheckoutUse: (effect) => effect,
			renameBranch: unused,
			runSetup: () => Stream.empty,
			legacyOwnership: unused,
			inspectRemoval: unused,
			remove: unused,
			inspectMissing: unused,
			recreate: unused,
			recreateAll: unused,
			create: unused,
			rollback: unused,
			inspectCheckoutCleanup: () => Effect.succeed({ head: "launch-head" }),
			removeCheckout: (folder) =>
				Effect.sync(() => {
					removed.push(folder.sessionId);
					return undefined;
				}),
		};
		const workspace: SessionWorkspaceTag["Service"] = {
			preview: unused,
			renameBranch: unused,
			withLaunch: (effect) => effect,
			get: unused,
			move: unused,
			inherit: unused,
			resolve: unused,
			record: unused,
			claudeWorktreeState: unused,
		};
		const inbox: SessionInboxTag["Service"] = {
			withSession: (_session, effect) => effect,
			submit: unused,
			cancel: unused,
			sendNow: unused,
			steerDeclined: unused,
			start: Effect.void,
		};
		const localPty: LocalPtyServiceTag["Service"] = {
			list: () => Effect.succeed([]),
			attach: unused,
			create: unused,
		};
		await store.runtime.runPromise(
			cleanUpProjectWorktrees(
				Effect.succeed({
					...DEFAULT_WORKTREE_CLEANUP,
					onSettle: "keep",
					settledAfterDays: 0,
				}),
				Effect.succeed([]),
				NOW,
			).pipe(
				Effect.provideService(ConfigTag, config()),
				Effect.provideService(WorktreeServiceTag, worktrees),
				Effect.provideService(SessionWorkspaceTag, workspace),
				Effect.provideService(SessionInboxTag, inbox),
				Effect.provideService(LocalPtyServiceTag, localPty),
				Effect.provideService(
					OpenCodeInstancesTag,
					makeOpenCodeInstancesStub(),
				),
				Effect.provideService(WebSocketHandlerTag, makeMockWebSocketHandler()),
				Effect.provideService(BackgroundLivenessTag, () => undefined),
				Effect.provideService(AgentLivenessTag, () => Effect.succeed(false)),
			),
		);
		record(
			"worktree-cleanup",
			before,
			removed.filter((session) => session === id(A, "worktree")).length,
			removed.filter((session) => session.startsWith(`${B}-`)).length,
		);
	});

	it("session pick backfill completes only A's candidate", async () => {
		const before = daemonStoreManifest(store.filename);
		const count = await store.runtime.runPromise(
			backfillSessionPicks().pipe(
				Effect.provideService(AccountDirectory, makeMockAccountDirectory()),
			),
		);
		record("session-pick-backfill", before, count);
	});

	it("saved settings restoration creates only A's overrides", async () => {
		const before = daemonStoreManifest(store.filename);
		const sessions = await store.runtime.runPromise(
			Effect.gen(function* () {
				yield* restoreSessionSettings();
				return [...(yield* Ref.get(yield* OverridesStateTag)).sessions.keys()];
			}).pipe(Effect.provide(makeOverridesStateLive())),
		);
		record(
			"restore-session-settings",
			before,
			sessions.filter((session) => session === id(A, "settings")).length,
			sessions.filter((session) => session.startsWith(`${B}-`)).length,
		);
	});

	it("startup count and default session belong to A", async () => {
		const before = daemonStoreManifest(store.filename);
		const read = relayStartup.readPersistedStartupSessions;
		const result = await store.runtime.runPromise(read);
		record(
			"relay-startup-count-and-default",
			before,
			result.count === kinds.length && result.sessionId?.startsWith(`${A}-`)
				? 1
				: 0,
			result.count -
				kinds.length +
				(result.sessionId?.startsWith(`${B}-`) ? 1 : 0),
		);
	});

	it("SSE passive subscription includes only A's persisted directories", async () => {
		const before = daemonStoreManifest(store.filename);
		let directories: readonly string[] = [];
		const instances = {
			...makeOpenCodeInstancesStub(),
			events: (read: readonly string[] | (() => readonly string[])) => {
				directories = typeof read === "function" ? read() : read;
				return Stream.never;
			},
		};
		await store.runtime.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const stream = yield* SSEStreamTag;
					yield* stream.connectEffect();
				}).pipe(
					Effect.provide(
						SSEStreamLive.pipe(
							Layer.provide(
								Layer.mergeAll(
									Layer.succeed(ConfigTag)(config()),
									Layer.succeed(OpenCodeInstancesTag)(instances),
								),
							),
						),
					),
				),
			),
		);
		record(
			"sse-passive-workspace-subscription",
			before,
			directories.filter(
				(directory) => directory === join(store.root, `${A}-workspace`),
			).length,
			directories.filter((directory) => directory.includes(`${B}-`)).length,
		);
	});

	for (const probe of [
		"provider-recovery",
		"running-session-count",
		"cold-auto-settle",
	] as const) {
		it(`daemon ${probe} probe ignores B and sees A`, async () => {
			const before = daemonStoreManifest(store.filename);
			const folder: [string] = [store.root];
			const read = (
				project: string,
			): Effect.Effect<number | boolean, unknown, PersistenceStore> =>
				probe === "provider-recovery"
					? hasProviderRecoveryCandidate({ slug: project, folders: folder }, [])
					: probe === "cold-auto-settle"
						? hasColdAutoSettleCandidate(
								{ slug: project, folders: folder },
								NOW,
								1000,
							)
						: countRunningProjectSessions({ slug: project, folders: folder });
			const positive = await store.runtime.runPromise(read(A));
			// Keep A's sessions while removing only its candidate facts. B retains
			// all three stimuli and therefore exposes a missing project predicate.
			await store.runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`UPDATE provider_command_outbox SET status = 'completed' WHERE project_key = ${A}`;
					yield* sql`UPDATE sessions SET last_message_at = NULL, status = 'idle' WHERE project_id = ${A}`;
				}),
			);
			const negative = await store.runtime.runPromise(read(A));
			record(
				`daemon-${probe}`,
				before,
				Number(positive) > 0 ? 1 : 0,
				Number(negative),
			);
		});
	}

	it("due continuations dispatch only A's scheduled session", async () => {
		const before = daemonStoreManifest(store.filename);
		const dispatched: string[] = [];
		const directory = makeMockAccountDirectory();
		const registry = new ProviderRegistry([
			{
				providerId: "claude",
				discoverEffect: () => Effect.die("Unexpected discovery"),
				sendTurnEffect: () =>
					Effect.die("Continuation uses ProviderTurnService"),
				interruptTurnEffect: () => Effect.void,
				resolvePermissionEffect: () => Effect.void,
				resolveQuestionEffect: () => Effect.void,
				endSessionEffect: () => Effect.void,
				shutdownEffect: () => Effect.void,
			},
		]);
		const unexpected = () => Effect.die("Unexpected continuation operation");
		await store.runtime.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const continuation = yield* makeContinuation;
					yield* continuation.sweepDueContinuations(10);
				}).pipe(
					Effect.provideService(ConfigTag, config()),
					Effect.provideService(Usage, {
						readings: Stream.empty,
						latest: () => Effect.succeed(undefined),
						turnEnded: () => Effect.void,
						refresh: () =>
							Effect.succeed([usageReading("claude", { status: "available" })]),
						pickFailover: () => Effect.succeed(undefined),
					}),
					Effect.provideService(ProviderTurnServiceTag, {
						holdUserTurnsForAccountSwitch: () => Effect.void,
						prepareTurnSession: (input) => Effect.succeed(input.sessionId),
						sendTurn: (input) =>
							Effect.sync(() => {
								dispatched.push(input.sessionId);
							}),
						turnFences: () => ({ stopping: false, switching: false }),
						fenceLifts: Effect.succeed(Stream.never),
						beginStop: () => Effect.succeed(Effect.void),
					}),
					Effect.provideService(AccountDirectory, directory),
					Effect.provideService(OpenCodeAPITag, makeMockOpenCodeAPI()),
					Effect.provideService(LoggerTag, makeMockLogger()),
					Effect.provideService(
						OrchestrationEngineTag,
						new OrchestrationEngine({ registry, accountDirectory: directory }),
					),
					Effect.provideService(ProviderRegistryTag, registry),
					Effect.provideService(AgentServiceTag, {
						getActiveAgent: () => Effect.succeed(undefined),
						listAgents: unexpected,
						switchAgent: unexpected,
					}),
					Effect.provideService(SessionInboxTag, {
						withSession: (_session, effect) => effect,
						start: Effect.void,
						submit: unexpected,
						cancel: unexpected,
						sendNow: unexpected,
						steerDeclined: unexpected,
					}),
					Effect.provide(AlertsLive),
					Effect.provide(makeOverridesStateLive()),
				),
			),
		);
		record(
			"due-continuations",
			before,
			dispatched.filter((session) => session === id(A, "continuation")).length,
			dispatched.filter((session) => session.startsWith(`${B}-`)).length,
		);
	});

	it("session Git refresh stamps only A's sessions and sidebar", async () => {
		const before = daemonStoreManifest(store.filename);
		vi.spyOn(daemonSessionGitCache, "refresh").mockResolvedValue({
			branch: "refreshed",
		});
		const own = await store.runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const [beforeRow] = yield* sql<{
					version: number;
				}>`SELECT version FROM sessions WHERE id = ${id(A, "settings")}`;
				yield* (yield* SessionGitServiceTag).refresh();
				const [afterRow] = yield* sql<{
					version: number;
				}>`SELECT version FROM sessions WHERE id = ${id(A, "settings")}`;
				return Number((afterRow?.version ?? 0) > (beforeRow?.version ?? 0));
			}).pipe(
				Effect.provide(
					SessionGitLive.pipe(
						Layer.provide(Layer.succeed(ConfigTag)(config())),
					),
				),
			),
		);
		record("session-git-refresh", before, own);
	});

	for (const sweep of ["dropped-part", "reconnect"] as const) {
		it(`OpenCode ${sweep} history invalidation acts only on A`, async () => {
			const result = await store.runtime.runPromise(
				Effect.gen(function* () {
					const ingress = yield* makeEffectOpenCodeRuntimeIngress(
						makeMockLogger(),
					);
					return yield* Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						if (sweep === "reconnect") {
							for (const project of [A, B])
								yield* ingress.onSSEEventEffect(
									makeUnknownSSEEvent("unknown.scope-test"),
									id(project, "workspace"),
									"opencode",
								);
						}
						// This proof is produced by REST reconciliation; there is no public
						// service that sets it without fetching provider history.
						yield* sql`UPDATE sessions SET history_complete = 1 WHERE id IN (${id(A, "workspace")}, ${id(B, "workspace")})`;
						const before = daemonStoreManifest(store.filename);
						if (sweep === "reconnect") yield* ingress.onReconnect("opencode");
						else
							for (const project of [A, B])
								yield* ingress.onSSEEventEffect(
									makeSSEEvent("message.part.updated", {
										sessionID: id(project, "workspace"),
										messageID: `${project}-unknown-message`,
										part: {
											id: `${project}-unknown-part`,
											type: "unknown.scope-test",
										},
									}),
									id(project, "workspace"),
									"opencode",
								);
						const [own] = yield* sql<{
							history_complete: number;
						}>`SELECT history_complete FROM sessions WHERE id = ${id(A, "workspace")}`;
						return { before, acted: Number(own?.history_complete === 0) };
					}).pipe(Effect.ensuring(Effect.sync(() => ingress.shutdown())));
				}).pipe(Effect.provide(ProviderRuntimeIngestionLive)),
			);
			record(`opencode-history-${sweep}`, result.before, result.acted);
		});
	}

	it("transient background attention stamps only A's rows", async () => {
		const before = daemonStoreManifest(store.filename);
		const acted = await store.runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const [old] = yield* sql<{
					version: number;
				}>`SELECT version FROM sessions WHERE id = ${id(A, "settings")}`;
				yield* announceBackgroundWork(id(A, "settings"));
				yield* announceBackgroundWork(id(B, "settings"));
				const [current] = yield* sql<{
					version: number;
				}>`SELECT version FROM sessions WHERE id = ${id(A, "settings")}`;
				return Number((current?.version ?? 0) > (old?.version ?? 0));
			}),
		);
		record("transient-background-attention", before, acted);
	});

	it("command read-model bootstrap contains only A's receipts and tombstones", async () => {
		await store.runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				for (const project of [A, B])
					yield* sql`INSERT INTO provider_command_tombstones (project_key, scope_kind, scope_id, session_id, event_sequence, reason_code, tombstoned_at) VALUES (${project}, 'session', ${id(project, "pending")}, ${id(project, "pending")}, 1, 'fixture', 1000)`;
			}),
		);
		const before = daemonStoreManifest(store.filename);
		const result = await store.runtime.runPromise(
			Effect.gen(function* () {
				return yield* new CommandReadModelRepository(
					yield* SqlClient.SqlClient,
					A,
				).bootstrap();
			}),
		);
		record(
			"command-read-model-bootstrap",
			before,
			[...result.receipts.values()].filter((row) => row.projectId === A)
				.length +
				[...result.tombstones].filter((key) => key.includes(A)).length,
			[...result.receipts.values()].filter((row) => row.projectId === B)
				.length +
				[...result.tombstones].filter((key) => key.includes(B)).length,
		);
	});

	it("local worktree users do not relabel B's workspace as A", async () => {
		const before = daemonStoreManifest(store.filename);
		const result = await store.runtime.runPromise(
			worktreeUsers(id(A, "pending")).pipe(
				Effect.provideService(ConfigTag, config()),
			),
		);
		record(
			"local-worktree-users",
			before,
			result.users.filter((user) => user.key === `${A}:${id(A, "workspace")}`)
				.length,
			result.users.filter((user) => user.key.startsWith(`${A}:${B}-`)).length,
		);
	});

	it("append ownership guard rejects B session and atomically rejects a mixed batch", async () => {
		const before = daemonStoreManifest(store.filename);
		const result = await store.runtime.runPromise(
			Effect.gen(function* () {
				const eventStore = yield* EventStoreEffectTag;
				const foreign = canonicalEvent("session.renamed", id(B, "settings"), {
					sessionId: id(B, "settings"),
					title: "wrong owner",
				});
				const single = yield* Effect.result(eventStore.append(foreign));
				const batch = yield* Effect.result(
					eventStore.appendBatch([
						canonicalEvent("session.created", "new-alpha-session", {
							sessionId: "new-alpha-session",
							title: "new",
							provider: "claude",
						}),
						foreign,
						foreign,
					]),
				);
				const own = yield* eventStore.append(
					canonicalEvent("session.renamed", id(A, "settings"), {
						sessionId: id(A, "settings"),
						title: "same owner",
					}),
				);
				const unknown = yield* eventStore.append(
					canonicalEvent("session.created", "unknown-alpha-session", {
						sessionId: "unknown-alpha-session",
						title: "unknown",
						provider: "claude",
					}),
				);
				const sql = yield* SqlClient.SqlClient;
				const leakedBatch =
					(yield* sql<{
						n: number;
					}>`SELECT COUNT(*) AS n FROM events WHERE session_id = 'new-alpha-session'`)[0]
						?.n ?? 0;
				return { single, batch, own, unknown, leakedBatch };
			}),
		);
		record(
			"append-ownership-guard",
			before,
			Number(result.own.projectId === A) +
				Number(result.unknown.projectId === A),
		);
		expect(result.single._tag).toBe("Failure");
		expect(result.batch._tag).toBe("Failure");
		expect(result.leakedBatch).toBe(0);
		for (const outcome of [result.single, result.batch])
			if (outcome._tag === "Failure") {
				expect(outcome.failure).toMatchObject({
					_tag: "EventStoreError",
					operation: "appendOwnership",
					sessionId: id(B, "settings"),
					projectId: A,
					ownerProjectId: B,
				});
			}
	});

	for (const operation of ["append", "command-commit"] as const) {
		it(`${operation} retains its writer slot across ownership preflight`, async () => {
			await store.runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`CREATE TABLE scope_writer_probe (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)`;
					yield* sql`INSERT INTO scope_writer_probe (id, value) VALUES (1, 0)`;
				}),
			);
			const competitor = new DatabaseSync(store.filename, { timeout: 0 });
			let attempted = false;
			let competitorBlocked = false;
			let ownershipLookups = 0;
			try {
				const outcome = await store.runtime.runPromise(
					Effect.result(
						Effect.gen(function* () {
							if (operation === "append") {
								const eventStore = yield* EventStoreEffectTag;
								yield* eventStore.appendBatch([
									canonicalEvent("session.renamed", id(A, "settings"), {
										sessionId: id(A, "settings"),
										title: "first",
									}),
									canonicalEvent("session.renamed", id(A, "settings"), {
										sessionId: id(A, "settings"),
										title: "second",
									}),
									canonicalEvent("session.renamed", id(A, "workspace"), {
										sessionId: id(A, "workspace"),
										title: "third",
									}),
								]);
							} else {
								const sql = yield* SqlClient.SqlClient;
								yield* new DurableCommandCommitRepository(sql, A).commit({
									events: [],
									readModelRows: [],
									outboxRequests: [],
									receipt: {
										commandId: "alpha-writer-probe",
										commandType: "send_turn",
										sessionId: id(A, "settings"),
										status: "side_effect_requested",
										fingerprintHash: "fixture",
										fingerprintVersion: 2,
										createdAt: 1000,
										updatedAt: 1000,
									},
								});
							}
						}).pipe(
							Effect.provideService(Statement.CurrentTransformer, (statement) =>
								Effect.sync(() => {
									const [query] = statement.compile();
									if (
										/SELECT\s+project_id\s+FROM\s+sessions\s+WHERE\s+id\s*=/i.test(
											query,
										)
									)
										ownershipLookups++;
									const insert =
										operation === "append"
											? /INSERT\s+INTO\s+events\b/i
											: /INSERT\s+INTO\s+command_receipts\b/i;
									if (!attempted && insert.test(query)) {
										attempted = true;
										try {
											competitor
												.prepare(
													"UPDATE scope_writer_probe SET value = value + 1 WHERE id = 1",
												)
												.run();
										} catch (error) {
											if (
												typeof error !== "object" ||
												error === null ||
												!("errcode" in error) ||
												error.errcode !== 5
											)
												throw error;
											competitorBlocked = true;
										}
									}
									return statement;
								}),
							),
						),
					),
				);
				// A has committed or rolled back, so the competing writer can now
				// finish without waiting on any live transaction from this operation.
				competitor
					.prepare(
						"UPDATE scope_writer_probe SET value = value + 1 WHERE id = 1",
					)
					.run();
				expect(outcome._tag, JSON.stringify(outcome)).toBe("Success");
				expect(attempted).toBe(true);
				expect(competitorBlocked).toBe(true);
				expect(
					competitor
						.prepare("SELECT value FROM scope_writer_probe WHERE id = 1")
						.get(),
				).toEqual({ value: 1 });
				if (operation === "append") expect(ownershipLookups).toBe(2);
			} finally {
				competitor.close();
			}
		});
	}

	it("session.created conflict preserves existing ownership while updating other columns", async () => {
		const result = await store.runtime.runPromise(
			Effect.gen(function* () {
				const runner = yield* ProjectionRunnerEffectTag;
				const event = canonicalEvent(
					"session.created",
					id(B, "settings"),
					{
						sessionId: id(B, "settings"),
						title: "updated title",
						provider: "claude",
						providerSessionId: "updated-native-id",
					},
					{ createdAt: 2000 },
				);
				// Projection itself must preserve ownership even when replaying an
				// already-stored historical event; the append guard is independent.
				yield* runner.projectEvent({
					...event,
					projectId: A,
					sequence: 999,
					streamVersion: 0,
				});
				const sql = yield* SqlClient.SqlClient;
				return (yield* sql<{
					project_id: string;
					title: string;
					provider_sid: string;
					updated_at: number;
				}>`SELECT project_id, title, provider_sid, updated_at FROM sessions WHERE id = ${id(B, "settings")}`)[0];
			}),
		);
		expect(result).toEqual({
			project_id: B,
			title: "settings",
			provider_sid: "updated-native-id",
			updated_at: 2000,
		});
	});
});
