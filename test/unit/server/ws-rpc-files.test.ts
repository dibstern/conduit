import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockOpenCodeAPI,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

describe("WsRpcServerLayer file reads", () => {
	it.effect("returns gitignore-filtered file lists", () => {
		const api = makeMockOpenCodeAPI();
		api.file.read = vi.fn(async () => ({
			content: "ignored.log\nnode_modules/\n",
		})) as typeof api.file.read;
		api.file.list = vi.fn(async () => [
			{ name: "src", type: "directory" },
			{ name: ".git", type: "directory" },
			{ name: "README.md", type: "file", size: 42 },
			{ name: "ignored.log", type: "file", size: 8 },
			{ name: "node_modules", type: "directory" },
		]) as typeof api.file.list;

		return Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(WsRpcGroup);
			const result = yield* client.GetFileList({
				projectSlug: "project-a",
				path: ".",
			});

			expect(result).toEqual({
				projectSlug: "project-a",
				path: ".",
				entries: [
					{ name: "src", type: "directory" },
					{ name: "README.md", type: "file", size: 42 },
				],
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(makeTestHandlerLayer({ api })),
				),
			),
		);
	});

	it.effect("returns file content and binary metadata", () => {
		const api = makeMockOpenCodeAPI();
		api.file.read = vi.fn(async () => ({
			content: "hello world",
			binary: false,
		})) as typeof api.file.read;

		return Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(WsRpcGroup);
			const result = yield* client.GetFileContent({
				projectSlug: "project-a",
				path: "README.md",
			});

			expect(result).toEqual({
				projectSlug: "project-a",
				path: "README.md",
				content: "hello world",
				binary: false,
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(makeTestHandlerLayer({ api })),
				),
			),
		);
	});
});
