// Failure modes pinned before implementation:
// - Files waits for its session's launch permit or changes a missing workspace.
// - A missing secondary folder blocks a healthy root or emits a launch warning.
// - A path or symlink escapes its selected folder, with or without a root.
// - Tree walking follows an escaping directory symlink.
// - Turn start stops recovering a missing existing-origin worktree.
import "../../../src/lib/domain/project-services/Services/session-command.js";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, PubSub } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import { AlertsTag } from "../../../src/lib/domain/project-services/Services/alerts.js";
import { resolveSessionFolders } from "../../../src/lib/domain/project-services/Services/provider-turn-dispatch.js";
import { OpenCodeFileServiceTag } from "../../../src/lib/domain/project-services/Services/services.js";
import { applySessionCommand } from "../../../src/lib/domain/project-services/Services/session-command.js";
import {
	makeSessionOpenCodeClient,
	resolveSessionRequestFolders,
	SessionWorkspaceTag,
} from "../../../src/lib/domain/project-services/Services/session-workspace.js";
import { filesHandlers } from "../../../src/lib/server/ws-rpc/files.js";
import {
	makeMockConfig,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { worktreeFixture } from "./worktree-service-fixture.js";

describe("read-only session workspace", () => {
	const fixture = worktreeFixture();
	const handlers = (extraFolders: string[] = []) =>
		makeTestHandlerLayer({
			config: makeMockConfig({
				projectDir: fixture.repository,
				configDir: fixture.configDir,
				extraFolders,
			}),
		});
	const seed = Effect.gen(function* () {
		yield* applySessionCommand({
			type: "session.created",
			data: {
				sessionId: "read-session",
				provider: "claude",
				title: "Read session",
			},
		});
	});
	const events = Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		return yield* sql<{
			type: string;
			data: string;
		}>`SELECT type, data FROM events WHERE session_id = 'read-session' ORDER BY sequence`;
	});

	it.effect(
		"refuses an owned checkout replaced by a symlink without changing the workspace",
		() =>
			Effect.gen(function* () {
				yield* seed;
				const created = yield* fixture.createEffect();
				const path = created.worktrees[fixture.repository] ?? "";
				yield* applySessionCommand({
					type: "session.workspace_changed",
					data: {
						sessionId: "read-session",
						cause: "launch",
						path,
						origin: "conduit",
						worktrees: created.worktrees,
						ownership: created.ownership,
					},
				});
				rmSync(path, { recursive: true });
				symlinkSync(fixture.repository, path);
				const before = yield* events;
				const result = yield* Effect.result(
					filesHandlers.GetFileContent({
						sessionId: "read-session",
						path: "tracked.txt",
					}),
				);
				expect(result._tag).toBe("Failure");
				expect(yield* events).toEqual(before);
			}).pipe(Effect.provide(handlers(), { local: true })),
	);

	it.effect(
		"tree walking never reads through an escaping directory symlink",
		() => {
			const outside = join(fixture.fixture, "outside");
			mkdirSync(outside);
			symlinkSync(outside, join(fixture.repository, "escape"));
			return Effect.gen(function* () {
				yield* seed;
				const result = yield* filesHandlers
					.GetFileTree({ sessionId: "read-session" })
					.pipe(
						Effect.provideService(OpenCodeFileServiceTag, {
							read: () => Effect.succeed({ content: "" }),
							list: (path) =>
								Effect.succeed(
									path === "."
										? [{ name: "escape", type: "directory" }]
										: [{ name: "secret", type: "file" }],
								),
						}),
					);
				expect(result.entries).not.toContain("escape/secret");
			}).pipe(Effect.provide(handlers(), { local: true }));
		},
	);

	it.live("Files completes while its own launch lock is held", () =>
		Effect.gen(function* () {
			yield* seed;
			const workspace = yield* SessionWorkspaceTag;
			const entered = yield* Deferred.make<void>();
			const holder = yield* Effect.forkScoped(
				workspace.withLaunch(
					"read-session",
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Effect.never),
					),
				),
			);
			yield* Deferred.await(entered);
			const passiveClient = yield* makeSessionOpenCodeClient;
			const passive = yield* Effect.result(passiveClient("read-session")).pipe(
				Effect.timeoutOption("1 second"),
			);
			expect(
				Option.isSome(passive),
				"passive provider reads must finish before releasing the launch permit",
			).toBe(true);
			const result = yield* filesHandlers
				.GetFileTree({ sessionId: "read-session" })
				.pipe(Effect.timeoutOption("1 second"));
			expect(
				Option.isSome(result),
				"read must finish before releasing the launch permit",
			).toBe(true);
			yield* Fiber.interrupt(holder);
		}).pipe(Effect.provide(handlers(), { local: true })),
	);

	it.effect(
		"reports a missing existing workspace without moving it or alerting; only turn start moves it",
		() =>
			Effect.gen(function* () {
				yield* seed;
				const path = join(fixture.fixture, "existing");
				fixture.git("worktree", "add", "-qb", "existing", path);
				const workspace = yield* SessionWorkspaceTag;
				yield* workspace.move("read-session", path, "user");
				rmSync(path, { recursive: true });
				const before = yield* events;
				const alerts = yield* AlertsTag;
				yield* PubSub.subscribe(alerts);
				const result = yield* Effect.result(
					filesHandlers.GetFileContent({
						sessionId: "read-session",
						path: "tracked.txt",
					}),
				);
				expect(result).toMatchObject({ _tag: "Failure" });
				if (result._tag === "Failure")
					expect(result.failure.message).toContain(path);
				expect(yield* workspace.get("read-session")).toBe(path);
				expect(
					(yield* resolveSessionRequestFolders("read-session"))
						.effectiveFolders,
				).toMatchObject([
					{ root: fixture.repository, directory: path, present: false },
				]);
				expect(yield* events).toEqual(before);
				expect(yield* PubSub.size(alerts)).toBe(0);
				expect(
					(yield* resolveSessionFolders(
						{ id: "read-session", workspace: null },
						{ fallbackMissingWorktree: true },
					)).workspaceRoot,
				).toBe(fixture.repository);
				expect(yield* workspace.get("read-session")).toBe(fixture.repository);
				expect(
					(yield* events).filter(
						(event) => event.type === "session.workspace_changed",
					),
				).toHaveLength(2);
			}).pipe(Effect.provide(handlers(), { local: true })),
	);

	it.effect(
		"healthy roots remain readable when another project folder is missing, without alerts",
		() => {
			const missing = join(fixture.fixture, "absent-extra");
			return Effect.gen(function* () {
				yield* seed;
				const alerts = yield* AlertsTag;
				yield* PubSub.subscribe(alerts);
				const result = yield* filesHandlers.GetFileList({
					sessionId: "read-session",
					root: fixture.repository,
					path: ".",
				});
				expect(result.root).toBe(fixture.repository);
				expect(yield* PubSub.size(alerts)).toBe(0);
				const absent = yield* Effect.result(
					filesHandlers.GetFileList({
						sessionId: "read-session",
						root: missing,
						path: ".",
					}),
				);
				expect(absent._tag).toBe("Failure");
			}).pipe(Effect.provide(handlers([missing]), { local: true }));
		},
	);

	for (const explicitRoot of [false, true]) {
		for (const operation of ["GetFileContent", "GetFileList"] as const) {
			it.effect(
				`${operation} refuses symlink escape with root=${explicitRoot}`,
				() => {
					const outside = join(fixture.fixture, "outside");
					mkdirSync(outside);
					writeFileSync(join(outside, "secret"), "private");
					symlinkSync(outside, join(fixture.repository, "escape"));
					return Effect.gen(function* () {
						yield* seed;
						const request = {
							sessionId: "read-session",
							...(explicitRoot ? { root: fixture.repository } : {}),
							path: operation === "GetFileContent" ? "escape/secret" : "escape",
						};
						const result = yield* Effect.result(
							operation === "GetFileContent"
								? Effect.asVoid(filesHandlers.GetFileContent(request))
								: Effect.asVoid(filesHandlers.GetFileList(request)),
						);
						expect(result._tag).toBe("Failure");
						if (result._tag === "Failure")
							expect(result.failure.message).toContain(
								"outside the selected folder",
							);
					}).pipe(Effect.provide(handlers(), { local: true }));
				},
			);
		}
	}
});
