import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { ClientMessageSerializationLive } from "../../../src/lib/effect/client-message-serialization.js";
import { RateLimiterTag } from "../../../src/lib/effect/rate-limiter-layer.js";
import type { WebSocketHandlerShape } from "../../../src/lib/effect/services.js";
import {
	handleGetFileContent,
	handleGetFileList,
	handleGetFileTree,
} from "../../../src/lib/handlers/files.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { handleRelayWsMessage } from "../../../src/lib/relay/ws-message-dispatch-effect.js";
import {
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeRecordingWebSocketHandler,
	makeTestHandlerLayer,
	type RecordedWebSocketCall,
} from "../../helpers/mock-factories.js";

const snapshotPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../snapshots/handlers/files.json",
);

const readSnapshots = (): Record<string, RecordedWebSocketCall[]> =>
	JSON.parse(readFileSync(snapshotPath, "utf-8")) as Record<
		string,
		RecordedWebSocketCall[]
	>;

const runFileHandler = async (
	effect: Effect.Effect<void, unknown, unknown>,
	api: OpenCodeAPI,
) => {
	const { wsHandler, calls } = makeRecordingWebSocketHandler();
	const layer = makeTestHandlerLayer({ api, wsHandler });

	await Effect.runPromise(effect.pipe(Effect.provide(layer)));

	return calls;
};

interface FileApiOverrides {
	readonly list?: OpenCodeAPI["file"]["list"];
	readonly read?: OpenCodeAPI["file"]["read"];
	readonly status?: OpenCodeAPI["file"]["status"];
}

const makeFileApi = (file: FileApiOverrides): OpenCodeAPI => {
	const api = makeMockOpenCodeAPI();
	if (file.list) vi.spyOn(api.file, "list").mockImplementation(file.list);
	if (file.read) vi.spyOn(api.file, "read").mockImplementation(file.read);
	if (file.status) vi.spyOn(api.file, "status").mockImplementation(file.status);
	return api;
};

const makeDispatchLayer = (
	api: OpenCodeAPI,
	wsHandler: WebSocketHandlerShape,
) =>
	Layer.mergeAll(
		makeTestHandlerLayer({ api, wsHandler }),
		ClientMessageSerializationLive,
		Layer.succeed(RateLimiterTag, {
			checkLimit: vi.fn(() => Effect.succeed({ allowed: true })),
		}),
	);

describe("file handler wire snapshots", () => {
	it("keeps the get_file_list success envelope stable", async () => {
		const api = makeFileApi({
			list: vi.fn(async () => [
				{ name: "src", type: "directory" },
				{ name: ".git", type: "directory" },
				{ name: "README.md", type: "file", size: 42 },
				{ name: "ignored.log", type: "file", size: 8 },
			]),
			read: vi.fn(async () => ({ content: "ignored.log\n" })),
		});

		const calls = await runFileHandler(handleGetFileList("client-1", {}), api);

		expect(calls).toEqual(readSnapshots()["get_file_list_success"]);
	});

	it("keeps the get_file_content success envelope stable", async () => {
		const api = makeFileApi({
			read: vi.fn(async () => ({ content: "hello world", binary: false })),
		});

		const calls = await runFileHandler(
			handleGetFileContent("client-1", { path: "README.md" }),
			api,
		);

		expect(calls).toEqual(readSnapshots()["get_file_content_success"]);
	});

	it("keeps the get_file_tree success envelope stable", async () => {
		const api = makeFileApi({
			read: vi.fn(async () => ({ content: "ignored.log\nnode_modules/\n" })),
			list: vi.fn(async (path: string) => {
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
			}),
		});

		const calls = await runFileHandler(handleGetFileTree("client-1", {}), api);

		expect(calls).toEqual(readSnapshots()["get_file_tree_success"]);
	});

	it("keeps top-level handler errors stable", async () => {
		const { wsHandler, calls } = makeRecordingWebSocketHandler();
		const api = makeFileApi({
			read: vi.fn(async () => {
				throw new Error("read failed");
			}),
		});

		await Effect.runPromise(
			handleRelayWsMessage({
				clientId: "client-1",
				handler: "get_file_content",
				payload: { path: "README.md" },
				sendTo: wsHandler.sendTo,
				log: makeMockLogger(),
			}).pipe(Effect.provide(makeDispatchLayer(api, wsHandler))),
		);

		expect(calls).toEqual(readSnapshots()["get_file_content_error"]);
	});
});
