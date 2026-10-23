// Failure modes: slow probes hide accounts, probes run serially, and probe
// results never follow the unprobed account list.
import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Queue, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { DaemonWsRpcHandlersTag } from "../../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.js";
import { discoverCodexEffect } from "../../../src/lib/provider/codex/codex-discovery.js";
import { makeRoutedWsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";

vi.mock(
	"../../../src/lib/provider/codex/codex-discovery.js",
	async (original) => ({
		...(await original<
			typeof import("../../../src/lib/provider/codex/codex-discovery.js")
		>()),
		discoverCodexEffect: vi.fn(),
	}),
);

describe("SubscribeInstances discovery", () => {
	it.effect("emits accounts before concurrent probes, then their results", () =>
		Effect.gen(function* () {
			const started = yield* Queue.unbounded<string>();
			const finished = yield* Deferred.make<void>();
			const frames =
				yield* Queue.unbounded<
					readonly { id: string; available?: boolean | undefined }[]
				>();
			vi.mocked(discoverCodexEffect).mockImplementation((account) =>
				Queue.offer(started, account?.id ?? "missing").pipe(
					Effect.andThen(Deferred.await(finished)),
					Effect.as({
						models: [],
						commands: [],
						supportsTools: true,
						supportsThinking: true,
						supportsPermissions: true,
						supportsQuestions: true,
						supportsAttachments: false,
						supportsFork: true,
						supportsRevert: false,
					}),
				),
			);
			const handlers = yield* DaemonWsRpcHandlersTag;
			const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
				Effect.provide(
					makeRoutedWsRpcServerLayer(
						() => Effect.die("Unexpected routing"),
						handlers,
					),
					{ local: true },
				),
			);
			yield* Stream.runForEach(client.SubscribeInstances({}), ({ instances }) =>
				Queue.offer(frames, instances),
			).pipe(Effect.forkScoped);
			const first = yield* Queue.take(frames);
			expect(first.map(({ id }) => id)).toEqual(
				expect.arrayContaining(["claude", "work", "personal"]),
			);
			expect(first.every((instance) => !("available" in instance))).toBe(true);
			expect(
				[yield* Queue.take(started), yield* Queue.take(started)].sort(),
			).toEqual(["personal", "work"]);
			yield* Deferred.succeed(finished, undefined);
			const probed = yield* Queue.take(frames);
			expect(probed).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: "work", available: true }),
					expect.objectContaining({ id: "personal", available: true }),
				]),
			);
		}).pipe(
			Effect.provide(
				makeDaemonRpcTestLayer([], undefined, {
					instances: [
						{
							id: "claude",
							name: "Claude",
							driver: "claude",
							port: 0,
							managed: false,
						},
						{
							id: "work",
							name: "Work",
							driver: "codex",
							port: 0,
							managed: false,
						},
						{
							id: "personal",
							name: "Personal",
							driver: "codex",
							port: 0,
							managed: false,
						},
					],
				}),
				{ local: true },
			),
		),
	);
});
