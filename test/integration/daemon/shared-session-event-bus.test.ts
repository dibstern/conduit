/*
 * Failure modes: daemon relays accidentally retain local buses; disposing one
 * relay closes the shared bus; standalone stores share signals; a sibling's
 * turn runs workspace resolution with the wrong project; sidebar advances stop
 * reaching daemon status, transcript advances trigger needless refreshes, or a
 * continuous burst loses its final refresh.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Clock, Context, Effect, Fiber, Layer, ManagedRuntime, Option, PubSub, Stream } from "effect";
import { TestClock } from "effect/testing";
import { expect, vi } from "vitest";
import { makeDaemonLive } from "../../../src/lib/domain/daemon/Layers/daemon-layers.js";
import { RelayFactoryTag } from "../../../src/lib/domain/daemon/Layers/relay-factory-layer.js";
import { makeDaemonConfigFromOptions } from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import {
	DaemonEventBusLive,
	DaemonEventBusTag,
} from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import {
	SessionActivityDaemonLive,
	SessionActivityTag,
} from "../../../src/lib/domain/daemon/Services/session-activity.js";
import {
	SessionEventBusLive,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { SessionWorkspaceTag } from "../../../src/lib/domain/relay/Services/session-workspace.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { sdkDefaultClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import {
	createProjectRelay,
	type ProjectRelay,
} from "../../../src/lib/relay/relay-stack.js";

const relayBus = async (relay: ProjectRelay) => {
	const context = (await relay.effectRuntime.runtime.runtime()).context;
	return Option.getOrThrow(Context.getOption(context, SessionEventBusTag));
};

describe("daemon-wide committed session signals", () => {
	it("shares the daemon bus across real relays and keeps it alive after relay disposal", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-shared-bus-"));
		const projects = ["alpha", "beta"].map((slug) => {
			const folder = join(root, slug);
			mkdirSync(folder);
			execFileSync("git", ["init", "-b", "main", folder], {
				stdio: "ignore",
			});
			execFileSync(
				"git",
				[
					"-C",
					folder,
					"-c",
					"user.name=Shared bus test",
					"-c",
					"user.email=shared-bus@example.test",
					"-c",
					"core.hooksPath=/dev/null",
					"commit",
					"--allow-empty",
					"-m",
					"Initial commit",
				],
				{ stdio: "ignore" },
			);
			return {
				slug,
				title: slug,
				folders: [realpathSync(folder)] as const,
				lastUsed: 1,
			};
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
			}),
		);
		const relays: ProjectRelay[] = [];
		try {
			const bus = await daemon.runPromise(SessionEventBusTag);
			for (const project of projects)
				relays.push(
					await daemon.runPromise(
						Effect.flatMap(RelayFactoryTag, (factory) =>
							factory.create(project),
						),
					),
				);
			const [alpha, beta] = relays;
			if (!alpha || !beta) throw new Error("Both project relays must start");
			expect(await relayBus(alpha)).toBe(bus);
			expect(await relayBus(beta)).toBe(bus);

			// Resolver calls expose which relay consumed each turn. A second alpha
			// turn is a completion barrier behind beta's turn in alpha's reactor.
			const observed = relays.map((relay, index) =>
				relay.effectRuntime.runtime.runPromise(
					Effect.map(SessionWorkspaceTag, (workspace) =>
						vi.spyOn(workspace, "resolve").mockImplementation(() =>
							Effect.succeed({
								path: projects[index]?.folders[0] ?? root,
								projectFolder: projects[index]?.folders[0] ?? root,
								provider: "claude",
								reset: true,
							}),
						),
					),
				),
			);
			const [alphaResolve, betaResolve] = await Promise.all(observed);
			if (!alphaResolve || !betaResolve) throw new Error("Resolvers missing");
			const turn = (relay: ProjectRelay, sessionId: string, suffix: string) =>
				relay.effectRuntime.runtime.runPromise(
					Effect.gen(function* () {
						const store = yield* EventStoreEffectTag;
						const commit = yield* makeCommitAndSignal;
						const session = yield* store.readAllBySession(sessionId);
						yield* commit([
							...(session.length === 0
								? [
										canonicalEvent("session.created", sessionId, {
											sessionId,
											provider: "claude",
											title: sessionId,
										}),
									]
								: []),
							canonicalEvent("tool.started", sessionId, {
								messageId: `message-${suffix}`,
								partId: `part-${suffix}`,
								callId: `call-${suffix}`,
								toolName: "Write",
								input: {
									tool: "Write",
									filePath: "file.ts",
									content: suffix,
								},
							}),
							canonicalEvent("turn.completed", sessionId, {
								messageId: `message-${suffix}`,
							}),
						]);
					}),
				);
			await turn(alpha, "alpha-session", "alpha-first");
			await turn(beta, "beta-session", "beta-first");
			await turn(alpha, "alpha-marker", "alpha-second");
			await vi.waitFor(
				() => {
					expect(alphaResolve).toHaveBeenCalledTimes(2);
					expect(betaResolve).toHaveBeenCalledTimes(1);
				},
				{ timeout: 5_000 },
			);
			expect(
				alphaResolve.mock.calls.map(([sessionId]) => sessionId).sort(),
			).toEqual(["alpha-marker", "alpha-session"]);
			expect(betaResolve.mock.calls.map(([sessionId]) => sessionId)).toEqual([
				"beta-session",
			]);
			alphaResolve.mockRestore();
			betaResolve.mockRestore();

			await alpha.stop();
			relays.splice(0, 1);
			const received = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const events = yield* bus.subscribe({
							sessionId: "after-disposal",
						});
						const next = yield* events.pipe(
							Stream.take(1),
							Stream.runCollect,
							Effect.forkScoped,
						);
						yield* Effect.promise(() =>
							beta.effectRuntime.runtime.runPromise(
								Effect.flatMap(makeCommitAndSignal, (commit) =>
									commit([
										canonicalEvent("session.created", "after-disposal", {
											sessionId: "after-disposal",
											provider: "claude",
											title: "Surviving relay",
										}),
									]),
								),
							),
						);
						return yield* Fiber.join(next);
					}).pipe(Effect.timeout("5 seconds")),
				),
			);
			expect([...received]).toMatchObject([
				{ projectId: "beta", sessionId: "after-disposal" },
			]);
		} finally {
			for (const relay of relays.reverse()) await relay.stop();
			await daemon.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

	it("keeps independently stored standalone relays on separate local buses", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-local-bus-"));
		const relays: ProjectRelay[] = [];
		try {
			for (const slug of ["alpha", "beta"])
				relays.push(
					await createProjectRelay({
						httpServer: createServer(),
						persistenceDbPath: join(root, `${slug}.db`),
						configDir: root,
						projectDir: root,
						slug,
						noServer: true,
						opencodeUrl: "http://127.0.0.1:1",
						publishGlobalSetting: () => Effect.void,
						log: createSilentLogger(),
					}),
				);
			const [alpha, beta] = await Promise.all(relays.map(relayBus));
			expect(alpha).toBeDefined();
			expect(beta).toBeDefined();
			expect(alpha).not.toBe(beta);
		} finally {
			for (const relay of relays.reverse()) await relay.stop();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.effect(
		"coalesces sidebar advances across projects with one trailing refresh",
		() =>
			Effect.gen(function* () {
				const bus = yield* SessionEventBusTag;
				const activity = yield* SessionActivityTag;
				const daemon = yield* DaemonEventBusTag;
				const events = yield* PubSub.subscribe(daemon);
				const publishedAt: number[] = [];
				const transient: string[] = [];
				yield* Stream.fromQueue(events).pipe(
					Stream.filter((event) => event._tag === "DaemonSessionsChanged"),
					Stream.runForEach(() =>
						Clock.currentTimeMillis.pipe(
							Effect.tap((time) => Effect.sync(() => publishedAt.push(time))),
						),
					),
					Effect.forkScoped,
				);
				const changes = yield* activity.subscribe;
				yield* changes.pipe(
					Stream.runForEach((sessionId) =>
						Effect.sync(() => transient.push(sessionId)),
					),
					Effect.forkScoped,
				);
				const advance = (version: number, sidebar = true) =>
					bus.publishAdvance({
						version,
						projectIds: [version % 2 === 0 ? "beta" : "alpha"],
						sessionIds: [`session-${version}`],
						removedSessionIds: [],
						collections: [sidebar ? "sidebar" : "messages"],
					});
				yield* advance(0, false);
				yield* TestClock.adjust("0 millis");
				expect(publishedAt).toEqual([]);
				yield* advance(1);
				yield* TestClock.adjust("0 millis");
				expect(publishedAt).toEqual([0]);
				for (let version = 2; version <= 13; version++) {
					yield* TestClock.adjust("200 millis");
					yield* advance(version);
					yield* TestClock.adjust("0 millis");
				}
				expect(publishedAt).toEqual([0, 1000, 2000]);
				yield* TestClock.adjust("599 millis");
				expect(publishedAt).toEqual([0, 1000, 2000]);
				yield* TestClock.adjust("1 millis");
				expect(publishedAt).toEqual([0, 1000, 2000, 3000]);
				yield* TestClock.adjust("2 seconds");
				expect(publishedAt).toEqual([0, 1000, 2000, 3000]);
				expect(transient).toEqual([]);
				activity.changed("transient-only");
				yield* TestClock.adjust("0 millis");
				expect(publishedAt).toEqual([0, 1000, 2000, 3000, 5000]);
				expect(transient).toEqual(["transient-only"]);
			}).pipe(
				Effect.provide(
					Layer.fresh(
						SessionActivityDaemonLive.pipe(
							Layer.provideMerge(
								Layer.merge(DaemonEventBusLive, SessionEventBusLive),
							),
						),
					),
				),
			),
	);
});
