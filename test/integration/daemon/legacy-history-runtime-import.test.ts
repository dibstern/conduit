import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import {
	Context,
	Deferred,
	Effect,
	Fiber,
	Layer,
	ManagedRuntime,
	Ref,
	Stream,
} from "effect";
import {
	RpcClient,
	type RpcClientError,
	RpcSerialization,
	RpcTest,
} from "effect/rpc";
import { Socket } from "effect/socket";
import { SqlClient } from "effect/sql";
import { describe, expect, it, vi } from "vitest";
import {
	type ProjectInfo,
	type SessionInfo,
	WsRpcGroup,
} from "../../../src/lib/contracts/ws-rpc.js";
import { startForegroundDaemon } from "../../../src/lib/domain/daemon/Layers/daemon-foreground.js";
import { DaemonWsRpcHandlersTag } from "../../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.js";
import { DaemonStoreAvailability } from "../../../src/lib/domain/daemon/Services/daemon-store-availability.js";
import { saveProject } from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import {
	InputDraftsTag,
	makeInputDrafts,
} from "../../../src/lib/domain/relay/Services/input-drafts.js";
import {
	makePersistenceProjectLayer,
	PersistenceStore,
} from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { SessionRollupProjects } from "../../../src/lib/persistence/effect/session-rollup-projects.js";
import { refreshSidebar } from "../../../src/lib/persistence/effect/sidebar-projection.js";
import {
	daemonStorePath,
	writeProjectStorageOwner,
} from "../../../src/lib/persistence/project-storage.js";
import { makeRoutedWsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";
import {
	createProjectStoreFixture,
	writeImportArtifact,
} from "../../helpers/daemon-store-import-manifest.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

type Client = RpcClient.FromGroup<
	typeof WsRpcGroup,
	RpcClientError.RpcClientError
>;

const browserProtocol = (port: number) =>
	RpcClient.layerProtocolSocket().pipe(
		Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${port}/rpc`)),
		Layer.provide(Socket.layerWebSocketConstructorGlobal),
		Layer.provide(RpcSerialization.layerJson),
	);

const browserCall = <A, E>(
	port: number,
	call: (client: Client) => Effect.Effect<A, E>,
) =>
	Effect.runPromise(
		Effect.scoped(Effect.flatMap(RpcClient.make(WsRpcGroup), call)).pipe(
			Effect.provide(browserProtocol(port)),
		),
	);

function subscribeShell(port: number) {
	const sessions = new Map<string, SessionInfo>();
	let projects: readonly ProjectInfo[] = [];
	let snapshots = 0;
	const fiber = Effect.runFork(
		Effect.scoped(
			Effect.gen(function* () {
				const client = yield* RpcClient.make(WsRpcGroup);
				yield* Stream.runForEach(client.SubscribeShell({}), (frame) =>
					Effect.sync(() => {
						switch (frame._tag) {
							case "projects":
								projects = frame.projects;
								break;
							case "snapshot":
								sessions.clear();
								for (const row of frame.rows) sessions.set(row.id, row);
								snapshots++;
								break;
							case "upsert":
								sessions.set(frame.item.id, frame.item);
								break;
							case "remove":
								sessions.delete(frame.id);
						}
					}),
				);
			}),
		).pipe(Effect.provide(browserProtocol(port))),
	);
	return {
		sessions,
		projects: () => projects,
		snapshots: () => snapshots,
		close: () => Effect.runPromise(Fiber.interrupt(fiber)),
	};
}

async function readHistory(port: number, sessionId: string) {
	try {
		return {
			messages: (
				await browserCall(port, (client) =>
					client.LoadMoreHistory({ sessionId }),
				)
			).messages,
			error: null,
		};
	} catch (error) {
		return {
			messages: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function eventCounts(filename: string, projectSlug: string) {
	const db = new Database(filename, { readonly: true });
	try {
		return db
			.prepare<[string], { session_id: string; count: number }>(
				"SELECT session_id, COUNT(*) AS count FROM events WHERE project_id = ? GROUP BY session_id ORDER BY session_id",
			)
			.all(projectSlug);
	} finally {
		db.close();
	}
}

async function runtimeImportFixture() {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "conduit-import-review-")),
	);
	const configDir = join(root, "config");
	mkdirSync(configDir);
	const unavailable = new Map<string, string>();
	const runtime = ManagedRuntime.make(
		makeDaemonRpcTestLayer([], undefined, { configDir }).pipe(
			Layer.provideMerge(Layer.succeed(DaemonStoreAvailability)(unavailable)),
		),
	);
	const store = Context.add(
		await runtime.runPromise(PersistenceStore),
		SessionRollupProjects,
		await Effect.runPromise(Ref.make<readonly string[]>([])),
	);
	const sql = Context.get(store, SqlClient.SqlClient);
	const drafts = await Effect.runPromise(
		makeInputDrafts.pipe(Effect.provide(store)),
	);
	return {
		root,
		configDir,
		unavailable,
		sql,
		drafts,
		store,
		runtime,
		save: (folder: string) =>
			runtime.runPromise(
				saveProject({ folders: [folder] }).pipe(
					Effect.provideService(InputDraftsTag, drafts),
					Effect.provideService(PersistenceStore, store),
				),
			),
		close: async () => {
			await runtime.dispose();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

describe("legacy history added after daemon startup", () => {
	const evidence: Record<string, unknown> = {};

	// Runtime registration must not sweep a newly uploaded blob that has not yet
	// been referenced, including while opening and importing the private source.
	it("keeps unreferenced attachments during runtime project registration", async () => {
		const fixture = await runtimeImportFixture();
		const { root, runtime, sql, unavailable } = fixture;
		const folder = join(root, "attachment-history");
		const liveHash = "a".repeat(64);
		const importedHash = "b".repeat(64);
		try {
			await runtime.runPromise(sql`INSERT INTO attachment_blobs
				(hash, mime, size, bytes, created_at)
				VALUES (${liveHash}, 'text/plain', 4, ${Buffer.from("live")}, 1000)`);
			const source = await createProjectStoreFixture(
				root,
				"attachment-history",
				{
					sourcePath: join(folder, ".conduit", "events.db"),
					transcript: { prompt: "Prompt", reply: "Reply" },
				},
			);
			const sourceDb = new Database(source.sourcePath);
			try {
				sourceDb
					.prepare(
						"INSERT INTO attachment_blobs (hash, mime, size, bytes, created_at) VALUES (?, 'text/plain', 6, ?, 1000)",
					)
					.run(importedHash, Buffer.from("source"));
			} finally {
				sourceDb.close();
			}
			const saved = await fixture.save(folder);
			expect(saved.project.slug).toBe("attachment-history");
			expect(unavailable.size).toBe(0);
			expect(
				await runtime.runPromise(
					sql`SELECT hash FROM attachment_blobs ORDER BY hash`,
				),
			).toEqual([{ hash: liveHash }, { hash: importedHash }]);
		} finally {
			await fixture.close();
		}
	});

	it.each([
		false,
		true,
	])("reconciles unresolved Fork lineage before publication, stored project unavailable: %s", async (blocked) => {
		const fixture = await runtimeImportFixture();
		const { root, configDir, sql, runtime, unavailable } = fixture;
		const folder = join(root, "fork-history");
		const archive = join(configDir, "fork-metadata-unresolved.json");
		try {
			for (const sessionId of ["fork-source", "imported-fork"])
				await createProjectStoreFixture(root, "fork-history", {
					sourcePath: join(folder, ".conduit", "events.db"),
					sessionId,
					transcript: { title: sessionId, prompt: "Prompt", reply: "Reply" },
				});
			const lineage = {
				"imported-fork": {
					parentID: "fork-source",
					forkMessageId: "fork-source_assistant",
				},
			};
			writeFileSync(archive, JSON.stringify(lineage));
			// Only unavailable projects with stored rows defer global reconciliation.
			unavailable.set("unavailable-history", "History import failed (corrupt)");
			if (blocked)
				await runtime.runPromise(sql`INSERT INTO sessions
					(id, project_id, provider, root_id, created_at, updated_at)
					VALUES ('blocked-session', 'unavailable-history', 'claude', 'blocked-session', 1, 1)`);
			const saved = await fixture.save(folder);
			expect(saved.project.slug).toBe("fork-history");
			const rows = await runtime.runPromise(sql`SELECT forked_from,
				fork_point_event, fork_point_timestamp FROM sessions WHERE id = 'imported-fork'`);
			const state = { rows, unresolvedArchiveRetained: existsSync(archive) };
			evidence[blocked ? "forkLineageDeferred" : "forkLineageReconciled"] =
				state;
			expect.soft(rows).toEqual([
				{
					forked_from: blocked ? null : "fork-source",
					fork_point_event: blocked ? null : "fork-source_assistant",
					fork_point_timestamp: blocked ? null : 1000,
				},
			]);
			expect.soft(state.unresolvedArchiveRetained).toBe(blocked);
		} finally {
			writeImportArtifact("test-results/82tn28-runtime-import.json", evidence);
			await fixture.close();
		}
	});

	it("keeps removed-project activity out of an existing fork after runtime lineage reconciliation", async () => {
		const fixture = await runtimeImportFixture();
		const { root, configDir, sql, runtime, store } = fixture;
		try {
			const liveFolder = join(root, "live-project");
			mkdirSync(liveFolder);
			await fixture.save(liveFolder);
			await runtime.runPromise(sql`INSERT INTO sessions
				(id, project_id, provider, root_id, parent_id, forked_from, status, created_at, updated_at)
				VALUES
				('fork-source', 'live-project', 'claude', 'fork-source', NULL, NULL, 'idle', 1, 1),
				('existing-fork', 'live-project', 'claude', 'existing-fork', NULL, 'fork-source', 'idle', 1, 1),
				('removed-child', 'removed-project', 'claude', 'existing-fork', 'existing-fork', NULL, 'busy', 1, 1)`);
			await runtime.runPromise(
				refreshSidebar(["existing-fork"], 1, ["live-project"]).pipe(
					Effect.provideService(SqlClient.SqlClient, sql),
				),
			);
			const read = await Effect.runPromise(
				ReadQueryEffectTag.pipe(
					Effect.provide(
						makePersistenceProjectLayer("live-project").pipe(
							Layer.provide(Layer.succeedContext(store)),
						),
					),
				),
			);
			const inspect = async () => {
				const listed = await runtime.runPromise(
					read.readSessionList({ projectIds: ["live-project"] }),
				);
				return listed.rows.find(({ item }) => item.id === "existing-fork")?.item
					.attention;
			};
			const before = await inspect();
			expect(before).toBe("idle");
			const folder = join(root, "other-history");
			await createProjectStoreFixture(root, "other-history", {
				sourcePath: join(folder, ".conduit", "events.db"),
				transcript: { prompt: "Prompt", reply: "Reply" },
			});
			writeFileSync(
				join(configDir, "fork-metadata-unresolved.json"),
				JSON.stringify({
					"existing-fork": {
						parentID: "fork-source",
						forkMessageId: "source-message",
					},
				}),
			);
			await fixture.save(folder);
			const after = await inspect();
			const lineage = await runtime.runPromise(sql`SELECT fork_point_event
				FROM sessions WHERE id = 'existing-fork'`);
			evidence["filteredForkRollup"] = { before, after, lineage };
			expect(lineage).toEqual([{ fork_point_event: "source-message" }]);
			expect(after).toBe("idle");
		} finally {
			writeImportArtifact("test-results/82tn28-runtime-import.json", evidence);
			await fixture.close();
		}
	});

	it("releases only imported draft claims and discards imported empty claims", async () => {
		const fixture = await runtimeImportFixture();
		const { root, sql, drafts, runtime } = fixture;
		const folder = join(root, "draft-history");
		try {
			const source = await createProjectStoreFixture(root, "draft-history", {
				sourcePath: join(folder, ".conduit", "events.db"),
				transcript: { prompt: "Prompt", reply: "Reply" },
			});
			const db = new Database(source.sourcePath);
			try {
				db.prepare(`INSERT INTO input_drafts
					(draft_key, project_id, kind, text, updated_at, promoted_session_id)
					VALUES (?, 'draft-history', 'draft', ?, 1000, ?)`).run(
					"imported-claimed",
					"Recovered thought",
					":input-draft-claim:",
				);
				db.prepare(`INSERT INTO input_drafts
					(draft_key, project_id, kind, text, updated_at, promoted_session_id)
					VALUES ('imported-empty', 'draft-history', 'draft', '', 1000, ':input-draft-claim:')`).run();
			} finally {
				db.close();
			}
			// The same project slug does not make these live claims abandoned.
			await runtime.runPromise(
				drafts.write(
					{ draft: "live-claimed" },
					"Sending now",
					undefined,
					"draft-history",
				),
			);
			expect(
				await runtime.runPromise(drafts.claim("live-claimed", "draft-history")),
			).toBe(true);
			expect(
				await runtime.runPromise(drafts.claim("live-empty", "draft-history")),
			).toBe(true);
			await fixture.save(folder);
			const listed = await runtime.runPromise(
				Stream.runCollect(drafts.listDrafts().pipe(Stream.take(1))),
			);
			const emptyRows = await runtime.runPromise(
				sql`SELECT draft_key FROM input_drafts WHERE draft_key IN ('imported-empty', 'live-empty') ORDER BY draft_key`,
			);
			const claimed = await runtime.runPromise(
				drafts.claim("imported-claimed", "draft-history"),
			);
			const liveClaimedAgain = await runtime.runPromise(
				drafts.claim("live-claimed", "draft-history"),
			);
			const liveEmptyClaimedAgain = await runtime.runPromise(
				drafts.claim("live-empty", "draft-history"),
			);
			evidence["draftClaimRecovery"] = {
				listed,
				emptyRows,
				claimed,
				liveClaimedAgain,
				liveEmptyClaimedAgain,
			};
			expect
				.soft(listed[0]?.map((draft) => draft.draftId))
				.toEqual(["imported-claimed"]);
			expect.soft(claimed).toBe(true);
			expect.soft(emptyRows).toEqual([{ draft_key: "live-empty" }]);
			expect.soft(liveClaimedAgain).toBe(false);
			expect.soft(liveEmptyClaimedAgain).toBe(false);
		} finally {
			writeImportArtifact("test-results/82tn28-runtime-import.json", evidence);
			await fixture.close();
		}
	});

	it("keeps a CreateSession draft claim taken immediately after the import commits", async () => {
		const fixture = await runtimeImportFixture();
		const { root, sql, drafts, runtime } = fixture;
		const folder = join(root, "draft-history");
		const reserve = sql.reserve;
		let claimedAfterCommit = false;
		try {
			const liveFolder = join(root, "live-project");
			mkdirSync(liveFolder);
			await fixture.save(liveFolder);
			const source = await createProjectStoreFixture(root, "draft-history", {
				sourcePath: join(folder, ".conduit", "events.db"),
				transcript: { prompt: "Prompt", reply: "Reply" },
			});
			const db = new Database(source.sourcePath);
			try {
				db.prepare(`INSERT INTO input_drafts
					(draft_key, project_id, kind, text, updated_at)
					VALUES ('imported-live-claim', 'draft-history', 'draft', 'Send once', 1000)`).run();
			} finally {
				db.close();
			}
			Object.defineProperty(sql, "reserve", {
				value: Effect.gen(function* () {
					// Finalizers run in reverse order: claim after the connection is
					// released, before SaveProject can run any post-import cleanup.
					yield* Effect.addFinalizer(() =>
						drafts.claim("imported-live-claim", "live-project").pipe(
							Effect.tap((claimed) =>
								Effect.sync(() => {
									claimedAfterCommit = claimed;
								}),
							),
							Effect.orDie,
						),
					);
					return yield* reserve;
				}),
			});
			await fixture.save(folder);
			const claimedAgain = await runtime.runPromise(
				drafts.claim("imported-live-claim", "live-project"),
			);
			evidence["draftClaimAfterCommit"] = { claimedAfterCommit, claimedAgain };
			expect(claimedAfterCommit).toBe(true);
			expect(claimedAgain).toBe(false);
		} finally {
			Object.defineProperty(sql, "reserve", { value: reserve });
			writeImportArtifact("test-results/82tn28-runtime-import.json", evidence);
			await fixture.close();
		}
	});

	it("notifies a listDrafts subscriber opened before the runtime import", async () => {
		const root = realpathSync(
			mkdtempSync(join(tmpdir(), "conduit-import-subscriber-")),
		);
		const folder = join(root, "subscribed-drafts");
		const snapshots: string[][] = [];
		let daemon: Awaited<ReturnType<typeof startForegroundDaemon>> | undefined;
		let subscriber: Fiber.Fiber<void, unknown> | undefined;
		try {
			daemon = await startForegroundDaemon({
				configDir: join(root, "config"),
				socketPath: join(root, "relay.sock"),
				port: 0,
				host: "127.0.0.1",
				keepAwake: false,
				smartDefault: false,
			});
			const port = daemon.getStatus().port;
			subscriber = Effect.runFork(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						yield* Stream.runForEach(client.SubscribeDrafts({}), (rows) =>
							Effect.sync(() => {
								snapshots.push(rows.map((row) => row.draftId));
							}),
						);
					}),
				).pipe(Effect.provide(browserProtocol(port))),
			);
			await vi.waitFor(() => expect(snapshots).toEqual([[]]));
			const source = await createProjectStoreFixture(
				root,
				"subscribed-drafts",
				{
					sourcePath: join(folder, ".conduit", "events.db"),
					transcript: { prompt: "Prompt", reply: "Reply" },
				},
			);
			const db = new Database(source.sourcePath);
			try {
				db.prepare(`INSERT INTO input_drafts (draft_key, project_id, kind, text, updated_at)
					VALUES ('imported-visible', 'subscribed-drafts', 'draft', 'Visible without reconnect', 1000)`).run();
			} finally {
				db.close();
			}
			await browserCall(port, (client) =>
				client.SaveProject({ folders: [folder] }),
			);
			await vi.waitFor(
				() => expect(snapshots).toContainEqual(["imported-visible"]),
				{ timeout: 3000 },
			);
		} finally {
			evidence["draftSubscriberImport"] = { snapshots };
			writeImportArtifact("test-results/82tn28-runtime-import.json", evidence);
			if (subscriber) await Effect.runPromise(Fiber.interrupt(subscriber));
			await daemon?.stop();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("publishes imported history immediately, preserves it on restart, and isolates corrupt history", async () => {
		const root = realpathSync(
			mkdtempSync(join(tmpdir(), "conduit-runtime-history-")),
		);
		const configDir = join(root, "config");
		const folder = join(root, "runtime-history");
		const corruptFolder = join(root, "corrupt-history");
		const legacy = join(folder, ".conduit", "events.db");
		const corruptLegacy = join(corruptFolder, ".conduit", "events.db");
		const options = {
			configDir,
			socketPath: join(root, "relay.sock"),
			port: 0,
			host: "127.0.0.1",
			keepAwake: false,
			smartDefault: false,
		};
		const fixtures = [
			{
				id: "legacy-session-1",
				title: "First legacy session",
				prompt: "First prompt",
				reply: "First reply",
			},
			{
				id: "legacy-session-2",
				title: "Second legacy session",
				prompt: "Second prompt",
				reply: "Second reply",
			},
		];
		let daemon: Awaited<ReturnType<typeof startForegroundDaemon>> | undefined;
		let shell: ReturnType<typeof subscribeShell> | undefined;
		try {
			daemon = await startForegroundDaemon(options);
			let port = daemon.getStatus().port;
			expect(
				(await browserCall(port, (client) => client.GetProjects({}))).projects,
			).toEqual([]);
			// Warm the daemon's readers and subscribe before there is any imported history.
			expect(
				(await browserCall(port, (client) => client.ListDaemonSessions({})))
					.sessions,
			).toEqual([]);
			shell = subscribeShell(port);
			await vi.waitFor(() => expect(shell?.snapshots()).toBe(1));
			for (const fixture of fixtures) {
				await createProjectStoreFixture(root, "runtime-history", {
					sourcePath: legacy,
					sessionId: fixture.id,
					transcript: {
						title: fixture.title,
						prompt: fixture.prompt,
						reply: fixture.reply,
					},
				});
			}
			const expectedEvents = eventCounts(legacy, "runtime-history");
			mkdirSync(join(corruptFolder, ".conduit"), { recursive: true });
			writeFileSync(corruptLegacy, "not a SQLite database");

			const [saved, corrupt] = await Promise.all([
				browserCall(port, (client) =>
					client.SaveProject({ folders: [folder] }),
				),
				browserCall(port, (client) =>
					client.SaveProject({ folders: [corruptFolder] }),
				),
			]);
			expect(saved.savedSlug).toBe("runtime-history");
			expect(corrupt.savedSlug).toBe("corrupt-history");

			const inspect = async () => {
				const projects = (
					await browserCall(port, (client) => client.GetProjects({}))
				).projects;
				const listed = await browserCall(port, (client) =>
					client.ListDaemonSessions({}),
				);
				const histories = await Promise.all(
					fixtures.map((fixture) => readHistory(port, fixture.id)),
				);
				const archive = {
					legacy: existsSync(legacy),
					migrated: existsSync(`${legacy}.migrated`),
					projectStore: existsSync(
						join(configDir, "projects", saved.savedSlug, "events.db"),
					),
					importedBackups: existsSync(
						join(configDir, "projects", saved.savedSlug),
					)
						? readdirSync(join(configDir, "projects", saved.savedSlug)).filter(
								(name) => /^events\.db\.imported-\d+$/.test(name),
							).length
						: 0,
					corruptLegacy: existsSync(corruptLegacy),
				};
				return {
					projects,
					listed,
					histories,
					archive,
					events: eventCounts(daemonStorePath(configDir), saved.savedSlug),
				};
			};
			const normalize = (state: Awaited<ReturnType<typeof inspect>>) => ({
				sessions: state.listed.sessions
					.map((session) => ({
						id: fixtures.findIndex((fixture) => fixture.id === session.id) + 1,
						title: session.title,
					}))
					.sort((a, b) => a.id - b.id),
				messageCounts: state.histories.map((history, index) => ({
					id: index + 1,
					count: history.messages.length,
				})),
				eventCounts: state.events.map((row) => ({
					id:
						fixtures.findIndex((fixture) => fixture.id === row.session_id) + 1,
					count: row.count,
				})),
				archive: state.archive,
				availability: [saved.savedSlug, corrupt.savedSlug].map(
					(slug, index) => {
						const project = state.projects.find(
							(project) => project.slug === slug,
						);
						const available = state.listed.availability.find(
							(item) => item.projectSlug === slug,
						);
						return {
							id: index + 1,
							available: available?.available ?? null,
							reason: project?.unavailableReason
								? project.unavailableReason.split(":")[0]
								: null,
						};
					},
				),
			});
			const assertState = (state: Awaited<ReturnType<typeof inspect>>) => {
				expect
					.soft(state.listed.sessions.map((session) => session.title).sort())
					.toEqual(fixtures.map((fixture) => fixture.title));
				expect.soft(state.events).toEqual(expectedEvents);
				for (const [index, fixture] of fixtures.entries()) {
					const history = state.histories[index];
					expect.soft(history?.error).toBeNull();
					expect
						.soft(
							history?.messages
								.map((message) => ({
									role: message.role,
									text: message.parts?.map((part) => part.text ?? "").join(""),
								}))
								.sort((a, b) => a.role.localeCompare(b.role)),
						)
						.toEqual([
							{ role: "assistant", text: fixture.reply },
							{ role: "user", text: fixture.prompt },
						]);
				}
				expect.soft(state.archive).toEqual({
					legacy: false,
					migrated: true,
					projectStore: false,
					importedBackups: 1,
					corruptLegacy: true,
				});
				expect
					.soft(state.listed.availability)
					.toContainEqual({ projectSlug: saved.savedSlug, available: true });
				expect.soft(state.listed.availability).toContainEqual(
					expect.objectContaining({
						projectSlug: corrupt.savedSlug,
						available: false,
						error: expect.stringMatching(
							/^Legacy history migration failed: Store rewrite failed:/,
						),
					}),
				);
				expect
					.soft(
						state.projects.find((project) => project.slug === corrupt.savedSlug)
							?.unavailableReason,
					)
					.toMatch(/^Legacy history migration failed: Store rewrite failed:/);
			};

			const before = await inspect();
			evidence["beforeRestart"] = normalize(before);
			assertState(before);
			// The existing subscriber must learn both the imported rows and availability.
			await vi
				.waitFor(
					() => {
						expect(
							[...(shell?.sessions.values() ?? [])]
								.map((session) => session.title)
								.sort(),
						).toEqual(fixtures.map((fixture) => fixture.title));
						expect(
							shell
								?.projects()
								.find((project) => project.slug === corrupt.savedSlug)
								?.unavailableReason,
						).toMatch(/^Legacy history migration failed:/);
					},
					{ timeout: 2_000 },
				)
				.catch(() => undefined);
			expect
				.soft(
					[...shell.sessions.values()].map((session) => session.title).sort(),
				)
				.toEqual(fixtures.map((fixture) => fixture.title));
			expect
				.soft(
					shell.projects().find((project) => project.slug === corrupt.savedSlug)
						?.unavailableReason,
				)
				.toMatch(/^Legacy history migration failed:/);
			evidence["shellBeforeRestart"] = {
				titles: [...shell.sessions.values()]
					.map((session) => session.title)
					.sort(),
				projectAvailability: shell
					.projects()
					.map((project) => ({
						id: project.slug === saved.savedSlug ? 1 : 2,
						available: !project.unavailableReason,
					}))
					.sort((a, b) => a.id - b.id),
			};
			await shell.close();
			shell = undefined;
			await daemon.stop();
			daemon = await startForegroundDaemon(options);
			port = daemon.getStatus().port;
			const after = await inspect();
			evidence["afterRestart"] = normalize(after);
			assertState(after);
			expect.soft(after.events).toEqual(before.events);
			expect
				.soft(after.listed.sessions.map((session) => session.id).sort())
				.toEqual(fixtures.map((fixture) => fixture.id));
		} finally {
			await shell?.close();
			await daemon?.stop();
			writeImportArtifact("test-results/82tn28-runtime-import.json", evidence);
			rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	it("imports two legacy projects before either relay opens and preserves both on restart", async () => {
		const root = realpathSync(
			mkdtempSync(join(tmpdir(), "conduit-two-imports-")),
		);
		const configDir = join(root, "config");
		const options = {
			configDir,
			socketPath: join(root, "relay.sock"),
			port: 0,
			host: "127.0.0.1",
			keepAwake: false,
			smartDefault: false,
		};
		const fixtures = [
			{
				slug: "first-import",
				id: "first-import-session",
				title: "First imported project",
			},
			{
				slug: "second-import",
				id: "second-import-session",
				title: "Second imported project",
			},
		];
		let daemon: Awaited<ReturnType<typeof startForegroundDaemon>> | undefined;
		const stages: Record<string, unknown> = {};
		try {
			daemon = await startForegroundDaemon(options);
			let port = daemon.getStatus().port;
			expect(
				(await browserCall(port, (client) => client.GetProjects({}))).projects,
			).toEqual([]);
			for (const fixture of fixtures) {
				const folder = join(root, fixture.slug);
				await createProjectStoreFixture(root, fixture.slug, {
					sourcePath: join(folder, ".conduit", "events.db"),
					sessionId: fixture.id,
					transcript: {
						title: fixture.title,
						prompt: "Legacy prompt",
						reply: "Legacy reply",
					},
				});
				// Save both projects before any history read can start a relay and recover cursors.
				const saved = await browserCall(port, (client) =>
					client.SaveProject({ folders: [folder] }),
				);
				expect.soft(saved.savedSlug).toBe(fixture.slug);
				expect
					.soft(
						saved.projects.find((project) => project.slug === fixture.slug)
							?.unavailableReason,
					)
					.toBeUndefined();
			}
			const inspect = async () => {
				const projects = (
					await browserCall(port, (client) => client.GetProjects({}))
				).projects;
				const listed = await browserCall(port, (client) =>
					client.ListDaemonSessions({}),
				);
				const histories = await Promise.all(
					fixtures.map((fixture) => readHistory(port, fixture.id)),
				);
				const state = fixtures.map((fixture, index) => ({
					id: index + 1,
					title:
						listed.sessions.find((session) => session.id === fixture.id)
							?.title ?? null,
					messageCount: histories[index]?.messages.length ?? 0,
					eventCount:
						eventCounts(daemonStorePath(configDir), fixture.slug)[0]?.count ??
						0,
					available:
						listed.availability.find(
							(project) => project.projectSlug === fixture.slug,
						)?.available ?? false,
					reason:
						projects.find((project) => project.slug === fixture.slug)
							?.unavailableReason ?? null,
				}));
				expect.soft(listed.sessions).toHaveLength(2);
				for (const [index, fixture] of fixtures.entries()) {
					expect.soft(histories[index]?.error).toBeNull();
					expect
						.soft(
							histories[index]?.messages.map((message) => ({
								role: message.role,
								text: message.parts?.map((part) => part.text ?? "").join(""),
							})),
						)
						.toEqual(
							expect.arrayContaining([
								{ role: "user", text: "Legacy prompt" },
								{ role: "assistant", text: "Legacy reply" },
							]),
						);
					expect.soft(state[index]).toEqual({
						id: index + 1,
						title: fixture.title,
						messageCount: 2,
						eventCount: 9,
						available: true,
						reason: null,
					});
				}
				return state;
			};
			stages["beforeRestart"] = await inspect();
			await daemon.stop();
			daemon = await startForegroundDaemon(options);
			port = daemon.getStatus().port;
			stages["afterRestart"] = await inspect();
			expect.soft(stages["afterRestart"]).toEqual(stages["beforeRestart"]);
		} finally {
			await daemon?.stop();
			evidence["twoProjectsBeforeRelay"] = stages;
			writeImportArtifact("test-results/82tn28-runtime-import.json", evidence);
			rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	it("archives leftover legacy sidecars before registering a prepared project store", async () => {
		const root = realpathSync(
			mkdtempSync(join(tmpdir(), "conduit-runtime-sidecars-")),
		);
		const configDir = join(root, "config");
		const folder = join(root, "sidecar-history");
		const legacy = join(folder, ".conduit", "events.db");
		let daemon: Awaited<ReturnType<typeof startForegroundDaemon>> | undefined;
		try {
			daemon = await startForegroundDaemon({
				configDir,
				socketPath: join(root, "relay.sock"),
				port: 0,
				host: "127.0.0.1",
				keepAwake: false,
				smartDefault: false,
			});
			await createProjectStoreFixture(
				join(configDir, "projects"),
				"sidecar-history",
				{
					sessionId: "sidecar-session",
					transcript: {
						title: "Sidecar history",
						prompt: "Sidecar prompt",
						reply: "Sidecar reply",
					},
				},
			);
			mkdirSync(join(folder, ".conduit"), { recursive: true });
			writeProjectStorageOwner(configDir, "sidecar-history", folder);
			writeFileSync(`${legacy}-wal`, "leftover WAL");
			writeFileSync(`${legacy}-shm`, "leftover SHM");
			const port = daemon.getStatus().port;
			const saved = await browserCall(port, (client) =>
				client.SaveProject({ folders: [folder] }),
			);
			expect(saved.savedSlug).toBe("sidecar-history");
			const listed = await browserCall(port, (client) =>
				client.ListDaemonSessions({}),
			);
			expect(listed.sessions.map((session) => session.title)).toEqual([
				"Sidecar history",
			]);
			expect(listed.availability).toEqual([
				{ projectSlug: saved.savedSlug, available: true },
			]);
			expect(
				(await readHistory(port, "sidecar-session")).messages,
			).toHaveLength(2);
			for (const suffix of ["-wal", "-shm"]) {
				expect(existsSync(`${legacy}${suffix}`)).toBe(false);
				expect(existsSync(`${legacy}.migrated${suffix}`)).toBe(true);
			}
		} finally {
			await daemon?.stop();
			rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	it("waits for a live shared-store write transaction and reports importer failures", async () => {
		const root = realpathSync(
			mkdtempSync(join(tmpdir(), "conduit-runtime-lock-")),
		);
		const configDir = join(root, "config");
		const folder = join(root, "held-history");
		const legacy = join(folder, ".conduit", "events.db");
		mkdirSync(configDir);
		const runtime = ManagedRuntime.make(
			makeDaemonRpcTestLayer([], undefined, { configDir }).pipe(
				Layer.provide(
					Layer.succeed(DaemonStoreAvailability)(new Map<string, string>()),
				),
			),
		);
		const release = await Effect.runPromise(Deferred.make<void>());
		let writer: ReturnType<typeof runtime.runFork> | undefined;
		try {
			const store = await runtime.runPromise(PersistenceStore);
			const sql = Context.get(store, SqlClient.SqlClient);
			const handlers = await runtime.runPromise(DaemonWsRpcHandlersTag);
			const rpc = <A, E>(call: (client: Client) => Effect.Effect<A, E>) =>
				runtime.runPromise(
					Effect.scoped(
						Effect.gen(function* () {
							const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
								Effect.provide(
									makeRoutedWsRpcServerLayer(
										() => Effect.die("Unexpected relay routing"),
										handlers,
									),
								),
							);
							return yield* call(client);
						}),
					),
				);
			await createProjectStoreFixture(root, "held-history", {
				sourcePath: legacy,
				sessionId: "held-history-session",
				transcript: {
					title: "History behind a live transaction",
					prompt: "Held prompt",
					reply: "Held reply",
				},
			});
			const acquired = await Effect.runPromise(Deferred.make<void>());
			writer = runtime.runFork(
				sql.withTransaction(
					Effect.gen(function* () {
						// An actual SQLite write lock, held while the registration starts.
						yield* sql`UPDATE store_identity SET value = value WHERE id = 1`;
						yield* Deferred.succeed(acquired, undefined);
						yield* Deferred.await(release);
					}),
				),
			);
			await Effect.runPromise(Deferred.await(acquired));
			let savedWhileLocked = false;
			const saving = rpc((client) =>
				client.SaveProject({ folders: [folder] }),
			).then((result) => {
				savedWhileLocked = true;
				return result;
			});
			try {
				// Migration can finish while the shared-store writer still owns its lock.
				await vi.waitFor(
					() => expect(existsSync(`${legacy}.migrated`)).toBe(true),
					{ timeout: 10_000 },
				);
				// Keep the writer held after preparation while registration waits for it.
				await new Promise<void>((resolve) => setTimeout(resolve, 100));
				expect(savedWhileLocked).toBe(false);
			} finally {
				await Effect.runPromise(Deferred.succeed(release, undefined));
			}
			await Effect.runPromise(Fiber.join(writer));
			const saved = await saving;
			expect(saved.savedSlug).toBe("held-history");
			const listed = await rpc((client) => client.ListDaemonSessions({}));
			expect(listed.sessions.map((session) => session.title)).toEqual([
				"History behind a live transaction",
			]);
			expect(listed.availability).toEqual([
				{ projectSlug: saved.savedSlug, available: true },
			]);
			const messages = await Effect.runPromise(
				Effect.flatMap(ReadQueryEffectTag, (read) =>
					read.getSessionMessagesWithParts("held-history-session"),
				).pipe(
					Effect.provide(
						makePersistenceProjectLayer("held-history").pipe(
							Layer.provide(Layer.succeedContext(store)),
						),
					),
				),
			);
			expect(
				messages
					.map((message) => message.parts.map((part) => part.text).join(""))
					.sort(),
			).toEqual(["Held prompt", "Held reply"]);

			const corruptFolder = join(root, "corrupt-import");
			const corruptStorage = join(configDir, "projects", "corrupt-import");
			mkdirSync(corruptFolder);
			mkdirSync(corruptStorage, { recursive: true });
			writeProjectStorageOwner(configDir, "corrupt-import", corruptFolder);
			const corruptSource = join(corruptStorage, "events.db");
			writeFileSync(corruptSource, "not SQLite");
			const corrupt = await rpc((client) =>
				client.SaveProject({ folders: [corruptFolder] }),
			);
			expect(
				corrupt.projects.find((project) => project.slug === corrupt.savedSlug)
					?.unavailableReason,
			).toBe("History import failed (corrupt)");
			const surviving = await rpc((client) => client.ListDaemonSessions({}));
			expect(surviving.sessions).toHaveLength(1);
			expect(surviving.availability).toContainEqual({
				projectSlug: corrupt.savedSlug,
				available: false,
				error: "History import failed (corrupt)",
			});
			expect(existsSync(corruptSource)).toBe(true);
		} finally {
			await Effect.runPromise(Deferred.succeed(release, undefined));
			if (writer) await Effect.runPromise(Fiber.interrupt(writer));
			await runtime.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	it("imports concurrent project saves while another project streams a turn", async () => {
		const harness = await ProcessHarness.start({ restartProof: true });
		try {
			const browser = await harness.connect();
			const currentSession = await browser.createSession(
				"Turn during history import",
			);
			const folders = ["concurrent-a", "concurrent-b"].map((slug) =>
				join(harness.root, slug),
			);
			for (const [index, folder] of folders.entries()) {
				await createProjectStoreFixture(harness.root, basename(folder), {
					sourcePath: join(folder, ".conduit", "events.db"),
					sessionId: `concurrent-session-${index}`,
					transcript: {
						title: `Concurrent history ${index}`,
						prompt: "Imported prompt",
						reply: "Imported reply",
					},
				});
			}
			const pendingTurn = browser.send(currentSession, "upgrade-long-turn");
			void pendingTurn.catch(() => undefined);
			let savedSlugs: string[] = [];
			try {
				await browser.waitFor(
					(message) =>
						message["type"] === "transcript_message" &&
						message["role"] === "assistant" &&
						message["sessionId"] === currentSession,
				);
				await expect
					.poll(
						async () => {
							const busy = await Effect.runPromise(
								browser.rpc.ListDaemonSessions({}),
							);
							return busy.sessions.find(
								(session) => session.id === currentSession,
							)?.status;
						},
						{ timeout: 10_000 },
					)
					.toBe("busy");
				const saved = await Promise.all(
					folders.map((folder) =>
						Effect.runPromise(browser.rpc.SaveProject({ folders: [folder] })),
					),
				);
				savedSlugs = saved.map((project) => project.savedSlug);
			} finally {
				writeFileSync(join(harness.root, "release-upgrade-turn"), "release");
			}
			const turn = await pendingTurn;
			expect(turn.done["status"]).toBe("idle");
			expect(savedSlugs.sort()).toEqual(["concurrent-a", "concurrent-b"]);
			const listed = await Effect.runPromise(
				browser.rpc.ListDaemonSessions({}),
			);
			expect(listed.sessions.map((session) => session.title).sort()).toEqual([
				"Concurrent history 0",
				"Concurrent history 1",
				"Turn during history import",
			]);
			expect(
				(await browser.history(currentSession)).map((message) => message.role),
			).toEqual(["user", "assistant"]);
			for (const index of [0, 1]) {
				const history = await Effect.runPromise(
					browser.rpc.LoadMoreHistory({
						sessionId: `concurrent-session-${index}`,
					}),
				);
				expect(history.messages).toHaveLength(2);
			}
		} finally {
			await harness.dispose();
		}
	}, 60_000);
});
