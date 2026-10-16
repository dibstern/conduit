// Failure modes: docs/plans/2026-10-16-shared-store-cutover-failure-modes.md.
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SqlClient } from "@effect/sql";
import Database from "better-sqlite3";
import {
	Context,
	Effect,
	HashMap,
	Layer,
	ManagedRuntime,
	Option,
	Ref,
} from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WORKTREE_CLEANUP } from "../../../src/lib/contracts/worktree.js";
import { defaultDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { makeDaemonSharedStoreLayer } from "../../../src/lib/domain/daemon/Layers/daemon-shared-store-layer.js";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import {
	countRunningProjectSessions,
	hasColdAutoSettleCandidate,
	hasProviderRecoveryCandidate,
	listDaemonSessions,
	resolveDaemonOpenCodeSession,
} from "../../../src/lib/domain/daemon/Services/daemon-session-reader.js";
import {
	makeProjectRegistryLive,
	ProjectRegistryTag,
} from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import {
	makeSessionActivity,
	SessionActivityTag,
} from "../../../src/lib/domain/daemon/Services/session-activity.js";
import {
	indexProjectSessions,
	makeSessionDirectoryLive,
	makeSharedSessionDirectoryLive,
	SessionDirectory,
} from "../../../src/lib/domain/daemon/Services/session-directory.js";
import { readColdWorktreeCleanupCandidates } from "../../../src/lib/domain/daemon/Services/worktree-cleanup-reader.js";
import * as persistence from "../../../src/lib/domain/persistence/Services/persistence-service.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import * as persistenceLayers from "../../../src/lib/persistence/effect/live.js";
import {
	makePersistenceEffectLayer,
	makePersistenceProjectLayer,
	PersistenceStore,
} from "../../../src/lib/persistence/effect/live.js";
import * as migrations from "../../../src/lib/persistence/effect/migrations.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import * as importer from "../../../src/lib/persistence/migrations/daemon-store-import.js";
import { daemonStorePath } from "../../../src/lib/persistence/project-storage.js";
import type { StoredProject } from "../../../src/lib/types.js";
import { daemonStoreManifest } from "../../helpers/daemon-store-import-manifest.js";
import { makeMockAccountDirectory } from "../../helpers/mock-factories.js";

afterEach(() => vi.restoreAllMocks());

function project(root: string, slug: string): StoredProject {
	const folder = join(root, "folders", slug);
	mkdirSync(folder, { recursive: true });
	return { slug, title: slug, folders: [folder] };
}

function config(projects: readonly StoredProject[]) {
	return {
		...defaultDaemonConfig(),
		projects: projects.map((project) => ({
			slug: project.slug,
			title: project.title,
			folders: project.folders,
			path: project.folders[0],
			addedAt: 1,
		})),
	};
}

const sourcePath = (root: string, slug: string) =>
	join(root, "projects", slug, "events.db");

function sourceFiles(root: string): string[] {
	const projects = join(root, "projects");
	return existsSync(projects)
		? readdirSync(projects)
				.filter((slug) => existsSync(sourcePath(root, slug)))
				.map((slug) => `projects/${slug}/events.db`)
				.sort()
		: [];
}

function history(sessionId: string, provider = "opencode") {
	return [
		canonicalEvent(
			"session.created",
			sessionId,
			{
				sessionId,
				title: sessionId,
				provider,
				providerSessionId: `${sessionId}-native`,
			},
			{ provider, createdAt: 1000 },
		),
		canonicalEvent(
			"message.created",
			sessionId,
			{
				sessionId,
				messageId: `${sessionId}-message`,
				role: "assistant",
			},
			{ provider, createdAt: 2000 },
		),
		canonicalEvent(
			"text.delta",
			sessionId,
			{
				messageId: `${sessionId}-message`,
				partId: `${sessionId}-text`,
				text: `history of ${sessionId}`,
			},
			{ provider, createdAt: 2000 },
		),
	];
}

async function writeHistory(root: string, slug: string, sessionId: string) {
	const filename = sourcePath(root, slug);
	mkdirSync(dirname(filename), { recursive: true });
	const runtime = ManagedRuntime.make(
		makePersistenceEffectLayer(filename, slug),
	);
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.recover();
				yield* runner.projectBatch(
					yield* store.appendBatch(history(sessionId)),
				);
			}),
		);
	} finally {
		await runtime.dispose();
	}
}

