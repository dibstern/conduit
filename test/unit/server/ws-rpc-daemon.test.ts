import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { afterEach, expect, vi } from "vitest";
import {
	CreateSession,
	WsRpcError,
	WsRpcGroup,
} from "../../../src/lib/contracts/ws-rpc.js";
import { DaemonWsRpcHandlersTag } from "../../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.js";
import { RelayCacheTag } from "../../../src/lib/domain/daemon/Services/relay-cache.js";
import { makeRoutedWsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";

const fixtureDirs: string[] = [];
afterEach(() => {
	for (const directory of fixtureDirs.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("daemon RPC handlers", () => {
	it.scoped(
		"rejects session creation without a project even with a daemon default",
		() =>
			Effect.gen(function* () {
				const handlers = yield* DaemonWsRpcHandlersTag;
				const resolve = vi.fn(() =>
					Effect.fail(
						new WsRpcError({ message: "unexpected relay resolution" }),
					),
				);
				const createSession = yield* WsRpcGroup.accessHandler(
					"CreateSession",
				).pipe(
					Effect.provide(
						makeRoutedWsRpcServerLayer(resolve, handlers, "conduit"),
					),
				);
				const malformed = new CreateSession(
					// @ts-expect-error CreateSession requires an explicit projectSlug.
					{ originId: "daemon-client" },
					{ disableValidation: true },
				);
				const result = yield* Effect.either(
					createSession(malformed, Headers.empty),
				);
				expect(result).toMatchObject({
					_tag: "Left",
					left: { message: "projectSlug is required" },
				});
				expect(resolve).not.toHaveBeenCalled();
			}).pipe(Effect.provide(makeDaemonRpcTestLayer())),
	);

	it.scoped(
		"serves daemon operations without a project or relay context",
		() => {
			const directory = mkdtempSync("/tmp/rpc-first-project-");
			fixtureDirs.push(directory);
			const resolve = vi.fn(() => Effect.die("Unexpected relay resolution"));
			return Effect.gen(function* () {
				const handlers = yield* DaemonWsRpcHandlersTag;
				const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
					Effect.provide(makeRoutedWsRpcServerLayer(resolve, handlers)),
				);
				expect((yield* client.GetProjects({})).projects).toEqual([]);
				const added = yield* client.SaveProject({
					folders: [directory],
				});
				if (!added.savedSlug) throw new Error("Missing added project slug");
				expect(
					yield* client.GetProjects({ projectSlug: added.savedSlug }),
				).toMatchObject({ current: added.savedSlug });
				expect(
					(yield* client.GetProjects({ projectSlug: "missing" })).projects,
				).toMatchObject([{ slug: added.savedSlug }]);
				expect(
					(yield* client.SaveProject({
						slug: added.savedSlug,
						title: " Renamed ",
						folders: [directory],
					})).projects,
				).toMatchObject([{ title: "Renamed" }]);
				expect(
					(yield* client.RemoveProject({ slug: added.savedSlug })).projects,
				).toEqual([]);
				expect((yield* client.ListDaemonSessions({})).sessions).toEqual([]);
				expect(
					yield* Effect.either(client.ResolveSession({ sessionId: "missing" })),
				).toMatchObject({
					_tag: "Left",
					left: { _tag: "WsRpcError", message: "Unknown session: missing" },
				});
				expect((yield* client.ScanNow({})).active).toEqual([]);
				expect(
					(yield* client.GetAutoSettleSetting({})).autoSettleAfterDays,
				).toBe(3);
				expect(
					(yield* client.SetAutoSettleSetting({ autoSettleAfterDays: 7 }))
						.autoSettleAfterDays,
				).toBe(7);
				expect(
					(yield* client.GetAutoSettleSetting({})).autoSettleAfterDays,
				).toBe(7);
				expect(
					(yield* Effect.either(
						client.SetAutoSettleSetting({ autoSettleAfterDays: 91 }),
					))._tag,
				).toBe("Left");
				expect(
					(yield* client.GetAutoSettleSetting({})).autoSettleAfterDays,
				).toBe(7);
				yield* client.SetAutoSettleSetting({ autoSettleAfterDays: null });
				expect(
					(yield* client.GetAutoSettleSetting({})).autoSettleAfterDays,
				).toBeNull();

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
				expect(
					(yield* client.RemoveInstance({ instanceId: "test-claude" }))
						.instances,
				).toEqual([
					expect.objectContaining({ id: "test-claude-2", isDefault: true }),
				]);
				expect(
					(yield* client.RemoveInstance({ instanceId: "test-claude-2" }))
						.instances,
				).toEqual([]);
				expect(resolve).not.toHaveBeenCalled();
			}).pipe(Effect.provide(makeDaemonRpcTestLayer()));
		},
	);

	it.scoped(
		"removes a project until the directory is explicitly added again",
		() => {
			const directory = mkdtempSync("/tmp/rpc-removed-project-");
			fixtureDirs.push(directory);
			return Effect.gen(function* () {
				const handlers = yield* DaemonWsRpcHandlersTag;
				const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
					Effect.provide(
						makeRoutedWsRpcServerLayer(
							() => Effect.die("Unexpected routing"),
							handlers,
						),
					),
				);
				yield* client.RemoveProject({ slug: "gone" });
				expect((yield* client.GetProjects({})).projects).toEqual([]);
				yield* client.SaveProject({ folders: [directory] });
				expect((yield* client.GetProjects({})).projects).toMatchObject([
					{ folders: [realpathSync(directory)] },
				]);
			}).pipe(
				Effect.provide(
					makeDaemonRpcTestLayer([
						{ slug: "gone", title: "gone", folders: [directory] },
					]),
				),
			);
		},
	);

	it.scoped(
		"publishes project and instance changes to list subscribers without starting relays",
		() => {
			const directory = mkdtempSync("/tmp/rpc-project-broadcast-");
			fixtureDirs.push(directory);
			const projects = ["a", "b", "cold"].map((slug) => {
				const projectDir = join(directory, slug);
				mkdirSync(projectDir);
				return {
					slug,
					title: slug,
					folders: [projectDir] as const,
				};
			});
			const factory = vi.fn((slug: string) =>
				Effect.succeed({
					slug,
					attach: () => () => {},
					wsHandler: { broadcast: vi.fn() },
					rpcWsHandler: {},
					syncGlobalSetting: () => Effect.void,
					refreshGlobalDefaults: () => Effect.void,
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
				const projectLists: (readonly { slug: string; title: string }[])[] = [];
				const instanceLists: (readonly { id: string }[])[] = [];
				yield* Effect.forkScoped(
					Stream.runForEach(client.SubscribeProjects({}), ({ projects }) =>
						Effect.sync(() => projectLists.push(projects)),
					),
				);
				yield* Effect.forkScoped(
					Stream.runForEach(client.SubscribeInstances({}), ({ instances }) =>
						Effect.sync(() => instanceLists.push(instances)),
					),
				);
				yield* client.SaveProject({
					projectSlug: "missing",
					slug: "a",
					title: "Renamed",
					folders: [join(directory, "a")],
				});
				yield* client.AddInstance({ name: "Claude", driver: "claude" });
				yield* Effect.tryPromise(() =>
					vi.waitFor(() => {
						expect(projectLists.at(-1)).toContainEqual(
							expect.objectContaining({ slug: "a", title: "Renamed" }),
						);
						expect(instanceLists.at(-1)).toContainEqual(
							expect.objectContaining({ id: "claude-2" }),
						);
					}),
				);
				expect(factory).not.toHaveBeenCalled();
				yield* client.AddInstance({
					name: "Remote",
					driver: "opencode",
					url: "http://127.0.0.1:9",
				});
				expect(firstRelay.stop).not.toHaveBeenCalled();
				expect(factory).not.toHaveBeenCalled();
				expect((yield* cache.peek("a"))._tag).toBe("Some");
			}).pipe(Effect.provide(makeDaemonRpcTestLayer(projects, factory)));
		},
	);
});

import { Headers } from "@effect/platform";
