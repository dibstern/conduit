/*
 * 82tn.10.6: the daemon owns each project's session manager state.
 * Failure catalogue entries covered (recorded on the 82tn.10.6 bead):
 * 12 two relays of one project delete the same session at once and both run
 *    the delete (the in-flight table lived in each relay);
 * 13 a relay rebuild drops the project's manager caches (parent map, side
 *    threads, session count) until the next list;
 * 14 removing a project leaves its manager state in the daemon, so a project
 *    added again under the same slug reads the old caches;
 *  1 one owner serving two projects mixes their state;
 * 15 a delete closes the session's scope before its row is gone or before
 *    its provider cleanup ran, so cleanup loses the resources it depends on;
 * 22 a session scope that cannot open for a reason other than a delete (an
 *    unregistered project, a directory read error) still lets the write land;
 * 23 each relay builds its own session manager, so the service a caller holds
 *    depends on which relay it came from and dies with that relay;
 * 24 a call naming one project runs against another project's store.
 */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodePath } from "@effect/platform-node";
import {
	Context,
	Effect,
	Exit,
	HashMap,
	Layer,
	ManagedRuntime,
	Option,
	Ref,
} from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makeDaemonLive } from "../../../src/lib/domain/daemon/Layers/daemon-layers.js";
import { makeDaemonConfigFromOptions } from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { OwnerScopes } from "../../../src/lib/domain/daemon/Services/owner-scopes.js";
import {
	addWithoutOpening,
	ProjectRegistryTag,
} from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import {
	type ProjectParts,
	ProjectServices,
} from "../../../src/lib/domain/daemon/Services/project-services.js";
import { SessionDirectory } from "../../../src/lib/domain/daemon/Services/session-directory.js";
import {
	type SessionManagerService,
	SessionManagerServiceTag,
} from "../../../src/lib/domain/project-services/Services/session-manager-service.js";
import { SessionManagerStateTag } from "../../../src/lib/domain/project-services/Services/session-manager-state.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { sdkDefaultClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { runnerDirectory } from "../../../src/lib/provider/runner/runner-registry.js";

/** A project opened in its generation, with the context its calls run in. */
interface Opened {
	readonly slug: string;
	readonly context: Context.Context<ProjectParts>;
}

const artifacts = join(process.cwd(), "test-results");
const evidence: {
	scenario?: string | undefined;
	observed: Record<string, unknown>;
} = {
	observed: {},
};
const cleanups: Array<() => Promise<void>> = [];

afterEach(async (context) => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	if (!evidence.scenario) return;
	mkdirSync(artifacts, { recursive: true });
	writeFileSync(
		join(artifacts, `82tn-10-6-owner-${evidence.scenario}.json`),
		`${JSON.stringify(
			{
				scenario: evidence.scenario,
				result: context.task.result?.state,
				failures: context.task.result?.errors?.map((error) => error.message),
				observed: evidence.observed,
			},
			null,
			2,
		)}\n`,
	);
	evidence.scenario = undefined;
	evidence.observed = {};
});