function startup(root: string, projects: readonly StoredProject[]) {
	const store = makeDaemonSharedStoreLayer(root, config(projects));
	const registry = makeProjectRegistryLive(projects);
	const directory = makeSharedSessionDirectoryLive.pipe(
		Layer.provide(Layer.merge(store, registry)),
	);
	return ManagedRuntime.make(
		Layer.mergeAll(
			store,
			registry,
			directory,
			Layer.succeed(AccountDirectory, makeMockAccountDirectory()),
			Layer.effect(SessionActivityTag, makeSessionActivity),
		),
	);
}

function watchReaderPreparation() {
	const migrate = migrations.makeEffectSqlMigrator;
	const migrationRuns = vi.fn();
	const migrationSpy = vi
		.spyOn(migrations, "makeEffectSqlMigrator")
		.mockImplementation((...args) =>
			Effect.sync(migrationRuns).pipe(Effect.zipRight(migrate(...args))),
		);
	const stamp = persistence.stampProjectProvenance;
	const stampRuns = vi.fn();
	const stampSpy = vi
		.spyOn(persistence, "stampProjectProvenance")
		.mockImplementation((...args) =>
			Effect.sync(stampRuns).pipe(Effect.zipRight(stamp(...args))),
		);
	return {
		migrationRuns,
		stampRuns,
		restore: () => {
			migrationSpy.mockRestore();
			stampSpy.mockRestore();
		},
	};
}

