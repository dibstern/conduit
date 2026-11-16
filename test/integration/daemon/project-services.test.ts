/*
 * 82tn.16 (S5): the daemon builds each project's context from its registry, so
 * a project's session manager works with no relay running. Failure modes
 * (audit.md rows 70-77), written before the code:
 * 70 a project no relay has opened since the daemon started cannot list or
 *    rename its sessions ("No relay serves project");
 * 71 a removed project's call fails without saying why, or deletes its rows;
 * 72 a project added while the daemon runs has no context until a relay starts;
 * 73 after a restart a project's stored sessions are unreachable until a tab
 *    opens it;
 * 74 two projects sharing a folder list each other's sessions;
 * 77 the manager dies with the relay that lent its parts.
 * Modes 75 (reconnect) and 76 (store isolation) are covered by
 * daemon-session-manager.test.ts and daemon-session-manager-owner.test.ts
 * ("serves every project from one daemon session manager").
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
	Deferred,
	Effect,
	Layer,
	ManagedRuntime,
	Option,
} from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDaemonLive } from "../../../src/lib/domain/daemon/Layers/daemon-layers.js";
import { makeDaemonConfigFromOptions } from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonOrchestration } from "../../../src/lib/domain/daemon/Services/daemon-orchestration.js";
import { DaemonStoreAvailability } from "../../../src/lib/domain/daemon/Services/daemon-store-availability.js";
import {
	addWithoutOpening,
	remove,
} from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { ProjectServices } from "../../../src/lib/domain/daemon/Services/project-services.js";
import { StatusPollerTag } from "../../../src/lib/domain/project-services/Services/services.js";
import {
	type SessionManagerService,
	SessionManagerServiceTag,
} from "../../../src/lib/domain/project-services/Services/session-manager-service.js";
import { SSEStreamTag } from "../../../src/lib/domain/project-services/Services/sse-stream-service.js";
import { PushManagerTag } from "../../../src/lib/domain/server/Services/push-service.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { SessionStateProjectionNotifierTag } from "../../../src/lib/persistence/effect/session-state-projection-notifier.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { projectStorageDir } from "../../../src/lib/persistence/project-storage.js";
import { sdkDefaultClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";

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
		join(artifacts, `82tn-16-project-services-${evidence.scenario}.json`),
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

const start = (scenario: string) => {
	evidence.scenario = scenario;
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "conduit-project-ctx-")),
	);
	const folder = join(root, "repo");
	mkdirSync(folder);
	execFileSync("git", ["init", "-q", "-b", "main", folder]);
	const configDir = join(root, "config");
	mkdirSync(configDir);
	const running = new Set<ManagedRuntime.ManagedRuntime<unknown, unknown>>();
	cleanups.push(async () => {
		for (const daemon of running) await daemon.dispose();
		rmSync(root, { recursive: true, force: true });
	});
	const project = (slug: string) => ({
		slug,
		title: slug,
		folders: [folder] as const,
		lastUsed: 1,
	});
	const boot = () => {
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
		running.add(daemon as ManagedRuntime.ManagedRuntime<unknown, unknown>);
		const register = (slug: string) =>
			daemon.runPromise(addWithoutOpening(project(slug), { silent: true }));
		/** Write sessions in the project's context; the project is not opened. */
		const seed = (slug: string, ...ids: ReadonlyArray<string>) =>
			daemon.runPromise(
				Effect.gen(function* () {
					const projects = yield* ProjectServices;
					const context = yield* projects.forProject(slug);
					const commit = yield* makeCommitAndSignal.pipe(
						Effect.provide(context),
					);
					yield* commit(
						ids.map((id) =>
							canonicalEvent("session.created", id, {
								sessionId: id,
								provider: "claude",
								title: id,
							}),
						),
					).pipe(Effect.provide(context));
				}),
			);
		const manager = <A, E>(
			slug: string,
			use: (service: SessionManagerService) => Effect.Effect<A, E>,
		) =>
			daemon.runPromise(
				Effect.flatMap(SessionManagerServiceTag, (service) =>
					use(service.forProject(slug)),
				),
			);
		const listed = (slug: string) =>
			manager(slug, (service) =>
				service
					.listSessions()
					.pipe(
						Effect.map((sessions) =>
							sessions.map(({ id, title }) => ({ id, title })),
						),
					),
			);
		const rows = () =>
			daemon.runPromise(
				Effect.flatMap(
					SqlClient.SqlClient,
					(sql) =>
						sql<{ id: string; project_id: string | null }>`
							SELECT id, project_id FROM sessions ORDER BY id`,
				),
			);
		const stop = async () => {
			running.delete(daemon as ManagedRuntime.ManagedRuntime<unknown, unknown>);
			await daemon.dispose();
		};
		return { daemon, configDir, register, seed, manager, listed, rows, stop };
	};
	return { boot };
};

