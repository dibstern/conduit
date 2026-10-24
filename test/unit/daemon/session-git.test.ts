// Failure modes: refreshes block published reads; hints multiply git reads;
// aliases split one checkout; secondary folders escape publication versions;
// run end is delayed by the normal interval; missing worktrees stay missing;
// closing an owner retains its probes; list reads start subprocesses.
// Index rewrites and probe bursts escape the hint throttle or lose their
// trailing state; listed folders never recover unprobed changes;
// nested branch refs, HEAD retargets and sibling merges go unnoticed;
// releasing many directories blocks or leaves an in-flight probe alive;
// published reads repeat canonicalization syscalls or retain stale aliases.
import { execFileSync } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import fs, {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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
import { expect, vi } from "vitest";
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
import {
	Subprocess,
	type SubprocessMetrics,
} from "../../../src/lib/domain/daemon/Services/subprocess.js";
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
import {
	canonicalDirectory,
	readPublishedSessionGit,
	withPublishedProjectGit,
} from "../../../src/lib/persistence/effect/session-git-publication.js";
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
		writeFileSync(join(repository, "tracked"), "initial");
		gitCommand(repository, "add", "tracked");
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

const waitForIdle = (
	metrics: Effect.Effect<SubprocessMetrics>,
	quietMs = 100,
) =>
	Effect.tryPromise(() => {
		let previous = -1;
		let idleSince = Date.now();
		return expect
			.poll(
				() => {
					const current = Effect.runSync(metrics);
					if (
						current.active + current.queued > 0 ||
						current.spawnCount !== previous
					)
						idleSince = Date.now();
					previous = current.spawnCount;
					return (
						current.active + current.queued === 0 &&
						Date.now() - idleSince >= quietMs
					);
				},
				{ timeout: eventTimeout, interval: 100 },
			)
			.toBe(true);
	});

// A dirty refresh runs status, then a diff for its line totals.
const dirtyRefresh = 2;

// A due read does async filesystem checks before it spawns git, which can
// outlast waitForIdle's quiet window under load. Wait for the spawn itself.
const waitForSpawns = (
	metrics: Effect.Effect<SubprocessMetrics>,
	count: number,
) =>
	Effect.tryPromise(() =>
		expect
			.poll(() => Effect.runSync(metrics).spawnCount, {
				timeout: eventTimeout,
			})
			.toBe(count),
	).pipe(Effect.andThen(waitForIdle(metrics)));

// A read's cadence runs from when git answered, which under load can trail its
// last spawn past an idle window: wait for its publication before moving time.
const waitForDirty = <E, R>(
	read: Effect.Effect<{ readonly dirty?: boolean } | undefined, E, R>,
) =>
	read.pipe(
		Effect.tap(() =>
			Effect.promise(
				() => new Promise<void>((resolve) => setTimeout(resolve, 50)),
			),
		),
		Effect.repeat({
			until: (git) => git?.dirty === true,
			times: eventTimeout / 50,
		}),
	);

// Real subprocesses and asynchronous filesystem operations can lag under load.
const eventTimeout = 20_000;

describe("daemon session git", { timeout: 60_000 }, () => {
	it.effect("leaves a dormant probed repository idle without spawns", () =>
		Effect.gen(function* () {
			const f = yield* fixture();
			yield* f.service.read("one");
			yield* settle;
			yield* waitForIdle(f.metrics);
			const before = yield* f.metrics;
			yield* TestClock.adjust(20_000);
			yield* settle;
			expect((yield* f.metrics).spawnCount).toBe(before.spawnCount);
		}),
	);
	it.effect(
		"throttles probe hints with a leading and trailing publication",
		() =>
			Effect.gen(function* () {
				const f = yield* fixture();
				const originalStat = fsPromises.stat;
				const lastTarget = join(
					canonicalDirectory(f.repository),
					".git",
					"refs/heads/master",
				);
				let completedProbes = 0;
				const stat = vi
					.spyOn(fsPromises, "stat")
					.mockImplementation(async (path, options) => {
						try {
							return await originalStat(path, options);
						} finally {
							if (String(path) === lastTarget) completedProbes++;
						}
					});
				syncBuiltinESMExports();
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						stat.mockRestore();
						syncBuiltinESMExports();
					}),
				);
				yield* f.service.read("one");
				const initialTargets = completedProbes;
				yield* settle;
				// Finish the initial clean probe before changing its index baseline.
				yield* Effect.tryPromise(() =>
					expect
						.poll(() => completedProbes, { timeout: eventTimeout })
						.toBe(initialTargets + 1),
				);
				const before = yield* f.metrics;
				const dirty = join(f.repository, "dirty");
				const index = fs.readFileSync(join(f.repository, ".git", "index"));
				writeFileSync(dirty, "changed");
				gitCommand(f.repository, "add", "dirty");
				yield* TestClock.adjust(10_000);
				// Native stats must finish before the scheduler consumes their hint.
				yield* Effect.tryPromise(() =>
					expect
						.poll(() => completedProbes, { timeout: eventTimeout })
						.toBe(initialTargets + 2),
				);
				yield* settle;
				yield* waitForSpawns(f.metrics, before.spawnCount + dirtyRefresh);
				expect(yield* waitForDirty(f.service.read("one"))).toMatchObject({
					dirty: true,
				});
				const cleaned = yield* f.service.changes.pipe(
					Stream.take(1),
					Stream.runCollect,
					Effect.forkChild({ startImmediately: true }),
				);
				writeFileSync(join(f.repository, ".git", "index"), index);
				rmSync(dirty);
				for (let index = 0; index < 30; index++)
					yield* f.service.invalidate({ directory: f.repository });
				yield* TestClock.adjust(1_000);
				yield* settle;
				expect((yield* f.metrics).spawnCount - before.spawnCount).toBe(
					dirtyRefresh,
				);
				yield* f.service.invalidate({ directory: f.repository });
				yield* TestClock.adjust(1_000);
				yield* settle;
				yield* waitForSpawns(f.metrics, before.spawnCount + dirtyRefresh + 1);
				yield* Fiber.join(cleaned);
				expect(yield* f.service.read("one")).toMatchObject({ dirty: false });
			}),
	);
	it.effect(
		"refreshes hinted viewed sessions after two seconds, before five",
		() =>
			Effect.gen(function* () {
				const f = yield* fixture();
				mkdirSync(join(f.repository, "nested"));
				yield* f.service.read("one");
				f.activity.viewers.set("one", 1);
				f.activity.changed("one");
				yield* settle;
				const before = (yield* f.metrics).spawnCount;
				writeFileSync(join(f.repository, "nested", "dirty"), "changed");
				yield* f.service.invalidate({ sessionId: "one" });
				// Invalidating only marks pending work, even for a viewed session.
				expect((yield* f.metrics).spawnCount).toBe(before);
				yield* settle;
				yield* waitForSpawns(f.metrics, before + dirtyRefresh);
				writeFileSync(join(f.repository, "nested", "dirty"), "trailing");
				yield* f.service.invalidate({ sessionId: "one" });
				yield* TestClock.adjust(1_500);
				yield* settle;
				expect((yield* f.metrics).spawnCount).toBe(before + dirtyRefresh);
				yield* TestClock.adjust(500);
				yield* settle;
				yield* waitForSpawns(f.metrics, before + 2 * dirtyRefresh);
			}),
	);
	it.effect("ignores stat-only changes to HEAD, packed and loose refs", () =>
		Effect.gen(function* () {
			const f = yield* fixture();
			writeFileSync(
				join(f.repository, ".git", "packed-refs"),
				"# pack-refs with: peeled fully-peeled sorted\n",
			);
			yield* f.service.read("one");
			yield* settle;
			const before = (yield* f.metrics).spawnCount;
			for (const path of ["HEAD", "packed-refs", "refs/heads/main"])
				fs.utimesSync(join(f.repository, ".git", path), new Date(), new Date());
			yield* TestClock.adjust(10_000);
			yield* settle;
			yield* waitForIdle(f.metrics);
			expect((yield* f.metrics).spawnCount).toBe(before);
		}),
	);
	it.effect(
		"notices nested branch commits, HEAD retargets and sibling merges",
		() =>
			Effect.gen(function* () {
				const f = yield* fixture(false, true);
				// Switch branches between capturing HEAD and finishing target discovery.
				// The branch target and the HEAD baseline must use the same snapshot.
				const originalReadFile = fsPromises.readFile;
				let switched = false;
				const readFile = vi
					.spyOn(fsPromises, "readFile")
					.mockImplementation(async (path, options) => {
						const contents = await originalReadFile(path, options);
						if (
							!switched &&
							String(path).includes("/worktrees/") &&
							String(path).endsWith("/HEAD")
						) {
							gitCommand(f.workspaceDirectory, "branch", "-m", "wt/foo");
							switched = true;
						}
						return contents;
					});
				syncBuiltinESMExports();
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						readFile.mockRestore();
						syncBuiltinESMExports();
					}),
				);
				yield* f.service.read("one");
				expect(switched).toBe(true);
				yield* settle;
				yield* TestClock.adjust(10_000);
				const renamed = yield* settle.pipe(
					Effect.andThen(f.service.read("one")),
					Effect.repeat({
						until: (state) => state?.branch === "wt/foo",
						times: 20,
					}),
				);
				expect(renamed).toMatchObject({
					branch: "wt/foo",
				});
				for (const directory of [f.workspaceDirectory, f.repository]) {
					const before = (yield* f.service.read("one"))?.head;
					gitCommand(
						directory,
						"-c",
						"user.email=test@example.com",
						"-c",
						"user.name=Test",
						"commit",
						"--allow-empty",
						"-m",
						"ref moved",
					);
					if (directory === f.repository)
						gitCommand(
							f.repository,
							"-c",
							"user.email=test@example.com",
							"-c",
							"user.name=Test",
							"merge",
							"--no-edit",
							"wt/foo",
						);
					yield* TestClock.adjust(10_000);
					const state = yield* settle.pipe(
						Effect.andThen(f.service.read("one")),
						Effect.repeat({
							until: (state) =>
								directory === f.workspaceDirectory
									? state?.head !== before
									: state?.merged === true,
							times: 20,
						}),
					);
					if (directory === f.workspaceDirectory)
						expect(state?.head).not.toBe(before);
					else expect(state).toMatchObject({ merged: true });
				}
			}),
	);
	it.effect(
		"releases many directories promptly and cancels an in-flight probe",
		() =>
			Effect.gen(function* () {
				const f = yield* fixture();
				yield* f.service.read("one");
				const folders = Array.from({ length: 32 }, (_, index) =>
					join(f.root, `folder-${index}`),
				);
				for (const folder of folders) mkdirSync(folder);
				const stat = vi.spyOn(fsPromises, "stat");
				syncBuiltinESMExports();
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						stat.mockRestore();
						syncBuiltinESMExports();
					}),
				);
				yield* Ref.update(f.projects, (projects) =>
					HashMap.set(projects, "project", {
						_tag: "Ready",
						project: {
							slug: "project",
							title: "Project",
							folders: [f.repository, ...folders],
						},
					}),
				);
				yield* settle;
				yield* Effect.tryPromise(() =>
					expect
						.poll(
							() =>
								folders.every((folder) =>
									stat.mock.calls.some(
										([path]) => String(path) === canonicalDirectory(folder),
									),
								),
							{ timeout: eventTimeout },
						)
						.toBe(true),
				);
				// A native stat cannot be cancelled, but release must detach its continuation.
				stat.mockImplementationOnce(() => new Promise(() => {}));
				const prior = stat.mock.calls.length;
				yield* TestClock.adjust(10_000);
				yield* settle;
				expect(stat.mock.calls.length).toBeGreaterThan(prior);
				const started = performance.now();
				yield* f.owners.close(
					{ kind: "project", projectId: "project" },
					"remove",
				);
				expect(performance.now() - started).toBeLessThan(500);
				const probes = stat.mock.calls.length;
				const spawns = (yield* f.metrics).spawnCount;
				yield* TestClock.adjust(60_000);
				yield* settle;
				expect(stat.mock.calls.length).toBe(probes);
				expect((yield* f.metrics).spawnCount).toBe(spawns);
				expect(yield* f.metrics).toMatchObject({ active: 0, queued: 0 });
			}),
	);
	it.effect("reads warm publications without canonicalization syscalls", () =>
		Effect.gen(function* () {
			const f = yield* fixture();
			yield* f.service.read("one");
			yield* f.service.read("shared");
			const spies = [
				vi.spyOn(fs, "realpathSync"),
				vi.spyOn(fs, "lstatSync"),
				vi.spyOn(fs, "readlinkSync"),
			];
			syncBuiltinESMExports();
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					for (const spy of spies) spy.mockRestore();
					syncBuiltinESMExports();
				}),
			);
			for (let index = 0; index < 10; index++) {
				expect(
					yield* readPublishedSessionGit("shared").pipe(
						Effect.provideService(SqlClient.SqlClient, f.sql),
						Effect.provideService(ProjectRegistryTag, f.projects),
					),
				).toMatchObject({ branch: "main" });
				expect(
					(yield* withPublishedProjectGit([
						{ slug: "project", title: "Project", folders: [f.repository] },
					]).pipe(Effect.provideService(SqlClient.SqlClient, f.sql)))[0]?.git,
				).toMatchObject({ branch: "main" });
			}
			for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		}),
	);
	it.effect(
		"canonicalizes missing children and dangling symlinks on first use",
		() =>
			Effect.gen(function* () {
				const f = yield* fixture();
				const missing = join(
					canonicalDirectory(f.repository),
					"missing",
					"child",
				);
				expect(canonicalDirectory(join(f.alias, "missing", "child"))).toBe(
					missing,
				);
				const dangling = join(f.root, "dangling");
				symlinkSync(missing, dangling, "dir");
				expect(canonicalDirectory(dangling)).toBe(missing);
			}),
	);
	it.effect(
		"refreshes listed directories after an unprobed nested file changes",
		() =>
			Effect.gen(function* () {
				const f = yield* fixture();
				mkdirSync(join(f.repository, "nested"));
				yield* f.service.read("one");
				yield* settle;
				yield* withReadRequest(f.service.read("one"), "ListSessions");
				yield* TestClock.adjust(300);
				yield* settle;
				const before = (yield* f.metrics).spawnCount;
				// Neither the index nor the checkout directory's stat changes.
				writeFileSync(join(f.repository, "nested", "dirty"), "missed");
				yield* TestClock.adjust(29_000);
				yield* settle;
				expect((yield* f.metrics).spawnCount).toBe(before);
				yield* TestClock.adjust(1_000);
				yield* settle;
				yield* waitForSpawns(f.metrics, before + dirtyRefresh);
				expect(yield* f.service.read("one")).toMatchObject({ dirty: true });
			}),
	);
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
				// The refresh can take longer than one settle under load.
				yield* settle.pipe(
					Effect.andThen(f.service.read("one")),
					Effect.repeat({ until: (git) => git?.dirty === true, times: 200 }),
				);
				yield* waitForIdle(f.metrics);
				expect(yield* f.service.read("one")).toMatchObject({ dirty: true });
				expect((yield* f.metrics).spawnCount - before.spawnCount).toBe(
					dirtyRefresh,
				);
			}),
	);
	it.effect("never spawns on unknown or warm RPC list reads", () =>
		Effect.gen(function* () {
			const f = yield* fixture();
			yield* waitForIdle(f.metrics);
			const before = yield* f.metrics;
			expect(
				yield* withReadRequest(f.service.read("one"), "ListSessions"),
			).toBeUndefined();
			expect((yield* f.metrics).spawnCount - before.spawnCount).toBe(0);
			yield* f.service.read("one");
			yield* TestClock.adjust(2_100);
			yield* settle;
			yield* waitForIdle(f.metrics);
			const warm = yield* f.metrics;
			yield* withReadRequest(f.service.read("shared"), "SubscribeShell");
			expect((yield* f.metrics).spawnCount - warm.spawnCount).toBe(0);
			yield* TestClock.adjust(300);
			yield* settle;
			yield* waitForIdle(f.metrics);

			// Keep a stale directory read in flight while a second RPC asks for it.
			// The slot is held by a real process; git and the owner stay unmodified.
			const blocker = yield* f.owner
				.run(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
					timeoutMs: 30_000,
				})
				.pipe(Effect.forkScoped);
			yield* Effect.tryPromise(() =>
				expect
					.poll(() => Effect.runSync(f.metrics).active, {
						timeout: eventTimeout,
					})
					.toBe(1),
			);
			// Hold the slot before the listed poll becomes due.
			yield* TestClock.adjust(30_000);
			yield* Effect.tryPromise(() =>
				expect
					.poll(() => Effect.runSync(f.metrics).queued, {
						timeout: eventTimeout,
					})
					.toBe(1),
			);
			const queued = yield* f.metrics;
			yield* withReadRequest(f.service.read("one"), "ListSessions");
			yield* withReadRequest(f.service.read("shared"), "SubscribeShell");
			expect((yield* f.metrics).spawnCount).toBe(queued.spawnCount);
			yield* TestClock.adjust(300);
			writeFileSync(join(f.repository, "dirty"), "changed");
			yield* Fiber.interrupt(blocker);
			yield* waitForDirty(f.service.read("one"));
			yield* waitForIdle(f.metrics);
			yield* settle;
			yield* waitForIdle(f.metrics);
			const completed = (yield* f.metrics).spawnCount;
			yield* TestClock.adjust(29_000);
			yield* settle;
			expect((yield* f.metrics).spawnCount).toBe(completed);
			yield* TestClock.adjust(1_000);
			yield* settle;
			yield* waitForSpawns(f.metrics, completed + dirtyRefresh);
		}),
	);
	for (const hintFirst of [true, false])
		it.effect(
			`preserves directory invalidation and listed cadence while queued (${hintFirst ? "hint first" : "list first"})`,
			() =>
				Effect.gen(function* () {
					const f = yield* fixture();
					yield* f.service.read("one");
					yield* TestClock.adjust(2_100);
					yield* settle;
					yield* waitForIdle(f.metrics);
					const blocker = yield* f.owner
						.run(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
							timeoutMs: 30_000,
						})
						.pipe(Effect.forkScoped);
					yield* Effect.tryPromise(() =>
						expect
							.poll(() => Effect.runSync(f.metrics).active, {
								timeout: eventTimeout,
							})
							.toBe(1),
					);
					yield* f.service.invalidate({ directory: f.repository });
					yield* TestClock.adjust(100);
					yield* Effect.tryPromise(() =>
						expect
							.poll(() => Effect.runSync(f.metrics).queued, {
								timeout: eventTimeout,
							})
							.toBe(1),
					);
					const hint = f.service.invalidate({ directory: f.repository });
					const listed = withReadRequest(hint, "GetProjects");
					yield* hintFirst ? hint : listed;
					yield* hintFirst ? listed : hint;
					yield* TestClock.adjust(300);
					writeFileSync(join(f.repository, "dirty"), "changed");
					yield* Fiber.interrupt(blocker);
					yield* waitForDirty(f.service.read("one"));
					yield* waitForIdle(f.metrics);
					yield* settle;
					yield* waitForIdle(f.metrics);
					const completed = (yield* f.metrics).spawnCount;
					yield* TestClock.adjust(29_000);
					yield* settle;
					expect((yield* f.metrics).spawnCount).toBe(completed);
					yield* withReadRequest(
						f.service.invalidate({ directory: f.repository }),
						"GetProjects",
					);
					yield* TestClock.adjust(1_000);
					yield* settle;
					yield* waitForSpawns(f.metrics, completed + dirtyRefresh);
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
				yield* TestClock.adjust(2_100);
				yield* settle;
				yield* waitForIdle(f.metrics);
				const dormant = (yield* f.metrics).spawnCount;
				yield* TestClock.adjust(60_000);
				yield* settle;
				expect((yield* f.metrics).spawnCount).toBe(dormant);
				yield* withReadRequest(f.service.read("one"), "ListSessions");
				yield* TestClock.adjust(300);
				yield* settle;
				yield* waitForIdle(f.metrics);
				const leading = (yield* f.metrics).spawnCount;
				yield* TestClock.adjust(29_000);
				yield* settle;
				expect((yield* f.metrics).spawnCount).toBe(leading);
				yield* TestClock.adjust(1_000);
				yield* settle;
				yield* waitForSpawns(f.metrics, leading + 1);
				expect(yield* f.service.read("one")).toMatchObject({ dirty: false });
				f.activity.viewers.set("one", 1);
				f.activity.changed("one");
				yield* settle;
				yield* waitForIdle(f.metrics);
				const viewed = (yield* f.metrics).spawnCount;
				yield* TestClock.adjust(5_000);
				yield* settle;
				yield* waitForSpawns(f.metrics, viewed + 1);
				f.activity.viewers.delete("one");
				f.activity.changed("one");
				yield* f.commit([
					canonicalEvent("session.status", "one", {
						sessionId: "one",
						status: "busy",
					}),
				]);
				yield* settle;
				yield* waitForIdle(f.metrics);
				const running = (yield* f.metrics).spawnCount;
				yield* TestClock.adjust(14_000);
				expect((yield* f.metrics).spawnCount).toBe(running);
				yield* TestClock.adjust(1_000);
				yield* settle;
				yield* waitForSpawns(f.metrics, running + 1);
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
				yield* waitForIdle(f.metrics);
				yield* Effect.tryPromise(() =>
					expect
						.poll(() => Effect.runPromise(f.service.read("one")), {
							timeout: eventTimeout,
						})
						.toMatchObject({ dirty: true }),
				);
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
				const readMissing = f.sql<{
					workspace_missing: string | null;
				}>`SELECT workspace_missing FROM session_git_published WHERE workspace_missing IS NOT NULL`.pipe(
					Effect.map((rows) => rows[0]),
				);
				yield* TestClock.adjust(10_000);
				// Read SQL directly so a service read cannot discover the presence flip.
				const missing = yield* settle.pipe(
					Effect.andThen(readMissing),
					Effect.repeat({ until: (row) => row !== undefined, times: 200 }),
				);
				expect(yield* f.service.read("one")).toBeUndefined();
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
				yield* TestClock.adjust(10_000);
				yield* settle.pipe(
					Effect.andThen(readMissing),
					Effect.repeat({ until: (row) => row === undefined, times: 200 }),
				);
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
	);
});
