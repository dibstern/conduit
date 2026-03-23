// ─── Tool Registry Tests ─────────────────────────────────────────────────────
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createToolRegistry,
	type ToolRegistry,
} from "../../../src/lib/frontend/stores/tool-registry.js";
import type { ChatMessage } from "../../../src/lib/frontend/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

let seq = 0;
const testUuid = () => `uuid-${++seq}`;

let log: ReturnType<typeof vi.fn>;
let registry: ToolRegistry;

beforeEach(() => {
	seq = 0;
	log = vi.fn();
	registry = createToolRegistry({ log, uuidFn: testUuid });
});

// ─── Forward Transitions ────────────────────────────────────────────────────

describe("forward transitions", () => {
	it("start() creates a pending tool", () => {
		const result = registry.start("call-1", "Read");
		expect(result.action).toBe("create");
		if (result.action !== "create") throw new Error("unreachable");
		expect(result.tool.type).toBe("tool");
		expect(result.tool.id).toBe("call-1");
		expect(result.tool.name).toBe("Read");
		expect(result.tool.status).toBe("pending");
		expect(result.tool.uuid).toBe("uuid-1");
	});

	it("executing() transitions pending to running", () => {
		registry.start("call-1", "Bash");
		const result = registry.executing("call-1", { command: "ls" });
		expect(result.action).toBe("update");
		if (result.action !== "update") throw new Error("unreachable");
		expect(result.tool.status).toBe("running");
		expect(result.tool.input).toEqual({ command: "ls" });
	});

	it("complete() transitions running to completed", () => {
		registry.start("call-1", "Read");
		registry.executing("call-1");
		const result = registry.complete("call-1", "file contents", false);
		expect(result.action).toBe("update");
		if (result.action !== "update") throw new Error("unreachable");
		expect(result.tool.status).toBe("completed");
		expect(result.tool.result).toBe("file contents");
		expect(result.tool.isError).toBe(false);
	});

	it("complete() with isError transitions to error", () => {
		registry.start("call-1", "Bash");
		registry.executing("call-1");
		const result = registry.complete("call-1", "command failed", true);
		expect(result.action).toBe("update");
		if (result.action !== "update") throw new Error("unreachable");
		expect(result.tool.status).toBe("error");
		expect(result.tool.result).toBe("command failed");
		expect(result.tool.isError).toBe(true);
	});

	it("complete() skips running (pending -> completed)", () => {
		registry.start("call-1", "Glob");
		const result = registry.complete("call-1", "*.ts", false);
		expect(result.action).toBe("update");
		if (result.action !== "update") throw new Error("unreachable");
		expect(result.tool.status).toBe("completed");
	});

	it("complete() stores truncation extras", () => {
		registry.start("call-1", "Read");
		registry.executing("call-1");
		const result = registry.complete("call-1", "data...", false, {
			isTruncated: true,
			fullContentLength: 10000,
		});
		expect(result.action).toBe("update");
		if (result.action !== "update") throw new Error("unreachable");
		expect(result.tool.isTruncated).toBe(true);
		expect(result.tool.fullContentLength).toBe(10000);
	});
});

// ─── Backward Transitions Rejected ──────────────────────────────────────────

describe("backward transitions rejected", () => {
	it("rejects completed -> running", () => {
		registry.start("call-1", "Read");
		registry.complete("call-1", "done", false);
		const result = registry.executing("call-1");
		expect(result.action).toBe("reject");
	});

	it("rejects error -> running", () => {
		registry.start("call-1", "Bash");
		registry.executing("call-1");
		registry.complete("call-1", "fail", true);
		const result = registry.executing("call-1");
		expect(result.action).toBe("reject");
	});

	it("duplicate start after complete returns duplicate", () => {
		registry.start("call-1", "Read");
		registry.complete("call-1", "done", false);
		const result = registry.start("call-1", "Read");
		expect(result.action).toBe("duplicate");
	});

	it("duplicate start while running returns duplicate", () => {
		registry.start("call-1", "Bash");
		registry.executing("call-1");
		const result = registry.start("call-1", "Bash");
		expect(result.action).toBe("duplicate");
	});
});

