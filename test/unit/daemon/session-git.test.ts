// Failure modes: refreshes block published reads; hints multiply git reads;
// aliases split one checkout; secondary folders escape publication versions;
// run end is delayed by the normal interval; missing worktrees stay missing;
// closing an owner retains its timer/watch; list reads start subprocesses.
import { execFileSync } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import {
	Context,
	Effect,
	Fiber,
	HashMap,
	Layer,
	Option,
	Ref,
	Schema,
	Stream,
} from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { OwnerScopesLive } from "../../../src/lib/domain/daemon/Layers/owner-scopes-layer.js";
import { makeSubprocessLive } from "../../../src/lib/domain/daemon/Layers/subprocess-layer.js";
import { makeWorktreeLive } from "../../../src/lib/domain/daemon/Layers/worktree-layer.js";
import { OwnerScopes } from "../../../src/lib/domain/daemon/Services/owner-scopes.js";
import {
	makeProjectRegistryLive,
	ProjectRegistryTag,
} from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { withReadRequest } from "../../../src/lib/domain/daemon/Services/read-request.js";
import {
	makeSessionActivity,
	SessionActivityTag,
} from "../../../src/lib/domain/daemon/Services/session-activity.js";
import { makeSharedSessionDirectoryLive } from "../../../src/lib/domain/daemon/Services/session-directory.js";
import {
	SessionGit,
	SessionGitLive,
} from "../../../src/lib/domain/daemon/Services/session-git.js";
import { Subprocess } from "../../../src/lib/domain/daemon/Services/subprocess.js";
import { WorktreeServiceTag } from "../../../src/lib/domain/daemon/Services/worktree-service.js";
import {
	makeSessionEventBusLive,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import {
	makeCommitAndSignal,
	makeUnboundCommitAndSignal,
} from "../../../src/lib/persistence/effect/commit-and-signal.js";
import {
	makeUnboundEventStoreEffect,
	UnboundEventStoreEffectTag,
} from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalDirectory } from "../../../src/lib/persistence/effect/session-git-publication.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";

const gitCommand = (directory: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd: directory,
		encoding: "utf8",
		stdio: "pipe",
	});

const fixture = (extraFolders = false, linked = false) =>
	Effect.gen(function* () {
		const root = yield* Effect.acquireRelease(
			Effect.sync(() => mkdtempSync(join(tmpdir(), "conduit-session-git-"))),
			(path) =>
				Effect.sync(() => rmSync(path, { recursive: true, force: true })),
		);
		const repository = join(root, "repo");
		gitCommand(root, "init", "--initial-branch=main", repository);
		gitCommand(
			repository,
			"-c",
			"user.email=test@example.com",
			"-c",
			"user.name=Test",
			"commit",
			"--allow-empty",
			"-m",
			"initial",
		);
		const alias = join(root, "alias");
		symlinkSync(repository, alias, "dir");
		const second = join(root, "second");
		if (extraFolders) {
			gitCommand(root, "init", "--initial-branch=main", second);
			gitCommand(
				second,
				"-c",
				"user.email=test@example.com",
				"-c",
				"user.name=Test",
				"commit",
				"--allow-empty",
				"-m",
				"initial",
			);
		}
		const bus = makeSessionEventBusLive();
		const processLayer = makeSubprocessLive({ concurrency: 1 });
		const base = Layer.mergeAll(
			makePersistenceEffectLayer(
				join(root, "events.db"),
				"project",
				undefined,
				bus,
			),
			makeProjectRegistryLive([
				{
					slug: "project",
					title: "Project",
					folders: extraFolders ? [repository, second] : [repository],
				},
			]),
			makeWorktreeLive(join(root, "config")).pipe(
				Layer.provideMerge(processLayer),
			),
			Layer.effect(SessionActivityTag, makeSessionActivity),
			bus,
		);
		const unbound = Layer.effect(
			UnboundEventStoreEffectTag,
			makeUnboundEventStoreEffect,
		).pipe(Layer.provideMerge(base));
		const dependencies = OwnerScopesLive.pipe(
			Layer.provideMerge(
				makeSharedSessionDirectoryLive.pipe(Layer.provideMerge(unbound)),
			),
		);
		const context = yield* Layer.build(dependencies);
		const worktrees = Context.get(context, WorktreeServiceTag);
		const checkout = linked
			? yield* worktrees.create(
					[{ path: repository, projectSlug: "project", sessionId: "one" }],
					undefined,
					"session-one",
				)
			: undefined;
		const workspaceDirectory = checkout?.worktrees[repository] ?? repository;
		if (linked) {
			rmSync(alias);
			symlinkSync(workspaceDirectory, alias, "dir");
		}
		const commit = yield* makeCommitAndSignal.pipe(Effect.provide(context));
		const commitAll = yield* makeUnboundCommitAndSignal.pipe(
			Effect.provide(context),
		);
		for (const id of ["one", "shared"])
			yield* commit([
				canonicalEvent("session.created", id, {
					sessionId: id,
					title: id,
					provider: "claude",
				}),
				canonicalEvent("session.workspace_changed", id, {
					sessionId: id,
					cause: linked ? "launch" : "user",
					origin: linked ? "conduit" : "existing",
					worktrees: {
						[repository]: id === "shared" ? alias : workspaceDirectory,
					},
					...(checkout ? { ownership: checkout.ownership } : {}),
				}),
			]);
		const module = yield* Layer.build(
			SessionGitLive.pipe(Layer.provide(Layer.succeedContext(context))),
		);
		const service = Context.get(module, SessionGit);
		const owner = Context.get(context, Subprocess);
		const sql = Context.get(context, SqlClient.SqlClient);
		return {
			root,
			repository,
			workspaceDirectory,
			worktrees,
			second,
			alias,
			service,
			owner,
			commit,
			commitAll,
			projects: Context.get(context, ProjectRegistryTag),
			sql,
			owners: Context.get(context, OwnerScopes),
			activity: Context.get(context, SessionActivityTag),
			events: Context.get(context, SessionEventBusTag),
			metrics: owner.metrics,
			version: Effect.map(
				sql<{ version: number }>`SELECT version FROM sessions WHERE id = 'one'`,
				([row]) => row?.version ?? 0,
			),
		};
	});

