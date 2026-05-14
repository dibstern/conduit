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

describe("WsRpcServerLayer GetFileTree", () => {
	it.effect("returns gitignore-filtered file tree entries", () => {
		const api = makeMockOpenCodeAPI();
		api.file.read = vi.fn(async () => ({
			content: "ignored.log\nnode_modules/\n",
		})) as typeof api.file.read;
		api.file.list = vi.fn(async (path: string) => {
			if (path === ".") {
				return [
					{ name: "src", type: "directory" },
					{ name: ".git", type: "directory" },
					{ name: "README.md", type: "file" },
					{ name: "ignored.log", type: "file" },
					{ name: "node_modules", type: "directory" },
				];
			}
			if (path === "src") {
				return [{ name: "index.ts", type: "file" }];
			}
			return [];
		}) as typeof api.file.list;

		return Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(WsRpcGroup);

			const result = yield* client.GetFileTree({
				projectSlug: "project-a",
			});

			expect(result).toEqual({
				projectSlug: "project-a",
				entries: ["src/", "README.md", "src/index.ts"],
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
