import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeTestHandlerLayer } from "../../helpers/mock-factories.js";

const tempDirectory = Effect.acquireRelease(
	Effect.tryPromise({
		try: () => mkdtemp(join(tmpdir(), "conduit-rpc-dir-list-")),
		catch: (cause) => cause,
	}),
	(path) =>
		Effect.orDie(
			Effect.tryPromise({
				try: () => rm(path, { recursive: true, force: true }),
				catch: (cause) => cause,
			}),
		),
);

const tryFs = <A>(operation: () => Promise<A>) =>
	Effect.tryPromise({
		try: operation,
		catch: (cause) => cause,
	});

const rpcLayer = WsRpcServerLayer.pipe(
	Layer.provideMerge(makeTestHandlerLayer()),
);

describe("WsRpcServerLayer FindFolders", () => {
	it.effect("returns existing matches and the missing typed path", () =>
		Effect.gen(function* () {
			const root = yield* tempDirectory;
			yield* tryFs(() => mkdir(join(root, "personal")));
			yield* tryFs(() => mkdir(join(root, "projects")));
			yield* tryFs(() => writeFile(join(root, "program.txt"), "file"));
			const client = yield* RpcTest.makeClient(WsRpcGroup);

			expect(yield* client.FindFolders({ query: `${root}/p` })).toEqual({
				entries: [
					{
						path: `${root}/personal`,
						isGitRepo: false,
						reason: "match",
						exists: true,
					},
					{
						path: `${root}/projects`,
						isGitRepo: false,
						reason: "match",
						exists: true,
					},
					{
						path: `${root}/p`,
						isGitRepo: false,
						reason: "match",
						exists: false,
					},
				],
			});
		}).pipe(Effect.scoped, Effect.provide(rpcLayer)),
	);

	it.effect("normalizes and deduplicates the exact existing folder", () =>
		Effect.gen(function* () {
			const root = yield* tempDirectory;
			yield* tryFs(() => mkdir(join(root, "work")));
			const client = yield* RpcTest.makeClient(WsRpcGroup);

			expect(
				yield* client.FindFolders({ query: `${root}/work/../work` }),
			).toEqual({
				entries: [
					{
						path: `${root}/work`,
						isGitRepo: false,
						reason: "match",
						exists: true,
					},
				],
			});
		}).pipe(Effect.scoped, Effect.provide(rpcLayer)),
	);

	it.effect(
		"includes the exact folder with a trailing slash and caps visible children",
		() =>
			Effect.gen(function* () {
				const root = yield* tempDirectory;
				yield* Effect.forEach(
					Array.from({ length: 25 }, (_, index) => `folder-${index}`),
					(name) => tryFs(() => mkdir(join(root, name))),
				);
				yield* tryFs(() => mkdir(join(root, ".hidden")));
				const client = yield* RpcTest.makeClient(WsRpcGroup);
				const { entries } = yield* client.FindFolders({ query: `${root}/` });

				expect(entries).toHaveLength(20);
				expect(entries[0]).toEqual({
					path: root,
					isGitRepo: false,
					reason: "match",
					exists: true,
				});
				expect(
					entries.every(
						(entry) => entry.exists && entry.path === resolve(entry.path),
					),
				).toBe(true);
				expect(entries.some((entry) => entry.path.endsWith(".hidden"))).toBe(
					false,
				);
			}).pipe(Effect.scoped, Effect.provide(rpcLayer)),
	);

	it.effect("expands the current user's home directory", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(WsRpcGroup);
			const { entries } = yield* client.FindFolders({ query: "~" });

			expect(entries[0]?.path).toBe(resolve(homedir()));
			expect(entries[0]?.exists).toBe(true);
			expect(entries.every((entry) => entry.path === resolve(entry.path))).toBe(
				true,
			);
		}).pipe(Effect.scoped, Effect.provide(rpcLayer)),
	);

	it.effect("identifies git directories and worktree git files", () =>
		Effect.gen(function* () {
			const root = yield* tempDirectory;
			yield* tryFs(() =>
				mkdir(join(root, "project-a", ".git"), { recursive: true }),
			);
			yield* tryFs(() => mkdir(join(root, "project-b")));
			yield* tryFs(() =>
				writeFile(
					join(root, "project-b", ".git"),
					"gitdir: /elsewhere/worktrees/project-b\n",
				),
			);
			yield* tryFs(() => mkdir(join(root, "project-c")));
			const client = yield* RpcTest.makeClient(WsRpcGroup);
			const { entries } = yield* client.FindFolders({
				query: `${root}/project`,
			});

			expect(
				entries.map(({ path, isGitRepo }) => ({ path, isGitRepo })),
			).toEqual([
				{ path: `${root}/project-a`, isGitRepo: true },
				{ path: `${root}/project-b`, isGitRepo: true },
				{ path: `${root}/project-c`, isGitRepo: false },
				{ path: `${root}/project`, isGitRepo: false },
			]);
		}).pipe(Effect.scoped, Effect.provide(rpcLayer)),
	);

	it.effect("returns no suggestions for non-path queries", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(WsRpcGroup);

			expect(yield* client.FindFolders({ query: "" })).toEqual({ entries: [] });
			expect(yield* client.FindFolders({ query: "project" })).toEqual({
				entries: [],
			});
		}).pipe(Effect.scoped, Effect.provide(rpcLayer)),
	);

	it.effect("returns the typed new folder when its parent is missing", () =>
		Effect.gen(function* () {
			const root = yield* tempDirectory;
			const client = yield* RpcTest.makeClient(WsRpcGroup);
			const path = join(root, "missing-parent", "notes");

			expect(yield* client.FindFolders({ query: path })).toEqual({
				entries: [{ path, isGitRepo: false, reason: "match", exists: false }],
			});
		}).pipe(Effect.scoped, Effect.provide(rpcLayer)),
	);

	it.effect(
		"keeps a file and paths beneath a file out of new-folder results",
		() =>
			Effect.gen(function* () {
				const root = yield* tempDirectory;
				const path = join(root, "file");
				yield* tryFs(() => writeFile(path, "file"));
				const client = yield* RpcTest.makeClient(WsRpcGroup);

				for (const query of [path, `${path}/child`]) {
					const result = yield* Effect.either(client.FindFolders({ query }));
					expect(result._tag).toBe("Left");
					if (result._tag === "Left")
						expect(result.left.message).toMatch(/not a directory|ENOTDIR/i);
				}
			}).pipe(Effect.scoped, Effect.provide(rpcLayer)),
	);

	it.effect(
		"reports permission failures instead of claiming the folder is missing",
		() =>
			Effect.gen(function* () {
				const root = yield* tempDirectory;
				const blocked = join(root, "blocked");
				yield* tryFs(() => mkdir(blocked));
				yield* Effect.acquireRelease(
					tryFs(() => chmod(blocked, 0)),
					() => tryFs(() => chmod(blocked, 0o700)).pipe(Effect.orDie),
				);
				const client = yield* RpcTest.makeClient(WsRpcGroup);
				const result = yield* Effect.either(
					client.FindFolders({ query: `${blocked}/missing` }),
				);

				expect(result._tag).toBe("Left");
				if (result._tag === "Left")
					expect(result.left.message).toMatch(/EACCES|permission denied/i);
			}).pipe(Effect.scoped, Effect.provide(rpcLayer)),
	);
});
