// test/unit/provider/opencode-adapter-actions.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { OpenCodeAdapter } from "../../../src/lib/provider/opencode-adapter.js";

function makeStubClient(overrides?: Record<string, unknown>): OpenCodeAPI {
	return {
		session: {
			abort: vi.fn(async () => {}),
			prompt: vi.fn(async () => {}),
			...(overrides?.["session"] as Record<string, unknown>),
		},
		permission: {
			reply: vi.fn(async () => {}),
			list: vi.fn(async () => []),
			...(overrides?.["permission"] as Record<string, unknown>),
		},
		question: {
			reply: vi.fn(async () => {}),
			reject: vi.fn(async () => {}),
			list: vi.fn(async () => []),
			...(overrides?.["question"] as Record<string, unknown>),
		},
		provider: {
			list: vi.fn(async () => ({
				providers: [],
				defaults: {},
				connected: [],
			})),
		},
		app: {
			agents: vi.fn(async () => []),
			commands: vi.fn(async () => []),
			skills: vi.fn(async () => []),
		},
		...overrides,
	} as unknown as OpenCodeAPI;
}

describe("OpenCodeAdapter action methods", () => {
	let client: OpenCodeAPI;
	let adapter: OpenCodeAdapter;

	beforeEach(() => {
		client = makeStubClient();
		adapter = new OpenCodeAdapter({ client });
	});

	describe("interruptTurn", () => {
		it("calls client.session.abort with the session ID", async () => {
			await adapter.interruptTurn("session-123");

			expect(client.session.abort).toHaveBeenCalledWith("session-123");
		});

		it("propagates errors from client", async () => {
			client = makeStubClient({
				session: {
					abort: vi.fn(async () => {
						throw new Error("session not found");
					}),
					prompt: vi.fn(async () => {}),
				},
			});
			adapter = new OpenCodeAdapter({ client });

			await expect(adapter.interruptTurn("bad-session")).rejects.toThrow(
				"session not found",
			);
		});
	});

	describe("resolvePermission", () => {
		it("calls client.permission.reply with sessionId, id and decision", async () => {
			await adapter.resolvePermission("s1", "perm-1", "once");

			expect(client.permission.reply).toHaveBeenCalledWith(
				"s1",
				"perm-1",
				"once",
			);
		});

		it("handles 'always' decision", async () => {
			await adapter.resolvePermission("s1", "perm-2", "always");

			expect(client.permission.reply).toHaveBeenCalledWith(
				"s1",
				"perm-2",
				"always",
			);
		});

		it("handles 'reject' decision", async () => {
			await adapter.resolvePermission("s1", "perm-3", "reject");

			expect(client.permission.reply).toHaveBeenCalledWith(
				"s1",
				"perm-3",
				"reject",
			);
		});

		it("propagates errors from client", async () => {
			client = makeStubClient({
				permission: {
					reply: vi.fn(async () => {
						throw new Error("permission expired");
					}),
					list: vi.fn(async () => []),
				},
			});
			adapter = new OpenCodeAdapter({ client });

			await expect(
				adapter.resolvePermission("s1", "bad-perm", "once"),
			).rejects.toThrow("permission expired");
		});
	});

	describe("resolveQuestion", () => {
		it("calls client.question.reply with id and converted answers", async () => {
			await adapter.resolveQuestion("s1", "q1", {
				choice: "yes",
			});

			expect(client.question.reply).toHaveBeenCalledWith("q1", [["yes"]]);
		});

		it("converts array answers to string arrays", async () => {
			await adapter.resolveQuestion("s1", "q2", {
				multi: ["a", "b", "c"],
			});

			expect(client.question.reply).toHaveBeenCalledWith("q2", [
				["a", "b", "c"],
			]);
		});

		it("handles multiple answer fields", async () => {
			await adapter.resolveQuestion("s1", "q3", {
				field1: "value1",
				field2: ["x", "y"],
			});

			expect(client.question.reply).toHaveBeenCalledWith("q3", [
				["value1"],
				["x", "y"],
			]);
		});

		it("propagates errors from client", async () => {
			client = makeStubClient({
				question: {
					reply: vi.fn(async () => {
						throw new Error("question expired");
					}),
					reject: vi.fn(async () => {}),
					list: vi.fn(async () => []),
				},
			});
			adapter = new OpenCodeAdapter({ client });

			await expect(
				adapter.resolveQuestion("s1", "bad-q", { answer: "yes" }),
			).rejects.toThrow("question expired");
		});
	});

	describe("shutdown", () => {
		it("resolves cleanly when no pending turns", async () => {
			await expect(adapter.shutdown()).resolves.not.toThrow();
		});

		it("rejects pending turns on shutdown", async () => {
			// Start a turn that won't be completed
			const turnPromise = adapter.sendTurn({
				sessionId: "s1",
				turnId: "t1",
				prompt: "hello",
				history: [],
				providerState: {},
				model: { providerId: "anthropic", modelId: "claude-sonnet" },
				workspaceRoot: "/tmp",
				eventSink: {
					push: vi.fn(),
					requestPermission: vi.fn(),
					requestQuestion: vi.fn(),
				},
				abortSignal: new AbortController().signal,
			});

			// Shutdown while turn is pending
			await adapter.shutdown();

			await expect(turnPromise).rejects.toThrow("shutdown");
		});
	});
});
