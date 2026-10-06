import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect, vi } from "vitest";
import { OpenCodeFileServiceTag } from "../../../src/lib/domain/relay/Services/services.js";
import { getFileListResponse } from "../../../src/lib/handlers/files.js";

describe("file reads with Effect-native file service", () => {
	it.effect(
		"lists files without requiring the Promise OpenCode API tag",
		() => {
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

			return getFileListResponse().pipe(
				Effect.provideService(OpenCodeFileServiceTag, fileService),
				Effect.tap((reply) => {
					expect(fileService.list).toHaveBeenCalledWith(".");
					expect(fileService.read).toHaveBeenCalledWith(".gitignore");
					expect(reply).toEqual({
						path: ".",
						entries: [
							{ name: "src", type: "directory" },
							{ name: "README.md", type: "file" },
						],
					});
				}),
			);
		},
	);
});
