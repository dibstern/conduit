import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Context, Effect, Option, type Semaphore, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { afterEach, expect, vi } from "vitest";
import { WsRpcError, WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { DaemonWsRpcHandlersTag } from "../../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.js";
import {
	type ProjectParts,
	ProjectServices,
} from "../../../src/lib/domain/daemon/Services/project-services.js";
import {
	type ProjectSettings,
	ProjectSettingsTag,
} from "../../../src/lib/domain/relay/Services/project-settings.js";
import { makeRoutedWsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";

const fixtureDirs: string[] = [];
afterEach(() => {
	for (const directory of fixtureDirs.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("daemon RPC handlers", () => {
	it.effect(
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
						{ local: true },
					),
				);
				const malformed = {
					_tag: "CreateSession" as const,
					originId: "daemon-client",
				};
				const result = yield* Effect.result(
					// @ts-expect-error CreateSession requires an explicit projectSlug.
					createSession(malformed, Headers.empty),
				);
				expect(result).toMatchObject({
					_tag: "Failure",
					failure: { message: "projectSlug is required" },
				});
				expect(resolve).not.toHaveBeenCalled();
			}).pipe(Effect.provide(makeDaemonRpcTestLayer(), { local: true })),
	);

	it.effect(
		"serves daemon operations without a project or relay context",
		() => {
			const directory = mkdtempSync("/tmp/rpc-first-project-");
			fixtureDirs.push(directory);
			const resolve = vi.fn(() => Effect.die("Unexpected relay resolution"));
			return Effect.gen(function* () {
				const handlers = yield* DaemonWsRpcHandlersTag;
				const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
					Effect.provide(makeRoutedWsRpcServerLayer(resolve, handlers), {
						local: true,
					}),
				);
				expect((yield* client.GetProjects({})).projects).toEqual([]);
				const added = yield* client.SaveProject({
					folders: [directory],
				});
				if (!added.savedSlug) throw new Error("Missing added project slug");
				expect(
					yield* client.GetProjects({ projectSlug: added.savedSlug }),
				).toMatchObject({ projectSlug: added.savedSlug });
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
					yield* Effect.result(client.ResolveSession({ sessionId: "missing" })),
				).toMatchObject({
					_tag: "Failure",
					failure: { _tag: "WsRpcError", message: "Unknown session: missing" },
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
					(yield* Effect.result(
						client.SetAutoSettleSetting({ autoSettleAfterDays: 91 }),
					))._tag,
				).toBe("Failure");
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
			}).pipe(Effect.provide(makeDaemonRpcTestLayer(), { local: true }));
		},
	);

	it.effect(
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
						{ local: true },
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
					{ local: true },
				),
			);
		},
	);

	it.effect(
		"publishes project and instance changes to list subscribers without starting projects",
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
			// An opened project's settings sync records its slug and reads nothing else.
			const synced: string[] = [];
			const openedProjects = new Map<string, Context.Context<ProjectParts>>();
			const open = vi.fn((slug: string) =>
				Effect.sync(() => {
					const context = Context.make(ProjectSettingsTag, {
						globalSync: {
							withPermits: () => () => Effect.sync(() => synced.push(slug)),
						} as unknown as Semaphore.Semaphore,
					} as ProjectSettings) as Context.Context<ProjectParts>;
					openedProjects.set(slug, context);
					return context;
				}),
			);
			const close = vi.fn((slug: string) =>
				Effect.sync(() => {
					openedProjects.delete(slug);
				}),
			);
			return Effect.gen(function* () {
				const projectServices = yield* ProjectServices;
				yield* projectServices.open("a");
				yield* projectServices.open("b");
				open.mockClear();
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
				const projectLists: (readonly { slug: string; title: string }[])[] = [];
				const instanceLists: (readonly { id: string }[])[] = [];
				yield* Effect.forkScoped(
					Stream.runForEach(client.SubscribeShell({}), (frame) =>
						Effect.sync(() => {
							if (frame._tag === "projects") projectLists.push(frame.projects);
						}),
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
						expect(synced).toEqual(expect.arrayContaining(["a", "b"]));
					}),
				);
				expect(synced).not.toContain("cold");
				expect(open).not.toHaveBeenCalled();
				yield* client.AddInstance({
					name: "Remote",
					driver: "opencode",
					url: "http://127.0.0.1:9",
				});
				expect(close).not.toHaveBeenCalled();
				expect(open).not.toHaveBeenCalled();
				expect((yield* projectServices.opened("a"))._tag).toBe("Some");
			}).pipe(
				Effect.provide(
					makeDaemonRpcTestLayer(projects, {
						open,
						opened: (slug) =>
							Effect.succeed(Option.fromNullishOr(openedProjects.get(slug))),
						close,
					}),
					{ local: true },
				),
			);
		},
	);
});

import { Headers } from "effect/http";
