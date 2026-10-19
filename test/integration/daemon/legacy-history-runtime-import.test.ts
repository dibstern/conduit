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
import {
	makePersistenceProjectLayer,
	PersistenceStore,
} from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
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

describe("legacy history added after daemon startup", () => {
	const evidence: Record<string, unknown> = {};

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
