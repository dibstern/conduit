import { describe, it } from "@effect/vitest";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { Cause, Effect, Fiber, Layer, Option, TestClock } from "effect";
import { expect, vi } from "vitest";
import { GetFileTree } from "../../../src/lib/contracts/ws-rpc.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import {
	LoggerTag,
	OpenCodeFileServiceLive,
	OpenCodeFileServiceTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	getFileTreeEntries,
	handleGetFileTree,
} from "../../../src/lib/handlers/files.js";
import { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { filesHandlers } from "../../../src/lib/server/ws-rpc/files.js";
import {
	makeMockLogger,
	makeMockWebSocketHandler,
} from "../../helpers/mock-factories.js";

describe("file tree time limits", () => {
	it.effect("preserves breadth-first order and gitignore filtering", () =>
		Effect.gen(function* () {
			expect(yield* getFileTreeEntries()).toEqual([
				"src/",
				"docs/",
				"README.md",
				"src/nested/",
				"src/app.ts",
				"docs/guide.md",
				"src/nested/deep.ts",
			]);
		}).pipe(
			Effect.provideService(LoggerTag, makeMockLogger()),
			Effect.provideService(OpenCodeFileServiceTag, {
				read: () => Effect.succeed({ content: "ignored.log\nnode_modules/\n" }),
				list: (path) =>
					Effect.succeed(
						path === "."
							? [
									{ name: "src", type: "directory" },
									{ name: "docs", type: "directory" },
									{ name: ".git", type: "directory" },
									{ name: "node_modules", type: "directory" },
									{ name: "README.md", type: "file" },
									{ name: "ignored.log", type: "file" },
								]
							: path === "src"
								? [
										{ name: "nested", type: "directory" },
										{ name: "app.ts", type: "file" },
									]
								: [
										{
											name: path === "docs" ? "guide.md" : "deep.ts",
											type: "file",
										},
									],
					),
			}),
		),
	);

	it.effect(
		"keeps partial entries and existing error logging on a folder rejection",
		() => {
			const log = makeMockLogger();
			return Effect.gen(function* () {
				expect(yield* getFileTreeEntries()).toEqual(["src/", "README.md"]);
				expect(log.warn).toHaveBeenCalledWith(
					expect.stringContaining("Error walking directory:"),
				);
			}).pipe(
				Effect.provideService(LoggerTag, log),
				Effect.provideService(OpenCodeFileServiceTag, {
					read: () =>
						Effect.fail(new Cause.UnknownException("missing .gitignore")),
					list: (path) =>
						path === "."
							? Effect.succeed([
									{ name: "src", type: "directory" },
									{ name: "README.md", type: "file" },
								])
							: Effect.fail(new Cause.UnknownException("offline")),
				}),
			);
		},
	);

	it.effect(
		"skips a stalled folder and returns the other folders after 5 seconds",
		() => {
			const log = makeMockLogger();
			const list = vi.fn((path: string) =>
				path === "."
					? Effect.succeed([
							{ name: "stalled", type: "directory" },
							{ name: "healthy", type: "directory" },
						])
					: path === "stalled"
						? Effect.tryPromise(() => new Promise<never>(() => {}))
						: Effect.succeed([{ name: "ok.ts", type: "file" }]),
			);
			return Effect.gen(function* () {
				const fiber = yield* Effect.forkScoped(getFileTreeEntries());
				yield* TestClock.adjust("4999 millis");
				expect(Option.isNone(yield* Fiber.poll(fiber))).toBe(true);
				yield* TestClock.adjust("1 millis");
				expect(Option.isSome(yield* Fiber.poll(fiber))).toBe(true);
				expect(yield* Fiber.join(fiber)).toEqual([
					"stalled/",
					"healthy/",
					"healthy/ok.ts",
				]);
				expect(list.mock.calls.map(([path]) => path)).toEqual([
					".",
					"stalled",
					"healthy",
				]);
				expect(log.warn).toHaveBeenCalledWith(
					'File tree folder timed out: "stalled" after 5000 ms',
				);
			}).pipe(
				Effect.scoped,
				Effect.provideService(LoggerTag, log),
				Effect.provideService(OpenCodeFileServiceTag, {
					list,
					read: () => Effect.succeed({ content: "" }),
				}),
			);
		},
	);

	it.effect(
		"returns partial RPC results at 15 seconds when all child folders stall",
		() => {
			const log = makeMockLogger();
			const list = vi.fn((path: string) =>
				path === "."
					? Effect.succeed(
							["a", "b", "c", "d"].map((name) => ({ name, type: "directory" })),
						)
					: Effect.tryPromise(() => new Promise<never>(() => {})),
			);
			return Effect.gen(function* () {
				const fiber = yield* Effect.forkScoped(
					filesHandlers.GetFileTree(
						new GetFileTree({ projectSlug: "private-project" }),
					),
				);
				yield* TestClock.adjust("14999 millis");
				expect(Option.isNone(yield* Fiber.poll(fiber))).toBe(true);
				yield* TestClock.adjust("1 millis");
				expect(Option.isSome(yield* Fiber.poll(fiber))).toBe(true);
				expect(yield* Fiber.join(fiber)).toEqual({
					projectSlug: "private-project",
					entries: ["a/", "b/", "c/", "d/"],
				});
				expect(log.warn).toHaveBeenCalledWith(
					expect.stringMatching(
						/^File tree deadline reached: .+ after 15000 ms$/,
					),
				);
			}).pipe(
				Effect.scoped,
				Effect.provideService(LoggerTag, log),
				Effect.provideService(OpenCodeFileServiceTag, {
					list,
					read: () => Effect.succeed({ content: "" }),
				}),
			);
		},
	);

	it.effect("returns an empty legacy response when the root stalls", () => {
		const ws = makeMockWebSocketHandler();
		const log = makeMockLogger();
		return Effect.gen(function* () {
			const fiber = yield* Effect.forkScoped(handleGetFileTree("client", {}));
			yield* TestClock.adjust("5 seconds");
			expect(Option.isSome(yield* Fiber.poll(fiber))).toBe(true);
			yield* Fiber.join(fiber);
			expect(ws.sendTo).toHaveBeenCalledWith("client", {
				type: "file_tree",
				entries: [],
			});
			expect(log.warn).toHaveBeenCalledWith(
				'File tree folder timed out: "." after 5000 ms',
			);
		}).pipe(
			Effect.scoped,
			Effect.provideService(WebSocketHandlerTag, ws),
			Effect.provideService(LoggerTag, log),
			Effect.provideService(OpenCodeFileServiceTag, {
				list: () => Effect.tryPromise(() => new Promise<never>(() => {})),
				read: () => Effect.succeed({ content: "" }),
			}),
		);
	});

	for (const stalledCall of ["list", "read"] as const) {
		it.effect(`aborts the SDK ${stalledCall} HTTP request on timeout`, () => {
			const signals: AbortSignal[] = [];
			const aborted = vi.fn();
			const log = makeMockLogger();
			const baseUrl = "http://opencode.test";
			const sdk = createOpencodeClient({
				baseUrl,
				fetch: async (input) => {
					const request = input instanceof Request ? input : new Request(input);
					if (
						stalledCall === "list" &&
						new URL(request.url).pathname === "/file/content"
					) {
						return Response.json({ type: "text", content: "" });
					}
					signals.push(request.signal);
					request.signal.addEventListener("abort", aborted, { once: true });
					return new Promise<Response>(() => {});
				},
			});
			const api = new OpenCodeAPI({
				sdk,
				baseUrl,
				authHeaders: {},
			});
			return Effect.gen(function* () {
				const fiber = yield* Effect.forkScoped(getFileTreeEntries());
				yield* TestClock.adjust(
					stalledCall === "list" ? "4999 millis" : "14999 millis",
				);
				expect(signals).toHaveLength(1);
				expect(signals[0]?.aborted).toBe(false);
				expect(Option.isNone(yield* Fiber.poll(fiber))).toBe(true);
				yield* TestClock.adjust("1 millis");
				expect(Option.isSome(yield* Fiber.poll(fiber))).toBe(true);
				expect(yield* Fiber.join(fiber)).toEqual([]);
				expect(signals[0]?.aborted).toBe(true);
				expect(aborted).toHaveBeenCalledTimes(1);
				if (stalledCall === "read") {
					expect(log.warn).toHaveBeenCalledWith(
						'File tree deadline reached: ".gitignore" after 15000 ms',
					);
				}
			}).pipe(
				Effect.scoped,
				Effect.provideService(LoggerTag, log),
				Effect.provide(
					OpenCodeFileServiceLive.pipe(
						Layer.provide(Layer.succeed(OpenCodeAPITag, api)),
					),
				),
			);
		});
	}

	it.effect(
		"preserves UnknownException error mapping for rejected list and read calls",
		() => {
			const baseUrl = "http://opencode.test";
			const sdk = createOpencodeClient({
				baseUrl,
				fetch: async () => {
					throw new Error("offline");
				},
			});
			const api = new OpenCodeAPI({
				sdk,
				baseUrl,
				authHeaders: {},
			});
			return Effect.gen(function* () {
				const files = yield* OpenCodeFileServiceTag;
				for (const call of [
					Effect.asVoid(files.list(".")),
					Effect.asVoid(files.read(".gitignore")),
				]) {
					const result = yield* Effect.either(call);
					expect(result._tag).toBe("Left");
					if (result._tag === "Left") {
						expect(result.left).toBeInstanceOf(Cause.UnknownException);
						expect(result.left.cause).toMatchObject({
							_tag: "OpenCodeConnectionError",
						});
					}
				}
			}).pipe(
				Effect.provide(
					OpenCodeFileServiceLive.pipe(
						Layer.provide(Layer.succeed(OpenCodeAPITag, api)),
					),
				),
			);
		},
	);
});
