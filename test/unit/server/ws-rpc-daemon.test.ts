import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { DaemonWsRpcHandlersTag } from "../../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.js";
import { RelayCacheTag } from "../../../src/lib/domain/daemon/Services/relay-cache.js";
import { makeRoutedWsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";

describe("daemon RPC handlers", () => {
	it.scoped(
		"serves daemon operations without a project or relay context",
		() => {
			const resolve = vi.fn(() => Effect.die("Unexpected relay resolution"));
			return Effect.gen(function* () {
				const handlers = yield* DaemonWsRpcHandlersTag;
				const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
					Effect.provide(makeRoutedWsRpcServerLayer(resolve, handlers)),
				);
				expect((yield* client.GetProjects({})).projects).toEqual([]);
				const added = yield* client.AddProject({
					directory: "/tmp/rpc-first-project",
				});
				if (!added.addedSlug) throw new Error("Missing added project slug");
				expect(
					yield* client.GetProjects({ projectSlug: added.addedSlug }),
				).toMatchObject({ current: added.addedSlug });
				expect(
					(yield* client.GetProjects({ projectSlug: "missing" })).projects,
				).toMatchObject([{ slug: added.addedSlug }]);
				expect(
					(yield* client.RenameProject({
						slug: added.addedSlug,
						title: " Renamed ",
					})).projects,
				).toMatchObject([{ title: "Renamed" }]);
				expect(
					(yield* client.SetProjectInstance({
						slug: added.addedSlug,
						instanceId: "claude",
					})).projects,
				).toMatchObject([{ instanceId: "claude" }]);
				expect(
					(yield* client.RemoveProject({ slug: added.addedSlug })).projects,
				).toEqual([]);
				expect((yield* client.ListDaemonSessions({})).sessions).toEqual([]);
				expect(yield* client.ResolveSession({ sessionId: "missing" })).toEqual({
					projectSlug: null,
				});
				expect(
					(yield* client.ListDirectories({ path: "/nonexistent-directory/" }))
						.entries,
				).toEqual([]);
				expect((yield* client.ScanNow({})).active).toEqual([]);

				const instance = yield* client.AddInstance({
					name: " Test Claude ",
					driver: "claude",
					managed: false,
				});
				expect(instance.instances).toMatchObject([
					{ id: "test-claude", name: "Test Claude" },
				]);
				const duplicate = yield* client.AddInstance({
					projectSlug: "missing",
					name: "Test Claude",
					driver: "claude",
				});
				expect(duplicate.instances.map((item) => item.id).sort()).toEqual([
					"test-claude",
					"test-claude-2",
				]);
				expect(
					(yield* client.RenameInstance({
						instanceId: "test-claude",
						name: " Renamed ",
					})).instances,
				).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ id: "test-claude", name: "Renamed" }),
					]),
				);
				yield* client.UpdateInstance({
					instanceId: "test-claude",
					name: "Updated",
				});
				yield* client.StartInstance({ instanceId: "test-claude" });
				yield* client.StopInstance({ instanceId: "test-claude" });
				yield* client.RemoveInstance({ instanceId: "test-claude" });
				expect(
					(yield* client.RemoveInstance({ instanceId: "test-claude-2" }))
						.instances,
				).toEqual([]);
				expect(resolve).not.toHaveBeenCalled();
			}).pipe(Effect.provide(makeDaemonRpcTestLayer()));
		},
	);

	it.scoped(
		"broadcasts project and instance changes to every existing relay without starting others",
		() => {
			const broadcasts = [vi.fn(), vi.fn()] as const;
			const projects = ["a", "b", "cold"].map((slug) => ({
				slug,
				title: slug,
				directory: `/tmp/${slug}`,
			}));
			const factory = vi.fn((slug: string) =>
				Effect.succeed({
					slug,
					wsHandler: {
						handleUpgrade: vi.fn(),
						broadcast: broadcasts[slug === "a" ? 0 : 1],
					},
					rpcWsHandler: { handleUpgrade: vi.fn() },
					stop: vi.fn(),
				}),
			);
			return Effect.gen(function* () {
				const cache = yield* RelayCacheTag;
				const firstRelay = yield* cache.get("a");
				yield* cache.get("b");
				factory.mockClear();
				const handlers = yield* DaemonWsRpcHandlersTag;
				const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
					Effect.provide(
						makeRoutedWsRpcServerLayer(
							() => Effect.die("Unexpected routing"),
							handlers,
						),
					),
				);
				yield* client.RenameProject({
					projectSlug: "missing",
					slug: "a",
					title: "Renamed",
				});
				yield* client.AddInstance({ name: "Claude", driver: "claude" });
				yield* Effect.tryPromise(() =>
					vi.waitFor(() => {
						for (const broadcast of broadcasts) {
							expect(broadcast).toHaveBeenCalledWith(
								expect.objectContaining({ type: "project_list" }),
							);
							expect(broadcast).toHaveBeenCalledWith(
								expect.objectContaining({ type: "instance_list" }),
							);
						}
					}),
				);
				yield* client.SetProjectInstance({ slug: "a", instanceId: "claude" });
				expect(firstRelay.stop).toHaveBeenCalledTimes(1);
				// Rebinding replaces the project's engine, as the relay-side handler did.
				expect(factory).toHaveBeenCalledTimes(1);
				expect((yield* cache.peek("a"))._tag).toBe("Some");
			}).pipe(Effect.provide(makeDaemonRpcTestLayer(projects, factory)));
		},
	);
});