describe("daemon shared-store startup", () => {
	it("imports histories before lineage and readers, then borrows one store without recreating project files", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-shared-startup-"));
		const projects = [project(root, "alpha"), project(root, "beta")] as const;
		try {
			await writeHistory(root, "alpha", "parent");
			await writeHistory(root, "beta", "child");
			writeFileSync(
				join(root, "fork-metadata.json"),
				JSON.stringify({
					child: { parentID: "parent", forkMessageId: "parent-message" },
					later: { parentID: "parent", forkMessageId: "parent-message" },
				}),
			);
			const imported: importer.ProjectStoreImportResult[][] = [];
			const importStores = importer.importRegisteredProjectStores;
			const importCalls = vi
				.spyOn(importer, "importRegisteredProjectStores")
				.mockImplementation((...args) => {
					expect(existsSync(daemonStorePath(root))).toBe(false);
					return importStores(...args).pipe(
						Effect.tap((results) =>
							Effect.sync(() => imported.push([...results])),
						),
					);
				});
			const runtime = startup(root, projects);
			try {
				const store = await runtime.runPromise(PersistenceStore);
				expect(Context.get(store, SqlClient.SqlClient)).toBe(
					await runtime.runPromise(SqlClient.SqlClient),
				);
				expect(importCalls).toHaveBeenCalledTimes(1);
				expect(
					imported[0]
						?.map(({ projectId, outcome }) => [projectId, outcome])
						.sort(),
				).toEqual([
					["alpha", expect.stringMatching(/^(seeded|imported)$/)],
					["beta", expect.stringMatching(/^(seeded|imported)$/)],
				]);
				expect(
					imported[0]?.filter(({ outcome }) => outcome === "seeded"),
				).toHaveLength(1);
				importCalls.mockRestore();
				expect(sourceFiles(root)).toEqual([]);
				expect(
					readFileSync(join(root, "daemon-store-import-report.txt"), "utf8"),
				).toMatch(/alpha.*(?:seeded|imported)/);
				expect(
					readFileSync(join(root, "daemon-store-import-report.txt"), "utf8"),
				).toMatch(/beta.*(?:seeded|imported)/);
				for (const slug of ["alpha", "beta"])
					expect(
						readdirSync(dirname(sourcePath(root, slug))).some((name) =>
							name.startsWith("events.db.imported-"),
						),
					).toBe(true);
				const lineage = await runtime.runPromise(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						return yield* sql`SELECT project_id, parent_id, root_id, fork_point_event, fork_point_timestamp FROM sessions WHERE id = 'child'`;
					}),
				);
				expect(lineage).toEqual([
					{
						project_id: "beta",
						parent_id: "parent",
						root_id: "parent",
						fork_point_event: "parent-message",
						fork_point_timestamp: 2000,
					},
				]);
				expect(existsSync(join(root, "fork-metadata.json"))).toBe(false);
				expect(
					JSON.parse(
						readFileSync(join(root, "fork-metadata-unresolved.json"), "utf8"),
					),
				).toEqual({
					later: { parentID: "parent", forkMessageId: "parent-message" },
				});
				const preparation = watchReaderPreparation();
				for (const [slug, id] of [
					["alpha", "parent"],
					["beta", "child"],
				] as const) {
					const own = await runtime.runPromise(
						listDaemonSessions(root, { scope: slug }),
					);
					expect(
						own.sessions.map((session) => [session.id, session.projectSlug]),
					).toEqual([[id, slug]]);
					expect(
						await runtime.runPromise(
							resolveDaemonOpenCodeSession(root, "opencode", `${id}-native`),
						),
					).toEqual({ projectSlug: slug, sessionId: id });
				}
				const list = await runtime.runPromise(listDaemonSessions(root));
				expect(
					list.sessions.map(({ id, projectSlug }) => [id, projectSlug]).sort(),
				).toEqual([
					["child", "beta"],
					["parent", "alpha"],
				]);
				await runtime.runPromise(
					Effect.gen(function* () {
						const directory = yield* SessionDirectory;
						expect(yield* directory.projectOf("parent")).toEqual(
							Option.some("alpha"),
						);
						expect(yield* directory.projectOf("child")).toEqual(
							Option.some("beta"),
						);
						expect(yield* directory.projectOf("missing")).toEqual(
							Option.none(),
						);
						const registry = yield* ProjectRegistryTag;
						const beforeRemoval = yield* Ref.get(registry);
						yield* Ref.update(registry, HashMap.remove("beta"));
						expect(yield* directory.projectOf("child")).toEqual(Option.none());
						yield* Ref.set(registry, beforeRemoval);
						expect(yield* directory.projectOf("child")).toEqual(
							Option.some("beta"),
						);
						yield* indexProjectSessions(root, projects[1]);
						yield* directory.record("alpha", ["child", "invented"]);
						yield* directory.replaceProject("alpha", ["invented"]);
						yield* directory.remove("alpha", ["parent"]);
						yield* directory.removeProject("alpha");
						expect(yield* directory.projectOf("parent")).toEqual(
							Option.some("alpha"),
						);
						expect(yield* directory.projectOf("invented")).toEqual(
							Option.none(),
						);
					}),
				);
				const relayProject = ManagedRuntime.make(
					makePersistenceProjectLayer("beta").pipe(
						Layer.provideMerge(Layer.succeedContext(store)),
					),
				);
				try {
					const sessions = await relayProject.runPromise(
						Effect.flatMap(ReadQueryEffectTag, (query) =>
							query.listSessions({ projectIds: ["beta"] }),
						),
					);
					expect(sessions.map(({ id }) => id)).toEqual(["child"]);
				} finally {
					await relayProject.dispose();
				}
				expect(
					await runtime.runPromise(
						Effect.flatMap(
							SqlClient.SqlClient,
							(sql) => sql`SELECT id FROM sessions ORDER BY id`,
						),
					),
				).toEqual([{ id: "child" }, { id: "parent" }]);
				expect(preparation.migrationRuns).not.toHaveBeenCalled();
				expect(preparation.stampRuns).not.toHaveBeenCalled();
				preparation.restore();
				expect(sourceFiles(root)).toEqual([]);
			} finally {
				await runtime.dispose();
			}
			expect(sourceFiles(root)).toEqual([]);
			const before = daemonStoreManifest(daemonStorePath(root));
			const restarted = startup(root, projects);
			try {
				await restarted.runPromise(PersistenceStore);
				expect(daemonStoreManifest(daemonStorePath(root))).toEqual(before);
				expect(sourceFiles(root)).toEqual([]);
			} finally {
				await restarted.dispose();
			}
			expect(sourceFiles(root)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("prepares and closes an existing destination before importing a new project, then retries archived lineage", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-shared-prepare-"));
		const alpha = project(root, "alpha");
		const beta = project(root, "beta");
		try {
			await writeHistory(root, "alpha", "parent");
			writeFileSync(
				join(root, "fork-metadata.json"),
				JSON.stringify({
					later: { parentID: "parent", forkMessageId: "parent-message" },
				}),
			);
			const first = startup(root, [alpha]);
			try {
				await first.runPromise(PersistenceStore);
				const borrowed = await first.runPromise(PersistenceStore);
				const projectRuntime = ManagedRuntime.make(
					makePersistenceProjectLayer("alpha").pipe(
						Layer.provideMerge(Layer.succeedContext(borrowed)),
					),
				);
				try {
					await projectRuntime.runPromise(
						Effect.flatMap(EventStoreEffectTag, (store) =>
							store.appendBatch(history("unprojected")),
						),
					);
				} finally {
					await projectRuntime.dispose();
				}
			} finally {
				await first.dispose();
			}
			await writeHistory(root, "beta", "later");
			const preparedConnections: SqlClient.SqlClient[] = [];
			const makeStore = persistenceLayers.makePersistenceStoreLayer;
			vi.spyOn(
				persistenceLayers,
				"makePersistenceStoreLayer",
			).mockImplementation((...args) =>
				Layer.effectDiscard(
					Effect.gen(function* () {
						preparedConnections.push(yield* SqlClient.SqlClient);
					}),
				).pipe(Layer.provideMerge(makeStore(...args))),
			);
			const importStores = importer.importRegisteredProjectStores;
			const imports = vi
				.spyOn(importer, "importRegisteredProjectStores")
				.mockImplementation((...args) =>
					Effect.gen(function* () {
						expect(preparedConnections.length).toBeGreaterThan(0);
						for (const sql of preparedConnections)
							expect((yield* Effect.exit(sql`SELECT 1`))._tag).toBe("Failure");
						const database = new Database(daemonStorePath(root));
						try {
							expect(
								database
									.prepare("SELECT id FROM sessions WHERE id = 'unprojected'")
									.all(),
							).toEqual([{ id: "unprojected" }]);
							database.exec("BEGIN EXCLUSIVE; ROLLBACK;");
						} finally {
							database.close();
						}
						return yield* importStores(...args);
					}),
				);
			const second = startup(root, [alpha, beta]);
			try {
				await second.runPromise(PersistenceStore);
				expect(imports).toHaveBeenCalledTimes(1);
				expect(
					await second.runPromise(
						Effect.flatMap(
							SqlClient.SqlClient,
							(sql) =>
								sql`SELECT project_id, parent_id, fork_point_event FROM sessions WHERE id = 'later'`,
						),
					),
				).toEqual([
					{
						project_id: "beta",
						parent_id: "parent",
						fork_point_event: "parent-message",
					},
				]);
				expect(existsSync(join(root, "fork-metadata-unresolved.json"))).toBe(
					false,
				);
				expect(sourceFiles(root)).toEqual([]);
			} finally {
				await second.dispose();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports a directory SQL failure as its typed read error, not an ambiguous owner", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-shared-directory-"));
		const runtime = startup(root, [project(root, "alpha")]);
		try {
			const result = await runtime.runPromise(
				Effect.gen(function* () {
					const directory = yield* SessionDirectory;
					const sql = yield* SqlClient.SqlClient;
					yield* sql`ALTER TABLE sessions RENAME TO unavailable_sessions`;
					return yield* Effect.either(directory.projectOf("parent"));
				}),
			);
			expect(result).toMatchObject({
				_tag: "Left",
				left: { _tag: "SessionDirectoryReadError", sessionId: "parent" },
			});
		} finally {
			await runtime.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("runs every cold reader on the shared connection without migrations, stamping or foreign-project results", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-shared-readers-"));
		const projects = [project(root, "alpha"), project(root, "beta")] as const;
		try {
			for (const { slug } of projects)
				await writeHistory(root, slug, `${slug}-session`);
			const runtime = startup(root, projects);
			try {
				const store = await runtime.runPromise(PersistenceStore);
				for (const { slug } of projects) {
					const launch = join(root, `${slug}-launch`);
					mkdirSync(launch);
					const relayProject = ManagedRuntime.make(
						makePersistenceProjectLayer(slug).pipe(
							Layer.provideMerge(Layer.succeedContext(store)),
						),
					);
					try {
						await relayProject.runPromise(
							Effect.gen(function* () {
								const events = yield* EventStoreEffectTag;
								const runner = yield* ProjectionRunnerEffectTag;
								yield* runner.recover();
								yield* runner.projectBatch(
									yield* events.appendBatch([
										canonicalEvent(
											"session.workspace_changed",
											`${slug}-session`,
											{
												sessionId: `${slug}-session`,
												worktrees: { [root]: launch },
												cause: "launch",
												origin: "conduit",
											},
											{ provider: "opencode", createdAt: 3000 },
										),
									]),
								);
							}),
						);
					} finally {
						await relayProject.dispose();
					}
				}
				await runtime.runPromise(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						yield* sql`UPDATE sessions SET status = 'busy', last_message_at = 2000`;
						for (const { slug } of projects) {
							yield* sql`INSERT INTO command_receipts (command_id, session_id, status, created_at, project_key) VALUES (${`${slug}-command`}, ${`${slug}-session`}, 'accepted', 1000, ${slug})`;
							yield* sql`INSERT INTO provider_command_meta (project_key, last_applied_sequence, schema_version, rebuilt_at) VALUES (${slug}, 0, 1, 1000)`;
						}
					}),
				);
				const preparation = watchReaderPreparation();
				for (const own of projects) {
					expect(
						await runtime.runPromise(
							hasProviderRecoveryCandidate(own, root, ["opencode"]),
						),
					).toBe(true);
					expect(
						await runtime.runPromise(countRunningProjectSessions(own, root)),
					).toBe(1);
					const rows = await runtime.runPromise(
						readColdWorktreeCleanupCandidates(
							own,
							root,
							{ ...DEFAULT_WORKTREE_CLEANUP, whenMerged: true },
							1_000_000,
						),
					);
					expect(rows).toEqual([
						{
							session_id: `${own.slug}-session`,
							path: join(root, `${own.slug}-launch`),
						},
					]);
				}
				await runtime.runPromise(
					Effect.flatMap(
						SqlClient.SqlClient,
						(sql) =>
							sql`UPDATE sessions SET status = 'idle' WHERE project_id = 'alpha'`,
					),
				);
				expect(
					await runtime.runPromise(
						hasProviderRecoveryCandidate(projects[0], root, ["opencode"]),
					),
				).toBe(false);
				expect(
					await runtime.runPromise(
						countRunningProjectSessions(projects[0], root),
					),
				).toBe(0);
				await runtime.runPromise(
					Effect.flatMap(
						SqlClient.SqlClient,
						(sql) => sql`UPDATE sessions SET status = 'idle'`,
					),
				);
				for (const own of projects)
					expect(
						await runtime.runPromise(
							hasColdAutoSettleCandidate(own, root, 1_000_000, 1000),
						),
					).toBe(true);
				await runtime.runPromise(
					Effect.flatMap(
						SqlClient.SqlClient,
						(sql) =>
							sql`UPDATE sessions SET auto_settle_disabled_at = 3000 WHERE project_id = 'alpha'`,
					),
				);
				expect(
					await runtime.runPromise(
						hasColdAutoSettleCandidate(projects[0], root, 1_000_000, 1000),
					),
				).toBe(false);
				const before = daemonStoreManifest(daemonStorePath(root));
				for (const own of projects) {
					await runtime.runPromise(
						listDaemonSessions(root, { scope: own.slug }),
					);
					await runtime.runPromise(
						resolveDaemonOpenCodeSession(
							root,
							"opencode",
							`${own.slug}-session-native`,
						),
					);
					await runtime.runPromise(
						hasProviderRecoveryCandidate(own, root, ["opencode"]),
					);
					await runtime.runPromise(countRunningProjectSessions(own, root));
					await runtime.runPromise(
						hasColdAutoSettleCandidate(own, root, 1_000_000, 1000),
					);
					await runtime.runPromise(
						readColdWorktreeCleanupCandidates(
							own,
							root,
							{ ...DEFAULT_WORKTREE_CLEANUP, whenMerged: true },
							1_000_000,
						),
					);
				}
				expect(daemonStoreManifest(daemonStorePath(root))).toEqual(before);
				expect(preparation.migrationRuns).not.toHaveBeenCalled();
				expect(preparation.stampRuns).not.toHaveBeenCalled();
				expect(sourceFiles(root)).toEqual([]);
			} finally {
				await runtime.dispose();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps standalone directory and daemon readers on per-project files without an opt-in store", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-per-file-default-"));
		const projects = [project(root, "alpha"), project(root, "beta")];
		try {
			await writeHistory(root, "alpha", "parent");
			await writeHistory(root, "beta", "child");
			const runtime = ManagedRuntime.make(
				Layer.mergeAll(
					makeProjectRegistryLive(projects),
					makeSessionDirectoryLive(root, projects),
					Layer.succeed(AccountDirectory, makeMockAccountDirectory()),
					Layer.effect(SessionActivityTag, makeSessionActivity),
				),
			);
			try {
				const sessions = await runtime.runPromise(listDaemonSessions(root));
				expect(
					sessions.sessions
						.map(({ id, projectSlug }) => [id, projectSlug])
						.sort(),
				).toEqual([
					["child", "beta"],
					["parent", "alpha"],
				]);
				expect(
					await runtime.runPromise(
						Effect.flatMap(SessionDirectory, (directory) =>
							directory.projectOf("child"),
						),
					),
				).toEqual(Option.some("beta"));
				expect(sourceFiles(root)).toEqual([
					"projects/alpha/events.db",
					"projects/beta/events.db",
				]);
				expect(existsSync(daemonStorePath(root))).toBe(false);
			} finally {
				await runtime.dispose();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