describe("82tn.16: the daemon builds each project's context", () => {
	it("serves a project added while running, with no relay open", async () => {
		const daemon = start("no-relay").boot();
		await daemon.register("alpha");
		await daemon.seed("alpha", "s1");
		await daemon.manager("alpha", (service) =>
			service.renameSession("s1", "Renamed"),
		);
		await daemon.register("late");
		const observed = {
			alpha: await daemon.listed("alpha"),
			late: await daemon.listed("late"),
		};
		evidence.observed = observed;
		expect(observed).toEqual({
			alpha: [{ id: "s1", title: "Renamed" }],
			late: [],
		});
	});

	it("keeps two projects that share a folder apart", async () => {
		const daemon = start("shared-folder").boot();
		await daemon.register("alpha");
		await daemon.register("beta");
		await daemon.seed("alpha", "a1");
		await daemon.seed("beta", "b1");
		const observed = {
			alpha: await daemon.listed("alpha"),
			beta: await daemon.listed("beta"),
		};
		evidence.observed = observed;
		expect(observed).toEqual({
			alpha: [{ id: "a1", title: "a1" }],
			beta: [{ id: "b1", title: "b1" }],
		});
	});

	it("refuses a removed project's calls with a reason and leaves its sessions", async () => {
		const daemon = start("removed").boot();
		await daemon.register("alpha");
		await daemon.seed("alpha", "s1");
		await daemon.daemon.runPromise(remove("alpha"));
		const refused = await daemon
			.listed("alpha")
			.then(() => "served")
			.catch((error: { readonly cause?: unknown }) => String(error.cause));
		const observed = { refused, rows: await daemon.rows() };
		evidence.observed = observed;
		expect(observed.refused).toMatch(/Project "alpha" is not registered/);
		expect(observed.rows).toEqual([{ id: "s1", project_id: "alpha" }]);
	});

	it("refuses to open an unavailable project and writes nothing for it", async () => {
		// Lane 16r, row 168: the relay factory's availability check, now `open`'s.
		const daemon = start("unavailable").boot();
		await daemon.register("beta");
		const reason = "History import failed (corrupt)";
		const attempts = await daemon.daemon.runPromise(
			Effect.gen(function* () {
				(yield* DaemonStoreAvailability).set("beta", reason);
				const projects = yield* ProjectServices;
				return [
					yield* Effect.flip(projects.open("beta")),
					yield* Effect.flip(projects.open("beta")),
				].map(({ _tag, reason }) => ({ _tag, reason }));
			}),
		);
		const observed = {
			attempts,
			storage: existsSync(projectStorageDir(daemon.configDir, "beta")),
			rows: await daemon.rows(),
		};
		evidence.observed = observed;
		expect(observed).toEqual({
			attempts: [
				{ _tag: "ProjectServicesError", reason },
				{ _tag: "ProjectServicesError", reason },
			],
			storage: false,
			rows: [],
		});
	});

	it("opens a project in its generation and removal ends its stream", async () => {
		// Lane 16q, rows 144-145: the stream and status poller are the
		// generation's; a re-added project gets fresh ones.
		const daemon = start("open").boot();
		const opened = async () => {
			await daemon.daemon.runPromise(
				Effect.flatMap(ProjectServices, (projects) => projects.open("alpha")),
			);
			const context = await daemon.daemon.runPromise(
				Effect.flatMap(ProjectServices, (services) =>
					services.forProject("alpha"),
				),
			);
			return {
				stream: Context.getOption(context, SSEStreamTag),
				poller: Context.getOption(context, StatusPollerTag),
				// A commit in the project's context refreshes lineage, as the relay's did.
				notifier: Context.getOption(context, SessionStateProjectionNotifierTag),
			};
		};
		await daemon.register("alpha");
		const first = await opened();
		const firstStream = Option.getOrThrow(first.stream);
		await daemon.daemon.runPromise(remove("alpha"));
		const afterRemoval = {
			connected: firstStream.isConnected(),
			open: Option.isSome(
				await daemon.daemon.runPromise(
					Effect.flatMap(ProjectServices, (projects) =>
						projects.opened("alpha"),
					),
				),
			),
		};
		await daemon.register("alpha");
		const second = await opened();
		const observed = {
			poller: Option.isSome(first.poller),
			notifier: Option.isSome(first.notifier),
			afterRemoval,
			fresh: Option.getOrThrow(second.stream) !== firstStream,
		};
		evidence.observed = observed;
		expect(observed).toEqual({
			poller: true,
			notifier: true,
			afterRemoval: { connected: false, open: false },
			fresh: true,
		});
	});

	it("serves a project's stored sessions after a restart without a relay", async () => {
		const harness = start("restart");
		const first = harness.boot();
		await first.register("alpha");
		await first.seed("alpha", "s1");
		await first.stop();
		const second = harness.boot();
		await second.register("alpha");
		const observed = { alpha: await second.listed("alpha") };
		evidence.observed = observed;
		expect(observed).toEqual({ alpha: [{ id: "s1", title: "s1" }] });
	});
});