const start = async (scenario: string) => {
	evidence.scenario = scenario;
	const root = realpathSync(mkdtempSync(join(tmpdir(), "conduit-sm-owner-")));
	const projects = ["alpha", "beta"].map((slug) => {
		const folder = join(root, slug);
		mkdirSync(folder);
		execFileSync("git", ["init", "-q", "-b", "main", folder]);
		execFileSync("git", [
			"-C",
			folder,
			"-c",
			"user.name=Owner test",
			"-c",
			"user.email=owner@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"Initial",
		]);
		return { slug, title: slug, folders: [folder] as const, lastUsed: 1 };
	});
	const configDir = join(root, "config");
	mkdirSync(configDir);
	const daemon = ManagedRuntime.make(
		makeDaemonLive({
			configDir,
			socketPath: join(configDir, "relay.sock"),
			staticDir: root,
			launchLogin: sdkDefaultClaudeConfigDir(join(root, "home", ".claude")),
			initialConfig: makeDaemonConfigFromOptions({
				port: 0,
				host: "127.0.0.1",
				tlsEnabled: false,
				hostExplicit: true,
			}),
			smartDefault: false,
		}).pipe(Layer.provide(NodePath.layer)),
	);
	cleanups.push(async () => {
		await daemon.dispose();
		rmSync(root, { recursive: true, force: true });
	});
	const project = (slug: string) => {
		const found = projects.find((candidate) => candidate.slug === slug);
		if (!found) throw new Error(`No project ${slug}`);
		return found;
	};
	const register = (slug: string) =>
		daemon.runPromise(addWithoutOpening(project(slug), { silent: true }));
	/** Open the project, as a tab or a folder change does; `stop` closes it. */
	const daemonProject = async (slug: string): Promise<Opened> => ({
		slug,
		context: await daemon.runPromise(
			Effect.flatMap(ProjectServices, (projects) => projects.open(slug)),
		),
	});
	const stop = (target: Opened) =>
		daemon.runPromise(
			Effect.flatMap(ProjectServices, (projects) =>
				projects.close(target.slug),
			),
		);
	const run = <A, E>(
		target: Opened,
		use: Effect.Effect<A, E, ProjectParts | SessionManagerServiceTag>,
	) => daemon.runPromise(Effect.provide(use, target.context));
	const stateOf = async (target: Opened) =>
		Context.get(target.context, SessionManagerStateTag);
	const snapshot = async (target: Opened) => {
		const state = await Effect.runPromise(Ref.get(await stateOf(target)));
		return {
			parents: Object.fromEntries(HashMap.toEntries(state.cachedParentMap)),
			sideThreads: [...state.cachedSideThreadIds],
			sessionCount: state.lastKnownSessionCount,
		};
	};
	const seed = async (target: Opened, count: number) =>
		Effect.runPromise(
			Ref.update(await stateOf(target), (state) => ({
				...state,
				cachedParentMap: HashMap.set(state.cachedParentMap, "child", "parent"),
				cachedSideThreadIds: new Set(["side"]),
				lastKnownSessionCount: count,
			})),
		);
	const activity = async (target: Opened) =>
		Object.fromEntries(
			HashMap.toEntries(
				(await Effect.runPromise(Ref.get(await stateOf(target)))).lastMessageAt,
			),
		);
	const sessions = (
		target: Opened,
		...rows: ReadonlyArray<{ id: string; parentId?: string }>
	) =>
		run(
			target,
			Effect.flatMap(makeCommitAndSignal, (commit) =>
				commit(
					rows.map(({ id, parentId }) =>
						canonicalEvent("session.created", id, {
							sessionId: id,
							provider: "claude",
							title: id,
							...(parentId === undefined ? {} : { parentId }),
						}),
					),
				),
			),
		);
	const manager = <A, E>(
		target: Opened,
		use: (service: SessionManagerService) => Effect.Effect<A, E>,
	) =>
		daemon.runPromise(
			Effect.flatMap(SessionManagerServiceTag, (service) =>
				use(service.forProject(target.slug)),
			),
		);
	/** "open" while the session's owner scope takes resources, else the close reason. */
	const scopeOf = (sessionId: string) =>
		daemon.runPromise(
			Effect.flatMap(OwnerScopes, (owners) =>
				owners.sessionScope(sessionId).pipe(
					Effect.flatMap((scope) => scope.acquire(Effect.void)),
					Effect.as("open"),
					Effect.catchTag("OwnerScopeClosedError", (error) =>
						Effect.succeed(error.reason),
					),
				),
			),
		);
	return {
		daemon,
		configDir,
		folder: (slug: string) => project(slug).folders[0],
		register,
		daemonProject,
		stop,
		run,
		snapshot,
		seed,
		activity,
		sessions,
		manager,
		scopeOf,
	};
};