// ─── Orphan Events ──────────────────────────────────────────────────────────

describe("orphan events", () => {
	it("executing unknown ID returns reject", () => {
		const result = registry.executing("unknown-1");
		expect(result.action).toBe("reject");
	});

	it("complete unknown ID returns reject", () => {
		const result = registry.complete("unknown-1", "data", false);
		expect(result.action).toBe("reject");
	});
});

// ─── Dedup ──────────────────────────────────────────────────────────────────

describe("dedup", () => {
	it("duplicate start() returns duplicate action and retains existing entry", () => {
		registry.start("call-1", "Read");
		const second = registry.start("call-1", "Read");
		expect(second.action).toBe("duplicate");

		// Existing entry is still usable
		const execResult = registry.executing("call-1");
		expect(execResult.action).toBe("update");
		if (execResult.action !== "update") throw new Error("unreachable");
		expect(execResult.tool.uuid).toBe("uuid-1"); // original UUID retained
	});
});

// ─── finalizeAll ────────────────────────────────────────────────────────────

describe("finalizeAll", () => {
	it("forces pending to completed", () => {
		registry.start("call-1", "Read");
		const messages: ChatMessage[] = [
			{
				type: "tool",
				uuid: "uuid-1",
				id: "call-1",
				name: "Read",
				status: "pending",
			},
		];
		const result = registry.finalizeAll(messages);
		expect(result.action).toBe("finalized");
		if (result.action !== "finalized") throw new Error("unreachable");
		expect(result.indices).toEqual([0]);
	});

	it("forces running to completed", () => {
		registry.start("call-1", "Bash");
		registry.executing("call-1");
		const messages: ChatMessage[] = [
			{ type: "user", uuid: "u1", text: "hi" },
			{
				type: "tool",
				uuid: "uuid-1",
				id: "call-1",
				name: "Bash",
				status: "running",
			},
		];
		const result = registry.finalizeAll(messages);
		expect(result.action).toBe("finalized");
		if (result.action !== "finalized") throw new Error("unreachable");
		expect(result.indices).toEqual([1]);
	});

	it("returns none when all terminal", () => {
		registry.start("call-1", "Read");
		registry.complete("call-1", "ok", false);
		const messages: ChatMessage[] = [
			{
				type: "tool",
				uuid: "uuid-1",
				id: "call-1",
				name: "Read",
				status: "completed",
				result: "ok",
			},
		];
		const result = registry.finalizeAll(messages);
		expect(result.action).toBe("none");
	});

	it("allows late complete() after finalizeAll", () => {
		registry.start("call-1", "Read");
		const messages: ChatMessage[] = [
			{
				type: "tool",
				uuid: "uuid-1",
				id: "call-1",
				name: "Read",
				status: "pending",
			},
		];
		registry.finalizeAll(messages);

		// Late SSE result arrives
		const result = registry.complete("call-1", "actual content", false);
		expect(result.action).toBe("update");
		if (result.action !== "update") throw new Error("unreachable");
		expect(result.tool.status).toBe("completed");
		expect(result.tool.result).toBe("actual content");
	});

	it("allows late error result after finalizeAll", () => {
		registry.start("call-1", "Bash");
		registry.executing("call-1");
		const messages: ChatMessage[] = [
			{
				type: "tool",
				uuid: "uuid-1",
				id: "call-1",
				name: "Bash",
				status: "running",
			},
		];
		registry.finalizeAll(messages);

		// Late SSE error arrives
		const result = registry.complete("call-1", "command not found", true);
		expect(result.action).toBe("update");
		if (result.action !== "update") throw new Error("unreachable");
		expect(result.tool.status).toBe("error");
		expect(result.tool.isError).toBe(true);
	});

	it("handles unregistered tools from history gracefully", () => {
		// Tools from history are not in the registry — finalizeAll should skip them
		const messages: ChatMessage[] = [
			{
				type: "tool",
				uuid: "hist-1",
				id: "old-call",
				name: "Read",
				status: "pending",
			},
		];
		const result = registry.finalizeAll(messages);
		// Should still report finalized for the index (it found a pending tool message)
		expect(result.action).toBe("finalized");
		if (result.action !== "finalized") throw new Error("unreachable");
		expect(result.indices).toEqual([0]);
	});
});

