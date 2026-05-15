import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	OpenCodeFileServiceTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { handleGetFileList } from "../../../src/lib/handlers/files.js";
import {
	makeMockWebSocketHandler,
	type RecordedWebSocketCall,
} from "../../helpers/mock-factories.js";

describe("file handlers with Effect-native file service", () => {
	it.effect(
		"lists files without requiring the Promise OpenCode API tag",
		() => {
			const wsHandler = makeMockWebSocketHandler();
			const fileService = {
				list: vi.fn((_path: string) =>
					Effect.succeed([
						{ name: "src", type: "directory" },
						{ name: "ignored.log", type: "file" },
						{ name: "README.md", type: "file" },
					]),
				),
				read: vi.fn((path: string) =>
					Effect.succeed(
						path === ".gitignore"
							? { content: "ignored.log\n" }
							: { content: "" },
					),
				),
			};

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeFileServiceTag, fileService),
				Layer.succeed(WebSocketHandlerTag, wsHandler),
			);

			return handleGetFileList("client-1", {}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(fileService.list).toHaveBeenCalledWith(".");
					expect(fileService.read).toHaveBeenCalledWith(".gitignore");
					expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
						type: "file_list",
						path: ".",
						entries: [
							{ name: "src", type: "directory" },
							{ name: "README.md", type: "file" },
						],
					} satisfies Extract<
						RecordedWebSocketCall,
						{ channel: "sendTo" }
					>["message"]);
				}),
			);
		},
	);
});