describe("daemon-owned session manager state", () => {
	it("keeps a project's manager state through a relay rebuild and apart from other projects", async () => {
		const daemon = await start("rebuild-keeps-state");
		await daemon.register("alpha");
		await daemon.register("beta");
		const alpha = await daemon.daemonProject("alpha");
		const beta = await daemon.daemonProject("beta");
		await daemon.seed(alpha, 7);
		await daemon.seed(beta, 3);
		await daemon.stop(alpha);
		const rebuilt = await daemon.daemonProject("alpha");
		const observed = {
			alphaAfterRebuild: await daemon.snapshot(rebuilt),
			beta: await daemon.snapshot(beta),
		};
		evidence.observed = observed;
		expect(observed).toEqual({
			alphaAfterRebuild: {
				parents: { child: "parent" },
				sideThreads: ["side"],
				sessionCount: 7,
			},
			beta: {
				parents: { child: "parent" },
				sideThreads: ["side"],
				sessionCount: 3,
			},
		});
	});

	it("drops a project's manager state when the project is removed", async () => {
		const daemon = await start("remove-drops-state");
		await daemon.register("alpha");
		const alpha = await daemon.daemonProject("alpha");
		await daemon.seed(alpha, 7);
		await daemon.stop(alpha);
		await daemon.daemon.runPromise(
			Effect.flatMap(OwnerScopes, (owners) =>
				owners.close({ kind: "project", projectId: "alpha" }, "remove"),
			),
		);
		const readded = await daemon.daemonProject("alpha");
		const observed = { alphaAfterRemove: await daemon.snapshot(readded) };
		evidence.observed = observed;
		expect(observed).toEqual({
			alphaAfterRemove: { parents: {}, sideThreads: [], sessionCount: 0 },
		});
	});

	it("runs one delete when two relays of a project delete the same session", async () => {
		const daemon = await start("one-delete-across-relays");
		await daemon.register("alpha");
		const first = await daemon.daemonProject("alpha");
		await daemon.run(
			first,
			Effect.flatMap(makeCommitAndSignal, (commit) =>
				commit([
					canonicalEvent("session.created", "doomed", {
						sessionId: "doomed",
						provider: "claude",
						title: "Doomed",
					}),
				]),
			),
		);
		const second = await daemon.daemonProject("alpha");
		const remove = (target: Opened) =>
			daemon.run(
				target,
				Effect.flatMap(SessionManagerServiceTag, (service) =>
					service
						.forProject("alpha")
						.deleteSession("doomed", { keepWorktrees: true }),
				),
			);
		const results = await Promise.all([remove(first), remove(second)]);
		evidence.observed = { results };
		expect([...results].sort()).toEqual([false, true]);
	});

	it("keeps a deleted session's late activity and parent edge out of the manager state", async () => {
		const daemon = await start("delete-fences-late-writes");
		await daemon.register("alpha");
		const alpha = await daemon.daemonProject("alpha");
		await daemon.sessions(alpha, { id: "root" }, { id: "late" });
		await daemon.manager(alpha, (service) =>
			service.recordMessageActivity("late", 1_000),
		);
		const deleted = await daemon.manager(alpha, (service) =>
			service.deleteSession("late", { keepWorktrees: true }),
		);
		await daemon.manager(alpha, (service) =>
			Effect.all([
				service.recordMessageActivity("late", 2_000),
				service.addToParentMap("late", "root"),
			]),
		);
		const observed = {
			deleted,
			activity: await daemon.activity(alpha),
			parents: (await daemon.snapshot(alpha)).parents,
		};
		evidence.observed = observed;
		expect(observed).toEqual({ deleted: true, activity: {}, parents: {} });
	});

	it("closes a deleted session's scope only after the delete commits and its provider cleanup ran", async () => {
		const daemon = await start("delete-closes-after-cleanup");
		await daemon.register("alpha");
		const alpha = await daemon.daemonProject("alpha");
		await daemon.sessions(alpha, { id: "ending" });
		// Provider cleanup for a Claude session removes its runner send journal.
		const sends = join(
			runnerDirectory(daemon.folder("alpha"), daemon.configDir),
			"sends",
			"ending",
		);
		mkdirSync(sends, { recursive: true });
		const atClose: Array<{ rowExists: boolean; sendsExist: boolean }> = [];
		await daemon.daemon.runPromise(
			Effect.gen(function* () {
				const directory = yield* SessionDirectory;
				const scope = yield* (yield* OwnerScopes).sessionScope("ending");
				yield* scope.acquire<void, never, never>(
					Effect.acquireRelease(Effect.void, () =>
						directory.projectOf("ending").pipe(
							Effect.orDie,
							Effect.flatMap((owner) =>
								Effect.sync(() =>
									atClose.push({
										rowExists: Option.isSome(owner),
										sendsExist: existsSync(sends),
									}),
								),
							),
						),
					),
				);
			}),
		);
		const deleted = await daemon.manager(alpha, (service) =>
			service.deleteSession("ending", { keepWorktrees: true }),
		);
		const observed = { deleted, atClose, sendsAfter: existsSync(sends) };
		evidence.observed = observed;
		expect(observed).toEqual({
			deleted: true,
			atClose: [{ rowExists: false, sendsExist: false }],
			sendsAfter: false,
		});
	});

	it("fails a write whose session scope cannot open, unless the session has no row yet", async () => {
		const daemon = await start("hold-fails-closed");
		await daemon.register("alpha");
		await daemon.register("beta");
		const alpha = await daemon.daemonProject("alpha");
		await daemon.sessions(await daemon.daemonProject("beta"), { id: "stray" });
		// beta leaves the registry (its owner scope stays), so its session's scope cannot open.
		await daemon.daemon.runPromise(
			Effect.flatMap(ProjectRegistryTag, (registry) =>
				Ref.update(registry, HashMap.remove("beta")),
			),
		);
		const write = (sessionId: string) =>
			daemon.manager(alpha, (service) =>
				service
					.recordMessageActivity(sessionId, 1_000)
					.pipe(Effect.exit, Effect.map(Exit.isSuccess)),
			);
		const observed = {
			unborn: await write("unborn"),
			stray: await write("stray"),
			activity: await daemon.activity(alpha),
		};
		evidence.observed = observed;
		expect(observed).toEqual({
			unborn: true,
			stray: false,
			activity: { unborn: 1_000 },
		});
	});

	it("closes every session a delete removes and none a declined delete keeps", async () => {
		const daemon = await start("delete-closes-lineage");
		await daemon.register("alpha");
		const alpha = await daemon.daemonProject("alpha");
		await daemon.sessions(
			alpha,
			{ id: "root" },
			{ id: "child", parentId: "root" },
			{ id: "kept" },
		);
		const declined = await daemon.manager(alpha, (service) =>
			service.deleteSession("kept", {
				keepWorktrees: true,
				retentionVersions: new Map([["kept", -1]]),
			}),
		);
		const removed = await daemon.manager(alpha, (service) =>
			service.deleteSession("root", { keepWorktrees: true }),
		);
		const observed = {
			declined,
			removed,
			scopes: {
				root: await daemon.scopeOf("root"),
				child: await daemon.scopeOf("child"),
				kept: await daemon.scopeOf("kept"),
			},
		};
		evidence.observed = observed;
		expect(observed).toEqual({
			declined: false,
			removed: true,
			scopes: { root: "remove", child: "remove", kept: "open" },
		});
	});

	it("serves every project from one daemon session manager, whichever relay a caller came from", async () => {
		const daemon = await start("one-daemon-manager");
		await daemon.register("alpha");
		await daemon.register("beta");
		const alpha = await daemon.daemonProject("alpha");
		const beta = await daemon.daemonProject("beta");
		await daemon.sessions(alpha, { id: "a1" });
		await daemon.sessions(beta, { id: "b1" });
		const owned = await daemon.daemon.runPromise(SessionManagerServiceTag);
		const held = (target: Opened) =>
			daemon.run(target, SessionManagerServiceTag);
		const ids = (projectId: string) =>
			daemon.daemon.runPromise(
				owned
					.forProject(projectId)
					.listSessions()
					.pipe(Effect.map((sessions) => sessions.map(({ id }) => id).sort())),
			);
		const sameInstance = {
			alpha: (await held(alpha)) === owned,
			beta: (await held(beta)) === owned,
		};
		const listed = { alpha: await ids("alpha"), beta: await ids("beta") };
		// alpha's relay deletes beta's session by naming beta.
		const deletedThroughAlpha = await daemon.run(
			alpha,
			Effect.flatMap(SessionManagerServiceTag, (service) =>
				service.forProject("beta").deleteSession("b1", { keepWorktrees: true }),
			),
		);
		await daemon.stop(alpha);
		const rebuilt = await daemon.daemonProject("alpha");
		const observed = {
			sameInstance,
			listed,
			deletedThroughAlpha,
			afterDelete: { alpha: await ids("alpha"), beta: await ids("beta") },
			sameAfterRebuild: (await held(rebuilt)) === owned,
		};
		evidence.observed = observed;
		expect(observed).toEqual({
			sameInstance: { alpha: true, beta: true },
			listed: { alpha: ["a1"], beta: ["b1"] },
			deletedThroughAlpha: true,
			afterDelete: { alpha: ["a1"], beta: [] },
			sameAfterRebuild: true,
		});
	});
});
