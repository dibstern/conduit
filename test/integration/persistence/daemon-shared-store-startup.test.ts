// Failure modes: docs/plans/2026-10-16-shared-store-cutover-failure-modes.md.
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
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
import { PortScannerTag } from "../../../src/lib/domain/daemon/Layers/port-scanner-layer.js";
import {
	HttpServerRefTag,
	RelayFactoryLive,
	RelayFactoryTag,
} from "../../../src/lib/domain/daemon/Layers/relay-factory-layer.js";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { ConfigPersistenceNoopLive } from "../../../src/lib/domain/daemon/Services/config-persistence-service.js";
import {
	DaemonConfigRefLive,
	makeDaemonConfigFromOptions,
} from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import {
	countRunningProjectSessions,
	hasColdAutoSettleCandidate,
	hasProviderRecoveryCandidate,
	listDaemonSessions,
	resolveDaemonOpenCodeSession,
} from "../../../src/lib/domain/daemon/Services/daemon-session-reader.js";
import { DaemonStoreAvailability } from "../../../src/lib/domain/daemon/Services/daemon-store-availability.js";
import { InstanceHealthCheckLive } from "../../../src/lib/domain/daemon/Services/instance-health-service.js";
import { makeOpenCodeRuntimeStateLive } from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import {
	makeProjectRegistryLive,
	ProjectRegistryTag,
} from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import {
	makeSessionActivity,
	SessionActivityTag,
} from "../../../src/lib/domain/daemon/Services/session-activity.js";
import {
	makeSharedSessionDirectoryLive,
	SessionDirectory,
} from "../../../src/lib/domain/daemon/Services/session-directory.js";
import { readColdWorktreeCleanupCandidates } from "../../../src/lib/domain/daemon/Services/worktree-cleanup-reader.js";
import * as persistence from "../../../src/lib/domain/persistence/Services/persistence-service.js";
import { SessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { PushManagerTag } from "../../../src/lib/domain/server/Services/push-service.js";
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
import {
	makeMockAccountDirectory,
	makeOpenCodeInstancesStub,
} from "../../helpers/mock-factories.js";

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

const legacyProjectStorePath = (root: string, slug: string) =>
	join(root, "projects", slug, "events.db");

function sourceFiles(root: string): string[] {
	const projects = join(root, "projects");
	return existsSync(projects)
		? readdirSync(projects)
				.filter((slug) => existsSync(legacyProjectStorePath(root, slug)))
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
	const filename = legacyProjectStorePath(root, slug);
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
		RelayFactoryLive(root).pipe(
			Layer.provideMerge(
				Layer.mergeAll(
					store,
					registry,
					directory,
					Layer.succeed(AccountDirectory, makeMockAccountDirectory()),
					Layer.effect(SessionActivityTag, makeSessionActivity),
					DaemonConfigRefLive(makeDaemonConfigFromOptions({ port: 0 })),
					makeOpenCodeRuntimeStateLive(),
					DaemonEventBusLive,
					SessionEventBusLive,
					ConfigPersistenceNoopLive,
					InstanceHealthCheckLive,
					Layer.succeed(PortScannerTag, {
						getKnownPorts: () => Effect.succeed(new Set<number>()),
						scanNow: () =>
							Effect.succeed({ discovered: [], lost: [], active: [] }),
					}),
					Layer.succeed(OpenCodeInstancesTag, makeOpenCodeInstancesStub()),
					Layer.succeed(PushManagerTag, {
						subscribe: () => Effect.void,
						unsubscribe: () => Effect.void,
						broadcast: () => Effect.void,
						getPublicKey: Effect.succeed(undefined),
						addSubscription: () => Effect.void,
						removeSubscription: () => Effect.void,
						sendToAll: () => Effect.void,
						getLegacyManager: Effect.succeed(Option.none()),
					}),
				),
			),
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
	it("blocks a corrupt project's readers and relay while another project remains available", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-shared-unavailable-"));
		const alpha = project(root, "alpha");
		const beta = project(root, "beta");
		try {
			await writeHistory(root, "alpha", "healthy-session");
			mkdirSync(dirname(legacyProjectStorePath(root, "beta")), {
				recursive: true,
			});
			writeFileSync(
				legacyProjectStorePath(root, "beta"),
				"not a SQLite database",
			);
			mkdirSync(dirname(legacyProjectStorePath(root, "retained-corrupt")), {
				recursive: true,
			});
			writeFileSync(
				legacyProjectStorePath(root, "retained-corrupt"),
				"also not SQLite",
			);
			const runtime = startup(root, [alpha, beta]);
			try {
				const unavailable = await runtime.runPromise(DaemonStoreAvailability);
				const reason = unavailable.get("beta");
				expect(reason).toBe("History import failed (corrupt)");
				expect(unavailable.get("retained-corrupt")).toBe(
					"History import failed (corrupt)",
				);
				expect(unavailable.has("alpha")).toBe(false);
				const sessions = await runtime.runPromise(listDaemonSessions(root));
				expect(sessions.sessions.map(({ id }) => id)).toEqual([
					"healthy-session",
				]);
				expect(sessions.availability).toEqual([
					{ projectSlug: "alpha", available: true },
					{ projectSlug: "beta", available: false, error: reason },
				]);
				await runtime.runPromise(
					Effect.gen(function* () {
						// The factory checks availability before opening a store or writing its owner.
						yield* Ref.set(yield* HttpServerRefTag, createServer());
						const factory = yield* RelayFactoryTag;
						for (let retry = 0; retry < 2; retry++) {
							expect(yield* Effect.either(factory.create(beta))).toMatchObject({
								_tag: "Left",
								left: { _tag: "RelayFactoryError", reason },
							});
						}
						const sql = yield* SqlClient.SqlClient;
						expect(
							yield* sql`SELECT id FROM sessions WHERE project_id = 'beta'`,
						).toEqual([]);
						expect(
							yield* sql`SELECT event_id FROM events WHERE project_id = 'beta'`,
						).toEqual([]);
						// An unavailable list must not issue even a read against the store.
						yield* sql`ALTER TABLE sessions RENAME TO unavailable_sessions`;
						expect(
							yield* listDaemonSessions(root, { scope: "beta" }),
						).toMatchObject({
							sessions: [],
							availability: [
								{ projectSlug: "beta", available: false, error: reason },
							],
						});
					}),
				);
				expect(existsSync(join(root, "projects", "beta", "project.json"))).toBe(
					false,
				);
				expect(readFileSync(legacyProjectStorePath(root, "beta"), "utf8")).toBe(
					"not a SQLite database",
				);
			} finally {
				await runtime.dispose();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports a failed legacy rewrite as unavailable rather than an absent source", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-shared-legacy-failed-"));
		const alpha = project(root, "alpha");
		const beta = project(root, "beta");
		const legacy = join(beta.folders[0], ".conduit", "events.db");
		try {
			await writeHistory(root, "alpha", "healthy-session");
			mkdirSync(dirname(legacy));
			writeFileSync(legacy, "corrupt legacy database");
			const imports = vi.spyOn(importer, "importRegisteredProjectStores");
			const runtime = startup(root, [alpha, beta]);
			try {
				const unavailable = await runtime.runPromise(DaemonStoreAvailability);
				expect(unavailable.get("beta")).toMatch(
					/^Legacy history migration failed: Store rewrite failed:/,
				);
				expect(imports).toHaveBeenCalledTimes(1);
				expect(
					imports.mock.calls[0]?.[1].map(({ projectId }) => projectId),
				).toEqual(["alpha"]);
				expect(
					await runtime.runPromise(listDaemonSessions(root)),
				).toMatchObject({
					sessions: [{ id: "healthy-session" }],
					availability: [
						{ projectSlug: "alpha", available: true },
						{
							projectSlug: "beta",
							available: false,
							error: unavailable.get("beta"),
						},
					],
				});
				expect(existsSync(legacyProjectStorePath(root, "beta"))).toBe(false);
				expect(readFileSync(legacy, "utf8")).toBe("corrupt legacy database");
			} finally {
				await runtime.dispose();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("defers lineage writes and preserves their source when an existing shared owner becomes unavailable", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "conduit-shared-lineage-unavailable-"),
		);
		const alpha = project(root, "alpha");
		const beta = project(root, "beta");
		try {
			await writeHistory(root, "alpha", "parent");
			await writeHistory(root, "beta", "child");
			const first = startup(root, [alpha, beta]);
			try {
				await first.runPromise(PersistenceStore);
			} finally {
				await first.dispose();
			}
			const before = daemonStoreManifest(daemonStorePath(root));
			const legacy = join(beta.folders[0], ".conduit", "events.db");
			mkdirSync(dirname(legacy));
			writeFileSync(legacy, "corrupt restored legacy database");
			const lineage = JSON.stringify({
				child: { parentID: "parent", forkMessageId: "parent-message" },
			});
			const lineagePath = join(root, "fork-metadata.json");
			writeFileSync(lineagePath, lineage);
			const second = startup(root, [alpha, beta]);
			try {
				expect(
					(await second.runPromise(DaemonStoreAvailability)).get("beta"),
				).toMatch(/^Legacy history migration failed:/);
				expect(daemonStoreManifest(daemonStorePath(root))).toEqual(before);
				expect(readFileSync(lineagePath, "utf8")).toBe(lineage);
				expect(existsSync(join(root, "fork-metadata-unresolved.json"))).toBe(
					false,
				);
			} finally {
				await second.dispose();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("blocks a source that changed before its import committed", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-shared-uncommitted-"));
		const alpha = project(root, "alpha");
		try {
			vi.spyOn(importer, "importRegisteredProjectStores").mockReturnValue(
				Effect.succeed([
					{
						projectId: "alpha",
						outcome: "source-changed",
						error: new importer.DaemonStoreImportError({
							projectId: "alpha",
							kind: "source-changed",
							message: "Source changed during import",
						}),
					},
				]),
			);
			const runtime = startup(root, [alpha]);
			try {
				expect(await runtime.runPromise(DaemonStoreAvailability)).toEqual(
					new Map([["alpha", "History import failed (source-changed)"]]),
				);
			} finally {
				await runtime.dispose();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps committed history available after a backup-only failure and a changed source on restart", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "conduit-shared-backup-available-"),
		);
		const alpha = project(root, "alpha");
		const completedAt = 1_792_108_800_000;
		try {
			await writeHistory(root, "alpha", "original-session");
			writeFileSync(
				`${legacyProjectStorePath(root, "alpha")}.imported-${completedAt}`,
				"existing backup",
			);
			const results: importer.ProjectStoreImportResult[][] = [];
			const importStores = importer.importRegisteredProjectStores;
			vi.spyOn(importer, "importRegisteredProjectStores").mockImplementation(
				(configDir, sources) =>
					importStores(configDir, sources, { now: () => completedAt }).pipe(
						Effect.tap((imported) =>
							Effect.sync(() => results.push([...imported])),
						),
					),
			);
			const first = startup(root, [alpha]);
			try {
				expect(await first.runPromise(DaemonStoreAvailability)).toEqual(
					new Map(),
				);
				expect(results[0]).toMatchObject([
					{ outcome: "seeded", backupError: { kind: "io" } },
				]);
				expect(
					(await first.runPromise(listDaemonSessions(root))).availability,
				).toEqual([{ projectSlug: "alpha", available: true }]);
			} finally {
				await first.dispose();
			}
			const database = new Database(legacyProjectStorePath(root, "alpha"));
			try {
				database.pragma("user_version = 99");
			} finally {
				database.close();
			}
			const changed = readFileSync(legacyProjectStorePath(root, "alpha"));
			const second = startup(root, [alpha]);
			try {
				expect(await second.runPromise(DaemonStoreAvailability)).toEqual(
					new Map(),
				);
				expect(results[1]).toMatchObject([{ outcome: "source-changed" }]);
				expect(await second.runPromise(listDaemonSessions(root))).toMatchObject(
					{
						sessions: [{ id: "original-session" }],
						availability: [{ projectSlug: "alpha", available: true }],
					},
				);
				expect(readFileSync(legacyProjectStorePath(root, "alpha"))).toEqual(
					changed,
				);
			} finally {
				await second.dispose();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		false,
		true,
	])("imports retained stores after registered owners and hides them with existing destination=%s", async (existing) => {
		const root = mkdtempSync(join(tmpdir(), "conduit-shared-retained-"));
		const alpha = project(root, "alpha");
		try {
			if (existing) {
				const previous = startup(root, [alpha]);
				try {
					await previous.runPromise(PersistenceStore);
				} finally {
					await previous.dispose();
				}
			}
			await writeHistory(root, "alpha", "shared-session");
			await writeHistory(root, "z-retained", "shared-session");
			await writeHistory(root, "z-retained", "retained-shared");
			await writeHistory(root, "a-retained", "shared-session");
			await writeHistory(root, "a-retained", "retained-shared");
			for (let index = 0; index < 8; index++)
				await writeHistory(root, "a-retained", `retained-only-${index}`);
			expect(
				statSync(legacyProjectStorePath(root, "a-retained")).size,
			).toBeGreaterThan(statSync(legacyProjectStorePath(root, "alpha")).size);
			const imports = vi.spyOn(importer, "importRegisteredProjectStores");
			const runtime = startup(root, [alpha]);
			try {
				expect(await runtime.runPromise(DaemonStoreAvailability)).toEqual(
					new Map(),
				);
				expect(
					imports.mock.calls[0]?.[1].map(({ projectId, retained }) => [
						projectId,
						retained,
					]),
				).toEqual([
					["alpha", undefined],
					["a-retained", true],
					["z-retained", true],
				]);
				await runtime.runPromise(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						expect(
							yield* sql`SELECT project_id FROM sessions WHERE id = 'shared-session'`,
						).toEqual([{ project_id: "alpha" }]);
						expect(
							yield* sql`SELECT project_id FROM sessions WHERE id = 'retained-shared'`,
						).toEqual([{ project_id: "a-retained" }]);
						expect(
							yield* sql`SELECT project_id FROM sessions WHERE id = 'retained-only-0'`,
						).toEqual([{ project_id: "a-retained" }]);
						for (const options of [
							{},
							{ search: "retained" },
							{ scope: "a-retained" },
						]) {
							const list = yield* listDaemonSessions(root, options);
							expect(list.sessions.map(({ id }) => id)).toEqual(
								"search" in options || "scope" in options
									? []
									: ["shared-session"],
							);
							expect(
								list.availability.map(({ projectSlug }) => projectSlug),
							).not.toContain("a-retained");
						}
						const directory = yield* SessionDirectory;
						expect(yield* directory.projectOf("shared-session")).toEqual(
							Option.some("alpha"),
						);
						expect(yield* directory.projectOf("retained-shared")).toEqual(
							Option.none(),
						);
						expect(yield* directory.projectOf("retained-only-0")).toEqual(
							Option.none(),
						);
						expect(
							yield* resolveDaemonOpenCodeSession(
								"opencode",
								"retained-shared-native",
							),
						).toBeUndefined();
					}),
				);
				expect(sourceFiles(root)).toEqual([]);
			} finally {
				await runtime.dispose();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("imports retained-only history without promoting an unregistered seed", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-shared-retained-only-"));
		try {
			await writeHistory(root, "retained", "retained-session");
			const runtime = startup(root, []);
			try {
				expect(await runtime.runPromise(DaemonStoreAvailability)).toEqual(
					new Map(),
				);
				expect(
					await runtime.runPromise(
						Effect.flatMap(
							SqlClient.SqlClient,
							(sql) => sql`SELECT id, project_id FROM sessions`,
						),
					),
				).toEqual([{ id: "retained-session", project_id: "retained" }]);
				expect(
					await runtime.runPromise(listDaemonSessions(root)),
				).toMatchObject({ sessions: [], availability: [] });
				expect(
					await runtime.runPromise(
						Effect.flatMap(SessionDirectory, (directory) =>
							directory.projectOf("retained-session"),
						),
					),
				).toEqual(Option.none());
				expect(
					readFileSync(join(root, "daemon-store-import-report.txt"), "utf8"),
				).toMatch(/retained: imported/);
				expect(sourceFiles(root)).toEqual([]);
			} finally {
				await runtime.dispose();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

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
						readdirSync(dirname(legacyProjectStorePath(root, slug))).some(
							(name) => name.startsWith("events.db.imported-"),
						),
					).toBe(true);
				const lineage = await runtime.runPromise(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						return yield* sql`SELECT project_id, parent_id, forked_from, root_id, fork_point_event, fork_point_timestamp FROM sessions WHERE id = 'child'`;
					}),
				);
				// ADR-0007: a Fork keeps its Source as lineage, not containment.
				expect(lineage).toEqual([
					{
						project_id: "beta",
						parent_id: null,
						forked_from: "parent",
						root_id: "child",
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
							resolveDaemonOpenCodeSession("opencode", `${id}-native`),
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
								sql`SELECT project_id, parent_id, forked_from, fork_point_event FROM sessions WHERE id = 'later'`,
						),
					),
				).toEqual([
					{
						project_id: "beta",
						parent_id: null,
						forked_from: "parent",
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
							hasProviderRecoveryCandidate(own, ["opencode"]),
						),
					).toBe(true);
					expect(
						await runtime.runPromise(countRunningProjectSessions(own)),
					).toBe(1);
					// Cleanup only considers settled sessions, while the auto-settle
					// reader below needs these sessions unsettled.
					const setSettledAt = (settledAt: number | null) =>
						runtime.runPromise(
							Effect.flatMap(
								SqlClient.SqlClient,
								(sql) =>
									sql`UPDATE sessions SET settled_at = ${settledAt} WHERE project_id = ${own.slug}`,
							),
						);
					await setSettledAt(2000);
					const rows = await runtime.runPromise(
						readColdWorktreeCleanupCandidates(
							own,
							DEFAULT_WORKTREE_CLEANUP,
							1_000_000,
						),
					);
					await setSettledAt(null);
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
						hasProviderRecoveryCandidate(projects[0], ["opencode"]),
					),
				).toBe(false);
				expect(
					await runtime.runPromise(countRunningProjectSessions(projects[0])),
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
							hasColdAutoSettleCandidate(own, 1_000_000, 1000),
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
						hasColdAutoSettleCandidate(projects[0], 1_000_000, 1000),
					),
				).toBe(false);
				const before = daemonStoreManifest(daemonStorePath(root));
				for (const own of projects) {
					await runtime.runPromise(
						listDaemonSessions(root, { scope: own.slug }),
					);
					await runtime.runPromise(
						resolveDaemonOpenCodeSession(
							"opencode",
							`${own.slug}-session-native`,
						),
					);
					await runtime.runPromise(
						hasProviderRecoveryCandidate(own, ["opencode"]),
					);
					await runtime.runPromise(countRunningProjectSessions(own));
					await runtime.runPromise(
						hasColdAutoSettleCandidate(own, 1_000_000, 1000),
					);
					await runtime.runPromise(
						readColdWorktreeCleanupCandidates(
							own,
							DEFAULT_WORKTREE_CLEANUP,
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

	it("imports registered and retained sources by default while hiding retained history", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-shared-default-"));
		const projects = [project(root, "alpha"), project(root, "beta")];
		try {
			await writeHistory(root, "alpha", "parent");
			await writeHistory(root, "beta", "child");
			await writeHistory(root, "retained", "hidden-session");
			const imports = vi.spyOn(importer, "importRegisteredProjectStores");
			const runtime = startup(root, projects);
			try {
				expect(await runtime.runPromise(DaemonStoreAvailability)).toEqual(
					new Map(),
				);
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
				expect(sourceFiles(root)).toEqual([]);
				expect(imports).toHaveBeenCalledOnce();
				expect(existsSync(daemonStorePath(root))).toBe(true);
				expect(
					await runtime.runPromise(
						Effect.flatMap(SessionDirectory, (directory) =>
							directory.projectOf("hidden-session"),
						),
					),
				).toEqual(Option.none());
			} finally {
				await runtime.dispose();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
