import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("WsRpcServerLayer ListDirectories", () => {
	it.effect(
		"returns directory autocomplete entries from the directory service",
		() =>
			Effect.gen(function* () {
				const root = yield* tempDirectory;
				yield* tryFs(() => mkdir(join(root, "personal")));
				yield* tryFs(() => mkdir(join(root, "projects")));
				yield* tryFs(() => mkdir(join(root, "work")));

				const client = yield* RpcTest.makeClient(WsRpcGroup);
				const result = yield* client.ListDirectories({
					projectSlug: "project-a",
					path: `${root}/p`,
				});

				expect(result).toEqual({
					projectSlug: "project-a",
					path: `${root}/p`,
					entries: [`${root}/personal/`, `${root}/projects/`],
				});
			}).pipe(
				Effect.scoped,
				Effect.provide(
					WsRpcServerLayer.pipe(Layer.provideMerge(makeTestHandlerLayer())),
				),
			),
	);
});
