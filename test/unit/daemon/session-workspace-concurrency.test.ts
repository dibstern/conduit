// Failure modes recorded before implementation:
// - A blocked CreateSession worktree creation stalls another session's file tree/prewarm.
// - A second tab reads session.created before its own launch workspace is recorded.
// - Project-wide work overlaps a session operation in either acquisition order.
// - Interrupting a holder or waiter leaks a permit or splits a still-used session lock.
import "../../../src/lib/domain/relay/Services/session-command.js";

import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { RpcTest } from "effect/rpc";
import { TestClock } from "effect/testing";
import { expect, vi } from "vitest";
import { AccountIdSchema } from "../../../src/lib/contracts/provider-instance.js";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { makeWorktreeLive } from "../../../src/lib/domain/daemon/Layers/worktree-layer.js";
import { WorktreeServiceTag } from "../../../src/lib/domain/daemon/Services/worktree-service.js";
import { resolveSessionRequestFolders } from "../../../src/lib/domain/relay/Services/provider-turn-dispatch.js";
import { applySessionCommand } from "../../../src/lib/domain/relay/Services/session-command.js";
import { SessionWorkspaceTag } from "../../../src/lib/domain/relay/Services/session-workspace.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockConfig,
	makeMockOpenCodeAPI,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { worktreeFixture } from "./worktree-service-fixture.js";

const creation = {
	projectSlug: "test-project",
	originId: "browser",
	instanceId: AccountIdSchema.make("opencode"),
	providerId: "opencode",
	permissionMode: "ask" as const,
	model: { providerId: "openai", modelId: "gpt-4" },
};

