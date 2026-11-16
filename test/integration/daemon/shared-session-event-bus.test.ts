/*
 * Failure modes: a project's context accidentally retains a local bus; removing
 * one project closes the shared bus; a sibling's turn runs workspace resolution
 * with the wrong project; sidebar advances stop reaching daemon status,
 * transcript advances trigger needless refreshes, or a continuous burst loses
 * its final refresh.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodePath } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import {
	Clock,
	Context,
	Effect,
	Fiber,
	Layer,
	ManagedRuntime,
	PubSub,
	Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { expect, vi } from "vitest";
import { makeDaemonLive } from "../../../src/lib/domain/daemon/Layers/daemon-layers.js";
import { makeDaemonConfigFromOptions } from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import {
	DaemonEventBusLive,
	DaemonEventBusTag,
} from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import {
	addWithoutRelay,
	remove,
} from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import {
	type ProjectParts,
	ProjectServices,
} from "../../../src/lib/domain/daemon/Services/project-services.js";
import {
	SessionActivityDaemonLive,
	SessionActivityTag,
} from "../../../src/lib/domain/daemon/Services/session-activity.js";
import {
	SessionEventBusLive,
	SessionEventBusTag,
} from "../../../src/lib/domain/project-services/Services/session-event-bus.js";
import { SessionWorkspaceTag } from "../../../src/lib/domain/project-services/Services/session-workspace.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { sdkDefaultClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";

describe("daemon-wide committed session signals", () => {
	it("shares the daemon bus across registered projects and keeps it alive after one is removed", async () => {
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
			}).pipe(Layer.provide(NodePath.layer)),
		);
		try {
			const bus = await daemon.runPromise(SessionEventBusTag);
			// Registered projects, as the daemon serves them: no relay (82tn.84).
			const contexts: Context.Context<ProjectParts>[] = [];
			for (const project of projects) {
				await daemon.runPromise(addWithoutRelay(project, { silent: true }));
				contexts.push(
					await daemon.runPromise(
						Effect.flatMap(ProjectServices, (services) =>
							services.forProject(project.slug),
						),
					),
				);
			}
			const [alpha, beta] = contexts;
			if (!alpha || !beta) throw new Error("Both project contexts must build");
			expect(Context.get(alpha, SessionEventBusTag)).toBe(bus);
			expect(Context.get(beta, SessionEventBusTag)).toBe(bus);

			// Projects borrow one workspace service; each turn must reach it once.
			const workspace = await daemon.runPromise(SessionWorkspaceTag);
			const resolve = vi
				.spyOn(workspace, "resolve")
				.mockImplementation((sessionId) => {
					const project = projects.find(({ slug }) =>
						sessionId.startsWith(`${slug}-`),
					);
					if (!project) return Effect.die(`Unexpected session ${sessionId}`);
					return Effect.succeed({
						path: project.folders[0],
						projectFolder: project.folders[0],
						provider: "claude",
						reset: true,
					});
				});
			const turn = (
				project: Context.Context<ProjectParts>,
				sessionId: string,
				suffix: string,
			) =>
				daemon.runPromise(
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
					}).pipe(Effect.provideContext(project)),
				);
			await turn(alpha, "alpha-session", "alpha-first");
			await turn(beta, "beta-session", "beta-first");
			await turn(alpha, "alpha-marker", "alpha-second");
			await vi.waitFor(
				() => {
					expect(resolve).toHaveBeenCalledTimes(3);
					expect(
						resolve.mock.calls.filter(([sessionId]) =>
							sessionId.startsWith("alpha-"),
						),
					).toHaveLength(2);
					expect(
						resolve.mock.calls.filter(([sessionId]) =>
							sessionId.startsWith("beta-"),
						),
					).toHaveLength(1);
				},
				{ timeout: 5_000 },
			);
			expect(resolve.mock.calls.map(([sessionId]) => sessionId).sort()).toEqual(
				["alpha-marker", "alpha-session", "beta-session"],
			);
			resolve.mockRestore();

			await daemon.runPromise(remove("alpha"));
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
							daemon.runPromise(
								Effect.flatMap(makeCommitAndSignal, (commit) =>
									commit([
										canonicalEvent("session.created", "after-disposal", {
											sessionId: "after-disposal",
											provider: "claude",
											title: "Surviving project",
										}),
									]),
								).pipe(Effect.provideContext(beta)),
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
			await daemon.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

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
				yield* Stream.fromSubscription(events).pipe(
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