describe("h0x3p: a send the gate holds brings its project back once", () => {
	type Daemon = ReturnType<ReturnType<typeof start>["boot"]>;
	const services = <A, E>(
		daemon: Daemon,
		use: (projects: ProjectServices["Service"]) => Effect.Effect<A, E>,
	) => daemon.daemon.runPromise(Effect.flatMap(ProjectServices, use));
	const opened = (daemon: Daemon, slug: string) =>
		services(daemon, (projects) => projects.opened(slug)).then(Option.isSome);
	/** One outbox row per slug, in order: a retry an hour off, which only the gate reads. */
	const waitingSends = (daemon: Daemon, slugs: ReadonlyArray<string>) =>
		daemon.daemon.runPromise(
			Effect.flatMap(SqlClient.SqlClient, (sql) =>
				Effect.forEach(
					slugs,
					(slug, index) => sql`INSERT INTO provider_command_outbox
						(request_sequence, command_id, project_key, session_id, provider_id, effect_type,
							payload_json, status, next_attempt_at, requested_at, updated_at)
						VALUES (${index + 1}, ${`waiting-${index}`}, ${slug}, ${`session-${slug}`}, 'claude',
							'interrupt_turn', '{}', 'retryable_failed', ${Date.now() + 3_600_000}, 1, 1)`,
					{ discard: true },
				),
			),
		);
	const drain = (daemon: Daemon) =>
		daemon.daemon.runPromise(
			Effect.flatMap(DaemonOrchestration, ({ engine }) =>
				engine.drainSideEffects(),
			),
		);

	it("opens a returned project however many sends wait on a closed one", async () => {
		// S1: the gate reads every waiting row, so a closed project's sends must not
		// crowd out the one wake of a project whose folder came back.
		const daemon = start("held-wakes-coalesce").boot();
		await daemon.register("returned");
		await daemon.register("closed");
		await services(daemon, (projects) =>
			projects.open("closed").pipe(Effect.andThen(projects.close("closed"))),
		);
		await waitingSends(daemon, [
			"returned",
			...Array.from({ length: 100 }, () => "closed"),
		]);
		for (let sweep = 0; sweep < 3; sweep++) await drain(daemon);
		// test-waits-allow polling: the wake reader opens in its own fiber, with no event to await.
		await vi.waitFor(
			async () => expect(await opened(daemon, "returned")).toBe(true),
			{ timeout: 10_000 },
		);
		const observed = {
			returned: await opened(daemon, "returned"),
			closed: await opened(daemon, "closed"),
		};
		evidence.observed = observed;
		expect(observed).toEqual({ returned: true, closed: false });
	});

	it("leaves closed a project its owner opened and closed while its wake waited", async () => {
		// S2: the wake reader is held in another project's open while the owner opens
		// and closes this one; the wake it already holds must not reopen it.
		const daemon = start("held-wake-closed").boot();
		for (const slug of ["busy", "closed", "after"]) await daemon.register(slug);
		const [entered, release] = await daemon.daemon.runPromise(
			Effect.all([Deferred.make<void>(), Deferred.make<void>()]),
		);
		// The next open waits here, after it has recorded its start.
		await daemon.daemon.runPromise(
			Effect.flatMap(PushManagerTag, (push) =>
				Effect.sync(() => {
					const legacy = push.getLegacyManager;
					let held = false;
					Object.assign(push, {
						getLegacyManager: Effect.suspend(() => {
							if (held) return legacy;
							held = true;
							return Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
								Effect.andThen(legacy),
							);
						}),
					});
				}),
			),
		);
		await waitingSends(daemon, ["busy", "closed", "after"]);
		await drain(daemon);
		await daemon.daemon.runPromise(Deferred.await(entered));
		await services(daemon, (projects) =>
			projects.open("closed").pipe(Effect.andThen(projects.close("closed"))),
		);
		await daemon.daemon.runPromise(Deferred.succeed(release, undefined));
		// test-waits-allow polling: the wake reader opens in its own fiber, with no event to await.
		await vi.waitFor(
			async () => expect(await opened(daemon, "after")).toBe(true),
			{ timeout: 10_000 },
		);
		const observed = {
			busy: await opened(daemon, "busy"),
			closed: await opened(daemon, "closed"),
			after: await opened(daemon, "after"),
		};
		evidence.observed = observed;
		expect(observed).toEqual({ busy: true, closed: false, after: true });
	});
});