// ─── clear ──────────────────────────────────────────────────────────────────

describe("clear", () => {
	it("resets all state", () => {
		registry.start("call-1", "Read");
		registry.start("call-2", "Bash");
		registry.clear();

		expect(registry.getUuid("call-1")).toBeUndefined();
		expect(registry.getUuid("call-2")).toBeUndefined();
	});
});

// ─── remove ─────────────────────────────────────────────────────────────────

describe("remove", () => {
	it("removes a single entry", () => {
		registry.start("call-1", "Read");
		registry.start("call-2", "Bash");
		registry.remove("call-1");

		expect(registry.getUuid("call-1")).toBeUndefined();
		expect(registry.getUuid("call-2")).toBe("uuid-2");
	});
});

// ─── getUuid ────────────────────────────────────────────────────────────────

describe("getUuid", () => {
	it("returns uuid for known tool", () => {
		registry.start("call-1", "Read");
		expect(registry.getUuid("call-1")).toBe("uuid-1");
	});

	it("returns undefined for unknown tool", () => {
		expect(registry.getUuid("nonexistent")).toBeUndefined();
	});
});

// ─── Diagnostics ────────────────────────────────────────────────────────────

describe("diagnostics", () => {
	it("logs warn on backward rejection", () => {
		registry.start("call-1", "Read");
		registry.complete("call-1", "done", false);
		registry.executing("call-1");

		expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("call-1"));
	});

	it("logs warn on orphan event", () => {
		registry.executing("orphan-1");
		expect(log).toHaveBeenCalledWith(
			"warn",
			expect.stringContaining("orphan-1"),
		);
	});

	it("logs info on dedup", () => {
		registry.start("call-1", "Read");
		registry.start("call-1", "Read");

		expect(log).toHaveBeenCalledWith(
			"info",
			expect.stringContaining("Duplicate tool_start"),
		);
	});
});

// ─── Metadata ───────────────────────────────────────────────────────────────

describe("metadata", () => {
	it("executing stores metadata", () => {
		registry.start("call-1", "Task");
		const result = registry.executing(
			"call-1",
			{ prompt: "do stuff" },
			{ sessionId: "sub-1" },
		);
		expect(result.action).toBe("update");
		if (result.action !== "update") throw new Error("unreachable");
		expect(result.tool.metadata).toEqual({ sessionId: "sub-1" });
	});

	it("start stores messageId", () => {
		const result = registry.start("call-1", "Read", "msg-42");
		expect(result.action).toBe("create");
		if (result.action !== "create") throw new Error("unreachable");
		expect(result.tool.messageId).toBe("msg-42");
	});
});

// ─── uuidFn ─────────────────────────────────────────────────────────────────

describe("uuidFn", () => {
	it("custom uuidFn produces deterministic UUIDs", () => {
		let counter = 100;
		const customRegistry = createToolRegistry({
			log,
			uuidFn: () => `custom-${++counter}`,
		});

		const r1 = customRegistry.start("a", "Read");
		const r2 = customRegistry.start("b", "Bash");
		if (r1.action !== "create" || r2.action !== "create")
			throw new Error("unreachable");
		expect(r1.tool.uuid).toBe("custom-101");
		expect(r2.tool.uuid).toBe("custom-102");
	});
});