describe("session workspace concurrency", () => {
	const fixture = worktreeFixture();
	const handlers = () => {
		const api = makeMockOpenCodeAPI();
		vi.mocked(api.provider.list).mockResolvedValue({
			providers: [
				{
					id: "openai",
					name: "OpenAI",
					models: [{ id: "gpt-4", name: "GPT-4" }],
				},
			],
			defaults: {},
			connected: ["openai"],
		});
		vi.mocked(api.session.create).mockImplementation(async (input) => ({
			id: input?.id ?? "session-new",
			title: "New session",
			projectID: "test-project",
			directory: fixture.repository,
			version: "1",
			time: { created: 1, updated: 1 },
		}));
		vi.mocked(api.file.list).mockResolvedValue([
			{
				name: "tracked.txt",
				type: "file",
			},
		]);
		return makeTestHandlerLayer({
			api,
			config: makeMockConfig({
				projectDir: fixture.repository,
				configDir: fixture.configDir,
			}),
		});
	};
	const seedExisting = Effect.gen(function* () {
		yield* applySessionCommand({
			type: "session.created",
			data: { sessionId: "existing", provider: "opencode", title: "Existing" },
		});
	});

	it.effect(
		"serves another session's file tree and prewarm folders while CreateSession is blocked",
		() => {
			const creating = Deferred.makeUnsafe<void>();
			const release = Deferred.makeUnsafe<void>();
			const worktrees = Layer.effect(
				WorktreeServiceTag,
				Effect.map(WorktreeServiceTag, (service) => ({
					...service,
					create: (...args: Parameters<typeof service.create>) =>
						Deferred.succeed(creating, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
							Effect.andThen(service.create(...args)),
						),
				})),
			).pipe(Layer.provide(makeWorktreeLive(fixture.configDir)));
			return Effect.gen(function* () {
				yield* seedExisting;
				const client = yield* RpcTest.makeClient(WsRpcGroup);
				const create = yield* Effect.forkScoped(
					client.CreateSession({ ...creation, newWorktree: true }),
				);
				yield* Deferred.await(creating);
				const tree = yield* Effect.forkScoped(
					client.GetFileTree({ sessionId: "existing" }),
				);
				const folders = yield* Effect.forkScoped(
					resolveSessionRequestFolders("existing"),
				);
				yield* TestClock.adjust("1 second");
				expect(
					{
						fileTree: tree.pollUnsafe() !== undefined,
						prewarmFolders: folders.pollUnsafe() !== undefined,
					},
					"both reads must finish before creation is released",
				).toEqual({ fileTree: true, prewarmFolders: true });
				expect((yield* Fiber.join(tree)).entries).toEqual(["tracked.txt"]);
				expect((yield* Fiber.join(folders)).workspaceRoot).toBe(
					fixture.repository,
				);
				yield* Deferred.succeed(release, undefined);
				expect((yield* Fiber.join(create)).sessionId).toBeTruthy();
			}).pipe(
				Effect.provide(
					WsRpcServerLayer.pipe(
						Layer.provideMerge(Layer.merge(handlers(), worktrees)),
					),
					{ local: true },
				),
			);
		},
	);

	it.effect(
		"waits for its own launch move after session.created is visible",
		() => {
			const moving = Deferred.makeUnsafe<{ id: string; path: string }>();
			const release = Deferred.makeUnsafe<void>();
			return Effect.gen(function* () {
				const client = yield* RpcTest.makeClient(WsRpcGroup);
				const workspace = yield* SessionWorkspaceTag;
				const create = yield* Effect.forkScoped(
					client.CreateSession({ ...creation, newWorktree: true }),
				);
				const { id, path: target } = yield* Deferred.await(moving);
				const folders = yield* Effect.forkScoped(
					resolveSessionRequestFolders(id),
				);
				yield* TestClock.adjust("1 second");
				expect(folders.pollUnsafe()).toBeUndefined();
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(create);
				expect((yield* Fiber.join(folders)).workspaceRoot).toBe(target);
				expect(yield* workspace.get(id)).toBe(target);
			}).pipe(
				Effect.provide(
					WsRpcServerLayer.pipe(
						Layer.provideMerge(
							Layer.effect(
								SessionWorkspaceTag,
								Effect.map(SessionWorkspaceTag, (workspace) => ({
									...workspace,
									move: (...args: Parameters<typeof workspace.move>) =>
										Deferred.succeed(moving, {
											id: args[0],
											path: args[1],
										}).pipe(
											Effect.andThen(Deferred.await(release)),
											Effect.andThen(workspace.move(...args)),
										),
								})),
							).pipe(
								Layer.provideMerge(
									Layer.merge(handlers(), makeWorktreeLive(fixture.configDir)),
								),
							),
						),
					),
					{ local: true },
				),
			);
		},
	);

	for (const first of ["session", "project"] as const) {
		it.effect(
			`excludes project-wide and session work when ${first} enters first`,
			() =>
				Effect.gen(function* () {
					const workspace = yield* SessionWorkspaceTag;
					const entered = yield* Deferred.make<void>();
					const release = yield* Deferred.make<void>();
					const hold = Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
					);
					const holder = yield* Effect.forkScoped(
						first === "session"
							? workspace.withLaunch("a", hold)
							: workspace.withProjectLaunch(hold),
					);
					yield* Deferred.await(entered);
					const waiting = yield* Effect.forkScoped(
						first === "session"
							? workspace.withProjectLaunch(Effect.void)
							: workspace.withLaunch("b", Effect.void),
					);
					yield* TestClock.adjust("1 second");
					expect(waiting.pollUnsafe()).toBeUndefined();
					yield* Deferred.succeed(release, undefined);
					yield* Fiber.join(holder);
					yield* Fiber.join(waiting);
				}).pipe(Effect.provide(handlers(), { local: true })),
		);
	}

	it.effect(
		"keeps queued session users serialized after interruption and releases every permit",
		() =>
			Effect.gen(function* () {
				const workspace = yield* SessionWorkspaceTag;
				const entered = yield* Deferred.make<void>();
				const holder = yield* Effect.forkScoped(
					workspace.withLaunch(
						"a",
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Effect.never),
						),
					),
				);
				yield* Deferred.await(entered);
				const canceled = yield* Effect.forkScoped(
					workspace.withLaunch("a", Effect.void),
				);
				yield* TestClock.adjust("1 millis");
				yield* Fiber.interrupt(canceled);
				const waiter = yield* Effect.forkScoped(
					workspace.withLaunch("a", Effect.void),
				);
				yield* TestClock.adjust("1 millis");
				expect(waiter.pollUnsafe()).toBeUndefined();
				yield* Fiber.interrupt(holder);
				yield* Fiber.join(waiter);
				yield* Effect.result(
					workspace.withLaunch("a", Effect.fail("expected")),
				);
				yield* workspace.withProjectLaunch(Effect.void);
				yield* workspace.withLaunch("a", Effect.void);
			}).pipe(Effect.provide(handlers(), { local: true })),
	);
});