const settle = Effect.gen(function* () {
	yield* TestClock.adjust(100);
	yield* Effect.tryPromise(
		() => new Promise<void>((resolve) => setTimeout(resolve, 100)),
	);
});

describe("daemon session git", () => {
	for (const projectFirst of [true, false])
		it.effect(
			`releases a former project root shared with another project's session (${projectFirst ? "project first" : "session first"})`,
			() =>
				Effect.gen(function* () {
					const f = yield* fixture(true);
					yield* f.commit([
						canonicalEvent("session.deleted", "one", { sessionId: "one" }),
						canonicalEvent("session.deleted", "shared", {
							sessionId: "shared",
						}),
					]);
					yield* Ref.update(f.projects, (projects) =>
						HashMap.set(projects, "other", {
							_tag: "Ready",
							project: { slug: "other", title: "Other", folders: [f.second] },
						}),
					);
					yield* f.commitAll(
						[
							canonicalEvent("session.created", "foreign", {
								sessionId: "foreign",
								title: "Foreign",
								provider: "claude",
							}),
							canonicalEvent("session.workspace_changed", "foreign", {
								sessionId: "foreign",
								cause: "user",
								origin: "existing",
								worktrees: { [f.second]: f.repository },
							}),
						],
						{ projectId: "other" },
					);
					expect(yield* f.service.read("foreign")).toMatchObject({
						branch: "main",
					});
					yield* settle;
					yield* settle;
					const removeProject = Effect.gen(function* () {
						yield* Ref.update(f.projects, HashMap.remove("project"));
						yield* f.owners.close(
							{ kind: "project", projectId: "project" },
							"remove",
						);
					});
					const removeSession = f.commitAll(
						[
							canonicalEvent("session.deleted", "foreign", {
								sessionId: "foreign",
							}),
						],
						{ projectId: "other" },
					);
					if (projectFirst) {
						yield* removeProject;
						yield* settle;
						yield* removeSession;
					} else {
						yield* removeSession;
						yield* settle;
						yield* removeProject;
					}
					yield* settle;
					const before = (yield* f.metrics).spawnCount;
					writeFileSync(join(f.repository, "after-release"), "changed");
					yield* f.service.invalidate({ directory: f.repository });
					yield* settle;
					expect((yield* f.metrics).spawnCount).toBe(before);
				}),
			{ timeout: 30_000 },
		);
	it.effect(
		"publishes the first unknown read and reuses one canonical folder across sessions",
		() =>
			Effect.gen(function* () {
				const f = yield* fixture();
				const before = yield* f.metrics;
				expect(yield* f.service.read("one")).toMatchObject({
					branch: "main",
					dirty: false,
				});
				const warm = yield* f.metrics;
				expect(warm.spawnCount).toBeGreaterThan(before.spawnCount);
				expect(yield* f.service.read("shared")).toMatchObject({
					branch: "main",
				});
				expect((yield* f.metrics).spawnCount).toBe(warm.spawnCount);
				expect(
					(yield* f.sql<{
						count: number;
					}>`SELECT COUNT(*) AS count FROM session_git_published`)[0]?.count,
				).toBe(1);
				yield* f.owners.close(
					{ kind: "project", projectId: "project" },
					"detach",
				);
				expect(yield* f.service.read("one")).toMatchObject({ branch: "main" });
				expect((yield* f.metrics).spawnCount).toBe(warm.spawnCount);
			}),
	);
	it.effect(
		"returns stale published state while coalescing a burst into one refresh",
		() =>
			Effect.gen(function* () {
				const f = yield* fixture();
				yield* f.service.read("one");
				const before = yield* f.metrics;
				writeFileSync(join(f.repository, "dirty"), "changed");
				yield* Effect.forEach(Array.from({ length: 30 }), () =>
					f.service.invalidate({ sessionId: "one" }),
				);
				expect(yield* f.service.read("one")).toMatchObject({ dirty: false });
				yield* settle;
				expect(yield* f.service.read("one")).toMatchObject({ dirty: true });
				expect((yield* f.metrics).spawnCount - before.spawnCount).toBe(1);
			}),
	);
	it.effect("never spawns on unknown or warm RPC list reads", () =>
		Effect.gen(function* () {
			const f = yield* fixture();
			const before = yield* f.metrics;
			expect(
				yield* withReadRequest(f.service.read("one"), "ListSessions"),
			).toBeUndefined();
			expect((yield* f.metrics).spawnCount - before.spawnCount).toBe(0);
			yield* f.service.read("one");
			const warm = yield* f.metrics;
			yield* withReadRequest(f.service.read("shared"), "SubscribeShell");
			expect((yield* f.metrics).spawnCount - warm.spawnCount).toBe(0);
			yield* TestClock.adjust(300);
			yield* settle;
			yield* TestClock.adjust(30_000);

			// Keep a stale directory read in flight while a second RPC asks for it.
			// The slot is held by a real process; git and the owner stay unmodified.
			const blocker = yield* f.owner
				.run(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
					timeoutMs: 30_000,
				})
				.pipe(Effect.forkScoped);
			yield* Effect.tryPromise(() =>
				expect.poll(() => Effect.runSync(f.metrics).active).toBe(1),
			);
			yield* withReadRequest(f.service.read("one"), "ListSessions");
			yield* TestClock.adjust(300);
			yield* Effect.tryPromise(() =>
				expect.poll(() => Effect.runSync(f.metrics).queued).toBe(1),
			);
			yield* withReadRequest(f.service.read("shared"), "SubscribeShell");
			yield* TestClock.adjust(300);
			yield* Fiber.interrupt(blocker);
			yield* Effect.tryPromise(() =>
				expect
					.poll(() => {
						const metrics = Effect.runSync(f.metrics);
						return metrics.active + metrics.queued;
					})
					.toBe(0),
			);
			yield* settle;
			const completed = (yield* f.metrics).spawnCount;
			yield* TestClock.adjust(30_000);
			yield* settle;
			expect((yield* f.metrics).spawnCount).toBe(completed);
		}),
	);
	for (const hintFirst of [true, false])
		it.effect(
			`preserves directory invalidation and listed cadence while queued (${hintFirst ? "hint first" : "list first"})`,
			() =>
				Effect.gen(function* () {
					const f = yield* fixture();
					yield* f.service.read("one");
					yield* settle;
					const blocker = yield* f.owner
						.run(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
							timeoutMs: 30_000,
						})
						.pipe(Effect.forkScoped);
					yield* Effect.tryPromise(() =>
						expect.poll(() => Effect.runSync(f.metrics).active).toBe(1),
					);
					yield* f.service.invalidate({ directory: f.repository });
					yield* TestClock.adjust(100);
					yield* Effect.tryPromise(() =>
						expect.poll(() => Effect.runSync(f.metrics).queued).toBe(1),
					);
					const hint = f.service.invalidate({ directory: f.repository });
					const listed = withReadRequest(hint, "GetProjects");
					yield* hintFirst ? hint : listed;
					yield* hintFirst ? listed : hint;
					yield* TestClock.adjust(300);
					yield* Fiber.interrupt(blocker);
					yield* Effect.tryPromise(() =>
						expect
							.poll(() => {
								const metrics = Effect.runSync(f.metrics);
								return metrics.active + metrics.queued;
							})
							.toBe(0),
					);
					yield* settle;
					const completed = (yield* f.metrics).spawnCount;
					yield* TestClock.adjust(29_000);
					yield* settle;
					expect((yield* f.metrics).spawnCount).toBe(completed);
					yield* TestClock.adjust(1_000);
					yield* settle;
					expect((yield* f.metrics).spawnCount).toBe(completed + 1);
				}),
		);
	it.effect("publishes secondary-folder changes with the session version", () =>
		Effect.gen(function* () {
			const f = yield* fixture(true);
			yield* f.service.read("one");
			const before = yield* f.version;
			writeFileSync(join(f.second, "dirty"), "changed");
			yield* f.service.invalidate({ directory: f.second });
			expect((yield* f.service.read("one"))?.folders?.[1]?.dirty).toBe(false);
			yield* settle;
			expect((yield* f.service.read("one"))?.folders?.[1]?.dirty).toBe(true);
			expect(yield* f.version).toBeGreaterThan(before);
		}),
	);
	it.effect(
		"publishes changes only after the corresponding version commits",
		() =>
			Effect.gen(function* () {
				const f = yield* fixture();
				yield* f.service.read("one");
				const changed = yield* f.service.changes.pipe(
					Stream.take(1),
					Stream.runCollect,
					Effect.forkChild,
				);
				const advances = yield* (yield* f.events.subscribeAdvances()).pipe(
					Stream.take(1),
					Stream.runCollect,
					Effect.forkChild,
				);
				yield* Effect.yieldNow;
				writeFileSync(join(f.repository, "dirty"), "changed");
				yield* f.service.invalidate({ sessionId: "one" });
				yield* settle;
				const updates = yield* Fiber.join(changed);
				expect(updates[0]?.sessionIds).toContain("one");
				expect(updates[0]?.version).toBe(yield* f.version);
				const committed = yield* Fiber.join(advances);
				expect(committed[0]?.version).toBe(updates[0]?.version);
				expect(committed[0]?.sessionIds).toContain("one");
				expect(committed[0]?.collections).toContain("sidebar");
				const [sidebar] = yield* f.sql<{
					version: number;
					rowVersion: number;
				}>`SELECT version, json_extract(row, '$.version') AS rowVersion FROM session_sidebar WHERE session_id = 'one'`;
				expect(sidebar?.version).toBe(updates[0]?.version);
				expect(sidebar?.rowVersion).toBe(updates[0]?.version);
				expect(yield* f.service.read("one")).toMatchObject({ dirty: true });
			}),
	);
	it.effect(
		"uses viewed and listed intervals and refreshes immediately when a run ends",
		() =>
			Effect.gen(function* () {
				const f = yield* fixture();
				yield* f.service.read("one");
				yield* settle;
				const dormant = (yield* f.metrics).spawnCount;
				yield* TestClock.adjust(60_000);
				yield* settle;
				expect((yield* f.metrics).spawnCount).toBe(dormant);
				yield* withReadRequest(f.service.read("one"), "ListSessions");
				yield* TestClock.adjust(300);
				yield* settle;
				const leading = (yield* f.metrics).spawnCount;
				yield* TestClock.adjust(29_000);
				expect((yield* f.metrics).spawnCount).toBe(leading);
				yield* TestClock.adjust(1_000);
				expect(yield* f.service.read("one")).toMatchObject({ dirty: false });
				yield* settle;
				expect((yield* f.metrics).spawnCount).toBe(leading + 1);
				f.activity.viewers.set("one", 1);
				f.activity.changed("one");
				yield* settle;
				const viewed = (yield* f.metrics).spawnCount;
				yield* TestClock.adjust(5_000);
				yield* settle;
				expect((yield* f.metrics).spawnCount).toBe(viewed + 1);
				f.activity.viewers.delete("one");
				f.activity.changed("one");
				yield* f.commit([
					canonicalEvent("session.status", "one", {
						sessionId: "one",
						status: "busy",
					}),
				]);
				yield* settle;
				const running = (yield* f.metrics).spawnCount;
				yield* TestClock.adjust(14_000);
				expect((yield* f.metrics).spawnCount).toBe(running);
				yield* TestClock.adjust(1_000);
				yield* settle;
				expect((yield* f.metrics).spawnCount).toBe(running + 1);
				writeFileSync(join(f.repository, "dirty"), "changed");
				yield* f.commit([
					canonicalEvent("session.status", "one", {
						sessionId: "one",
						status: "idle",
					}),
					canonicalEvent("turn.completed", "one", {
						messageId: "run",
					}),
				]);
				yield* settle;
				expect(yield* f.service.read("one")).toMatchObject({ dirty: true });
			}),
	);
	it.effect(
		"detects a missing directory and its recreation, then releases session resources",
		() =>
			Effect.gen(function* () {
				const f = yield* fixture(false, true);
				yield* f.service.read("one");
				yield* settle;
				rmSync(f.workspaceDirectory, { recursive: true, force: true });
				yield* f.service.invalidate({ sessionId: "one" });
				yield* settle;
				expect(yield* f.service.read("one")).toBeUndefined();
				const missing = (yield* f.sql<{
					workspace_missing: string | null;
				}>`SELECT workspace_missing FROM session_git_published WHERE workspace_missing IS NOT NULL`)[0];
				expect(JSON.parse(missing?.workspace_missing ?? "null")).toMatchObject({
					canRecreate: true,
				});
				const inspected = (yield* f.metrics).spawnCount;
				yield* f.service.invalidate({ sessionId: "one" });
				yield* settle;
				expect((yield* f.metrics).spawnCount).toBe(inspected);
				yield* f.worktrees.recreate(
					{ path: f.repository, projectSlug: "project", sessionId: "one" },
					f.workspaceDirectory,
					[f.repository],
				);
				yield* f.service.invalidate({ sessionId: "one" });
				yield* settle;
				expect(yield* f.service.read("one")).toMatchObject({
					branch: "session-one",
				});
				expect(
					(yield* f.sql<{
						count: number;
					}>`SELECT COUNT(*) AS count FROM session_git_published WHERE workspace_missing IS NOT NULL`)[0]
						?.count,
				).toBe(0);
				yield* f.commit([
					canonicalEvent("session.deleted", "one", { sessionId: "one" }),
					canonicalEvent("session.deleted", "shared", { sessionId: "shared" }),
				]);
				yield* settle;
				const afterClose: {
					readonly command: string;
					readonly args: readonly string[];
					readonly cwd: string;
				}[] = [];
				const decode = Schema.decodeUnknownOption(
					Schema.Struct({
						spawn: Schema.Struct({
							command: Schema.String,
							args: Schema.Array(Schema.String),
							cwd: Schema.String,
						}),
					}),
				);
				const metricsChannel = channel("conduit:subprocess-metrics");
				const observe = (message: unknown) => {
					const value = decode(message);
					if (Option.isSome(value)) afterClose.push(value.value.spawn);
				};
				metricsChannel.subscribe(observe);
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => metricsChannel.unsubscribe(observe)),
				);
				writeFileSync(join(f.workspaceDirectory, "after-close"), "changed");
				yield* f.service.invalidate({ sessionId: "one" });
				yield* TestClock.adjust(60_000);
				yield* settle;
				expect(
					afterClose.filter(
						({ cwd }) =>
							canonicalDirectory(cwd) ===
							canonicalDirectory(f.workspaceDirectory),
					),
					JSON.stringify(afterClose),
				).toEqual([]);
				yield* f.owners.close(
					{ kind: "project", projectId: "project" },
					"remove",
				);
				const closed = (yield* f.metrics).spawnCount;
				const projectClosedAt = afterClose.length;
				yield* TestClock.adjust(60_000);
				yield* settle;
				expect(
					(yield* f.metrics).spawnCount,
					JSON.stringify(afterClose.slice(projectClosedAt)),
				).toBe(closed);
			}),
		// Real Git recovery also runs beside the commit gate's build and typechecks.
		{ timeout: 30_000 },
	);
});
