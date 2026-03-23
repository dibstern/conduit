# Tool Registry State Machine Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Replace ad-hoc tool state mutations with a centralized ToolRegistry that enforces forward-only transitions and provides dev-mode diagnostics.

**Architecture:** A `ToolRegistry` class owns the callID-to-UUID mapping and validates all state transitions against a forward-only table. Handlers in `chat.svelte.ts` become thin dispatchers that call registry methods, match the result, and apply mutations to `chatState.messages`. No component or server-side changes needed.

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Create ToolRegistry with transition enforcement

**Files:**
- Create: `src/lib/frontend/stores/tool-registry.ts`
- Test: `test/unit/stores/tool-registry.test.ts`

**Step 1: Write failing tests for the registry**

Create `test/unit/stores/tool-registry.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { createToolRegistry } from "../../../src/lib/frontend/stores/tool-registry.js";

describe("ToolRegistry", () => {
  // ── Happy path ──────────────────────────────────────────────────────────

  describe("forward transitions", () => {
    it("start() creates a new tool in pending state", () => {
      const reg = createToolRegistry();
      const result = reg.start("t1", "Read");
      expect(result.action).toBe("create");
      if (result.action !== "create") throw new Error("unreachable");
      expect(result.tool.status).toBe("pending");
      expect(result.tool.id).toBe("t1");
      expect(result.tool.name).toBe("Read");
      expect(result.tool.uuid).toBeTruthy();
    });

    it("executing() transitions pending -> running", () => {
      const reg = createToolRegistry();
      reg.start("t1", "Edit");
      const result = reg.executing("t1", { filePath: "/foo" });
      expect(result.action).toBe("update");
      if (result.action !== "update") throw new Error("unreachable");
      expect(result.tool.status).toBe("running");
      expect(result.tool.input).toEqual({ filePath: "/foo" });
    });

    it("complete() transitions running -> completed", () => {
      const reg = createToolRegistry();
      reg.start("t1", "Bash");
      reg.executing("t1", { command: "ls" });
      const result = reg.complete("t1", "file.txt", false);
      expect(result.action).toBe("update");
      if (result.action !== "update") throw new Error("unreachable");
      expect(result.tool.status).toBe("completed");
      expect(result.tool.result).toBe("file.txt");
      expect(result.tool.isError).toBe(false);
    });

    it("complete() transitions pending -> completed (skip running)", () => {
      const reg = createToolRegistry();
      reg.start("t1", "Read");
      const result = reg.complete("t1", "content", false);
      expect(result.action).toBe("update");
      if (result.action !== "update") throw new Error("unreachable");
      expect(result.tool.status).toBe("completed");
    });

    it("complete() with isError transitions to error state", () => {
      const reg = createToolRegistry();
      reg.start("t1", "Bash");
      reg.executing("t1", { command: "false" });
      const result = reg.complete("t1", "exit code 1", true);
      expect(result.action).toBe("update");
      if (result.action !== "update") throw new Error("unreachable");
      expect(result.tool.status).toBe("error");
      expect(result.tool.isError).toBe(true);
    });

    it("complete() carries truncation extras", () => {
      const reg = createToolRegistry();
      reg.start("t1", "Bash");
      reg.executing("t1");
      const result = reg.complete("t1", "data", false, {
        isTruncated: true,
        fullContentLength: 100000,
      });
      expect(result.action).toBe("update");
      if (result.action !== "update") throw new Error("unreachable");
      expect(result.tool.isTruncated).toBe(true);
      expect(result.tool.fullContentLength).toBe(100000);
    });
  });

  // ── Backward transitions rejected ───────────────────────────────────────

  describe("backward transitions", () => {
    it("rejects completed -> running", () => {
      const reg = createToolRegistry();
      reg.start("t1", "Edit");
      reg.executing("t1");
      reg.complete("t1", "ok", false);
      const result = reg.executing("t1", { filePath: "/bar" });
      expect(result.action).toBe("reject");
    });

    it("rejects error -> running", () => {
      const reg = createToolRegistry();
      reg.start("t1", "Bash");
      reg.executing("t1");
      reg.complete("t1", "fail", true);
      const result = reg.executing("t1");
      expect(result.action).toBe("reject");
    });

    it("rejects completed -> pending (duplicate start after complete)", () => {
      const reg = createToolRegistry();
      reg.start("t1", "Read");
      reg.complete("t1", "ok", false);
      // Second start for same ID — tool already in terminal state
      const result = reg.start("t1", "Read");
      expect(result.action).toBe("duplicate");
    });

    it("rejects running -> pending", () => {
      const reg = createToolRegistry();
      reg.start("t1", "Edit");
      reg.executing("t1");
      // A second start for the same ID while running
      const result = reg.start("t1", "Edit");
      expect(result.action).toBe("duplicate");
    });
  });

  // ── Orphan events ─────────────────────────────────────────────────────────

  describe("orphan events", () => {
    it("rejects executing() for unknown tool ID", () => {
      const reg = createToolRegistry();
      const result = reg.executing("unknown");
      expect(result.action).toBe("reject");
    });

    it("rejects complete() for unknown tool ID", () => {
      const reg = createToolRegistry();
      const result = reg.complete("unknown", "data", false);
      expect(result.action).toBe("reject");
    });
  });

  // ── Dedup ─────────────────────────────────────────────────────────────────

  describe("dedup", () => {
    it("duplicate start() returns duplicate action and re-registers UUID", () => {
      const reg = createToolRegistry();
      const first = reg.start("t1", "Read");
      const second = reg.start("t1", "Read");
      expect(second.action).toBe("duplicate");
      // UUID should still be retrievable
      expect(reg.getUuid("t1")).toBeTruthy();
    });
  });

  // ── finalizeAll ───────────────────────────────────────────────────────────

  describe("finalizeAll", () => {
    it("forces pending tools to completed and returns their indices", () => {
      const reg = createToolRegistry();
      const r1 = reg.start("t1", "Read");
      const r2 = reg.start("t2", "Edit");
      if (r1.action !== "create" || r2.action !== "create") throw new Error("unreachable");

      const messages = [
        { type: "user" as const, uuid: "u1", text: "hi" },
        r1.tool,
        r2.tool,
      ];
      const result = reg.finalizeAll(messages);
      expect(result.action).toBe("finalized");
      if (result.action !== "finalized") throw new Error("unreachable");
      expect(result.indices).toEqual([1, 2]);
    });

    it("forces running tools to completed", () => {
      const reg = createToolRegistry();
      reg.start("t1", "Bash");
      reg.executing("t1");

      const messages = [
        { type: "tool" as const, uuid: "x", id: "t1", name: "Bash", status: "running" as const },
      ];
      const result = reg.finalizeAll(messages);
      expect(result.action).toBe("finalized");
      if (result.action !== "finalized") throw new Error("unreachable");
      expect(result.indices).toEqual([0]);
    });

    it("returns none when all tools are terminal", () => {
      const reg = createToolRegistry();
      reg.start("t1", "Read");
      reg.complete("t1", "ok", false);

      const messages = [
        { type: "tool" as const, uuid: "x", id: "t1", name: "Read", status: "completed" as const },
      ];
      const result = reg.finalizeAll(messages);
      expect(result.action).toBe("none");
    });

    it("allows late tool_result after finalizeAll (updates terminal tool)", () => {
      const reg = createToolRegistry();
      reg.start("t1", "Edit");
      // finalizeAll forces to completed
      const messages = [
        { type: "tool" as const, uuid: "x", id: "t1", name: "Edit", status: "pending" as const },
      ];
      reg.finalizeAll(messages);
      // Late tool_result should still work — replaces forced completion with real result
      const result = reg.complete("t1", "real result", false);
      expect(result.action).toBe("update");
      if (result.action !== "update") throw new Error("unreachable");
      expect(result.tool.result).toBe("real result");
    });
  });

  // ── clear ─────────────────────────────────────────────────────────────────

  describe("clear", () => {
    it("resets all state", () => {
      const reg = createToolRegistry();
      reg.start("t1", "Read");
      reg.clear();
      expect(reg.getUuid("t1")).toBeUndefined();
    });
  });

  // ── getUuid ───────────────────────────────────────────────────────────────

  describe("getUuid", () => {
    it("returns uuid for known tool", () => {
      const reg = createToolRegistry();
      const result = reg.start("t1", "Read");
      if (result.action !== "create") throw new Error("unreachable");
      expect(reg.getUuid("t1")).toBe(result.tool.uuid);
    });

    it("returns undefined for unknown tool", () => {
      const reg = createToolRegistry();
      expect(reg.getUuid("nope")).toBeUndefined();
    });
  });

  // ── Diagnostics ───────────────────────────────────────────────────────────

  describe("diagnostics", () => {
    it("calls log callback on rejected backward transition", () => {
      const log = vi.fn();
      const reg = createToolRegistry({ log });
      reg.start("t1", "Edit");
      reg.complete("t1", "ok", false);
      reg.executing("t1");
      expect(log).toHaveBeenCalledWith(
        "warn",
        expect.stringContaining("completed"),
      );
    });

    it("calls log callback on orphan event", () => {
      const log = vi.fn();
      const reg = createToolRegistry({ log });
      reg.executing("orphan");
      expect(log).toHaveBeenCalledWith(
        "warn",
        expect.stringContaining("orphan"),
      );
    });

    it("calls log callback on dedup", () => {
      const log = vi.fn();
      const reg = createToolRegistry({ log });
      reg.start("t1", "Read");
      reg.start("t1", "Read");
      expect(log).toHaveBeenCalledWith(
        "info",
        expect.stringContaining("Duplicate"),
      );
    });
  });

  // ── Metadata passthrough ──────────────────────────────────────────────────

  describe("metadata", () => {
    it("executing() stores metadata on tool", () => {
      const reg = createToolRegistry();
      reg.start("t1", "Task");
      const result = reg.executing("t1", undefined, { sessionId: "sub1" });
      expect(result.action).toBe("update");
      if (result.action !== "update") throw new Error("unreachable");
      expect(result.tool.metadata).toEqual({ sessionId: "sub1" });
    });

    it("start() stores messageId on tool", () => {
      const reg = createToolRegistry();
      const result = reg.start("t1", "Read", "msg_123");
      expect(result.action).toBe("create");
      if (result.action !== "create") throw new Error("unreachable");
      expect(result.tool.messageId).toBe("msg_123");
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/stores/tool-registry.test.ts`
Expected: FAIL — module `tool-registry.js` does not exist

**Step 3: Implement ToolRegistry**

Create `src/lib/frontend/stores/tool-registry.ts`:

```typescript
// ─── Tool Registry ──────────────────────────────────────────────────────────
// Centralized state machine for tool lifecycle transitions.
// Enforces forward-only transitions and provides dev-mode diagnostics.
//
// Valid transitions:
//   pending   -> running | completed | error
//   running   -> completed | error
//   completed -> (terminal — only complete() override accepted for late results)
//   error     -> (terminal)

import type { ToolStatus } from "../../shared-types.js";
import type { ChatMessage, ToolMessage } from "../types.js";
import { generateUuid } from "../utils/format.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TruncationExtras {
	isTruncated?: boolean;
	fullContentLength?: number;
}

export type ToolTransitionResult =
	| { action: "create"; tool: ToolMessage }
	| { action: "update"; uuid: string; tool: ToolMessage }
	| { action: "reject"; reason: string }
	| { action: "duplicate" };

export type FinalizationResult =
	| { action: "finalized"; indices: number[] }
	| { action: "none" };

type LogFn = (level: "info" | "warn", message: string) => void;

export interface ToolRegistryOptions {
	log?: LogFn;
	/** Override UUID generation (for testing). */
	uuidFn?: () => string;
}

export interface ToolRegistry {
	start(id: string, name: string, messageId?: string): ToolTransitionResult;
	executing(
		id: string,
		input?: unknown,
		metadata?: Record<string, unknown>,
	): ToolTransitionResult;
	complete(
		id: string,
		content: string,
		isError: boolean,
		extras?: TruncationExtras,
	): ToolTransitionResult;
	finalizeAll(messages: readonly ChatMessage[]): FinalizationResult;
	clear(): void;
	getUuid(callId: string): string | undefined;
}

// ─── Transition table ───────────────────────────────────────────────────────

/** Status values that each status can transition TO. */
const VALID_TRANSITIONS: Record<ToolStatus, ReadonlySet<ToolStatus>> = {
	pending: new Set(["running", "completed", "error"]),
	running: new Set(["completed", "error"]),
	completed: new Set(), // terminal
	error: new Set(), // terminal
};

const TERMINAL: ReadonlySet<ToolStatus> = new Set(["completed", "error"]);

function isTerminal(status: ToolStatus): boolean {
	return TERMINAL.has(status);
}

function canTransition(from: ToolStatus, to: ToolStatus): boolean {
	return VALID_TRANSITIONS[from].has(to);
}

// ─── Factory ────────────────────────────────────────────────────────────────

interface TrackedTool {
	uuid: string;
	status: ToolStatus;
	tool: ToolMessage;
}

export function createToolRegistry(options?: ToolRegistryOptions): ToolRegistry {
	const log: LogFn = options?.log ?? (() => {});
	const newUuid = options?.uuidFn ?? generateUuid;
	const tools = new Map<string, TrackedTool>();

	return {
		start(id, name, messageId) {
			const existing = tools.get(id);
			if (existing) {
				log(
					"info",
					`Duplicate tool_start for "${name}" (${id}), re-registered UUID.`,
				);
				return { action: "duplicate" };
			}

			const uuid = newUuid();
			const tool: ToolMessage = {
				type: "tool",
				uuid,
				id,
				name: name || "unknown",
				status: "pending",
				...(messageId != null && { messageId }),
			};
			tools.set(id, { uuid, status: "pending", tool });
			return { action: "create", tool };
		},

		executing(id, input, metadata) {
			const tracked = tools.get(id);
			if (!tracked) {
				log(
					"warn",
					`tool_executing for unknown tool ID "${id}". No matching tool_start received.`,
				);
				return {
					action: "reject",
					reason: `Unknown tool ID: ${id}`,
				};
			}

			if (!canTransition(tracked.status, "running")) {
				log(
					"warn",
					`Rejected transition: tool "${tracked.tool.name}" (${id}) ${tracked.status} -> running.`,
				);
				return {
					action: "reject",
					reason: `Cannot transition ${tracked.status} -> running`,
				};
			}

			const updated: ToolMessage = {
				...tracked.tool,
				status: "running",
				input,
				...(metadata != null && { metadata }),
			};
			tracked.status = "running";
			tracked.tool = updated;
			return { action: "update", uuid: tracked.uuid, tool: updated };
		},

		complete(id, content, isError, extras) {
			const tracked = tools.get(id);
			if (!tracked) {
				log(
					"warn",
					`tool_result for unknown tool ID "${id}". No matching tool_start received.`,
				);
				return {
					action: "reject",
					reason: `Unknown tool ID: ${id}`,
				};
			}

			const targetStatus: ToolStatus = isError ? "error" : "completed";

			// Special case: allow complete() on an already-terminal tool.
			// This happens when handleDone force-finalizes a tool and a late
			// SSE tool_result arrives with the real result content.
			// We allow the update so the UI gets the actual result text.
			if (
				isTerminal(tracked.status) &&
				!canTransition(tracked.status, targetStatus)
			) {
				// Still allow if it's a complete->complete override (late result)
				if (tracked.status === "completed" && targetStatus === "completed") {
					const updated: ToolMessage = {
						...tracked.tool,
						status: "completed",
						result: content,
						isError: false,
						...(extras?.isTruncated != null && {
							isTruncated: extras.isTruncated,
						}),
						...(extras?.fullContentLength != null && {
							fullContentLength: extras.fullContentLength,
						}),
					};
					tracked.tool = updated;
					return { action: "update", uuid: tracked.uuid, tool: updated };
				}

				log(
					"warn",
					`Rejected transition: tool "${tracked.tool.name}" (${id}) ${tracked.status} -> ${targetStatus}.`,
				);
				return {
					action: "reject",
					reason: `Cannot transition ${tracked.status} -> ${targetStatus}`,
				};
			}

			if (
				!isTerminal(tracked.status) &&
				!canTransition(tracked.status, targetStatus)
			) {
				log(
					"warn",
					`Rejected transition: tool "${tracked.tool.name}" (${id}) ${tracked.status} -> ${targetStatus}.`,
				);
				return {
					action: "reject",
					reason: `Cannot transition ${tracked.status} -> ${targetStatus}`,
				};
			}

			const updated: ToolMessage = {
				...tracked.tool,
				status: targetStatus,
				result: content,
				isError: isError ?? false,
				...(extras?.isTruncated != null && {
					isTruncated: extras.isTruncated,
				}),
				...(extras?.fullContentLength != null && {
					fullContentLength: extras.fullContentLength,
				}),
			};
			tracked.status = targetStatus;
			tracked.tool = updated;
			return { action: "update", uuid: tracked.uuid, tool: updated };
		},

		finalizeAll(messages) {
			const indices: number[] = [];
			for (let i = 0; i < messages.length; i++) {
				const m = messages[i]!;
				if (
					m.type === "tool" &&
					(m.status === "pending" || m.status === "running")
				) {
					indices.push(i);
					// Update internal tracking so late events can still override
					const tracked = tools.get(m.id);
					if (tracked) {
						tracked.status = "completed";
						tracked.tool = { ...tracked.tool, status: "completed" };
					}
				}
			}
			if (indices.length === 0) return { action: "none" };
			return { action: "finalized", indices };
		},

		clear() {
			tools.clear();
		},

		getUuid(callId) {
			return tools.get(callId)?.uuid;
		},
	};
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/stores/tool-registry.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/lib/frontend/stores/tool-registry.ts test/unit/stores/tool-registry.test.ts
git commit -m "feat: add ToolRegistry with forward-only state machine and diagnostics"
```

---

### Task 2: Wire ToolRegistry into chat.svelte.ts

**Files:**
- Modify: `src/lib/frontend/stores/chat.svelte.ts:102-103` (delete `toolUuidMap`), `:210-321` (rewrite tool handlers), `:401-459` (rewrite `handleDone`), `:620-635` (update `clearMessages`)
- Modify: `src/lib/frontend/stores/ws-dispatch.ts:518-536` (update `handleToolContentResponse`)
- Existing tests: `test/unit/stores/chat-store.test.ts`

**Step 1: Run existing tests to establish baseline**

Run: `pnpm vitest run test/unit/stores/chat-store.test.ts`
Expected: All PASS (baseline before refactor)

**Step 2: Add helper functions and instantiate registry in chat.svelte.ts**

At the top of `chat.svelte.ts`, after existing imports (around line 17), add:

```typescript
import {
	createToolRegistry,
	type ToolTransitionResult,
} from "./tool-registry.js";
```

Replace `toolUuidMap` declaration (line 102-103) with:

```typescript
/** Centralized tool lifecycle state machine. Enforces forward-only transitions. */
const registry = createToolRegistry({
	log: import.meta.env.DEV
		? (level, message) => {
				if (level === "warn") console.warn(`[ToolRegistry] ${message}`);
				else console.debug(`[ToolRegistry] ${message}`);
			}
		: undefined,
});
```

Add shared mutation helpers after the registry declaration:

```typescript
/** Append a new tool message to chatState.messages. */
function applyToolCreate(tool: ToolMessage): void {
	chatState.messages = [...chatState.messages, tool];
}

/** Replace a tool message in chatState.messages by UUID. */
function applyToolUpdate(uuid: string, tool: ToolMessage): void {
	const messages = [...chatState.messages];
	const found = findMessage(messages, "tool", (m) => m.uuid === uuid);
	if (found) {
		messages[found.index] = tool;
		chatState.messages = messages;
	}
}
```

**Step 3: Rewrite handleToolStart**

Replace lines 210-277 of `handleToolStart` with:

```typescript
export function handleToolStart(
	msg: Extract<RelayMessage, { type: "tool_start" }>,
): void {
	const { id, name, messageId } = msg;

	const result = registry.start(id, name, messageId);

	if (result.action === "duplicate") {
		return;
	}

	if (result.action !== "create") {
		return;
	}

	// ── Finalize current assistant text before inserting tool ──────────
	if (chatState.streaming && chatState.currentAssistantText) {
		if (renderTimer !== null) {
			clearTimeout(renderTimer);
			renderTimer = null;
		}
		flushAssistantRender();

		const messages = [...chatState.messages];
		for (let i = messages.length - 1; i >= 0; i--) {
			// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
			const m = messages[i]!;
			if (m.type === "assistant" && !m.finalized) {
				messages[i] = {
					...m,
					finalized: true,
				};
				chatState.messages = messages;
				break;
			}
		}

		chatState.streaming = false;
		chatState.currentAssistantText = "";
	}

	applyToolCreate(result.tool);
}
```

**Step 4: Rewrite handleToolExecuting**

Replace lines 279-297 with:

```typescript
export function handleToolExecuting(
	msg: Extract<RelayMessage, { type: "tool_executing" }>,
): void {
	const result = registry.executing(msg.id, msg.input, msg.metadata);
	if (result.action === "update") {
		applyToolUpdate(result.uuid, result.tool);
	}
}
```

**Step 5: Rewrite handleToolResult**

Replace lines 299-321 with:

```typescript
export function handleToolResult(
	msg: Extract<RelayMessage, { type: "tool_result" }>,
): void {
	const result = registry.complete(msg.id, msg.content, msg.is_error, {
		...(msg.isTruncated != null && { isTruncated: msg.isTruncated }),
		...(msg.fullContentLength != null && {
			fullContentLength: msg.fullContentLength,
		}),
	});
	if (result.action === "update") {
		applyToolUpdate(result.uuid, result.tool);
	}
}
```

**Step 6: Rewrite handleDone tool finalization**

Replace the tool finalization block in `handleDone` (lines 433-451) with:

```typescript
	// Finalize any tools still in non-terminal states (pending/running).
	const finResult = registry.finalizeAll(chatState.messages);
	if (finResult.action === "finalized") {
		const messages = [...chatState.messages];
		for (const idx of finResult.indices) {
			// biome-ignore lint/style/noNonNullAssertion: safe — index from finalizeAll
			const m = messages[idx]!;
			if (m.type === "tool") {
				messages[idx] = { ...m, status: "completed" };
			}
		}
		chatState.messages = messages;
	}

	chatState.streaming = false;
	chatState.processing = false;
	chatState.currentAssistantText = "";
```

**Step 7: Update clearMessages**

In `clearMessages` (line 626), replace `toolUuidMap.clear()` with `registry.clear()`.

**Step 8: Update handleToolContentResponse in ws-dispatch.ts**

In `ws-dispatch.ts`, update `handleToolContentResponse` (lines 518-536). Add an import for the registry at the top of the file (the registry instance should be exported from `chat.svelte.ts` or accessed via a getter). Since the registry is module-private in `chat.svelte.ts`, add a thin export:

In `chat.svelte.ts`, add after the registry declaration:

```typescript
/** Look up frontend UUID for a tool callID. Used by ws-dispatch for tool content. */
export function getToolUuid(callId: string): string | undefined {
	return registry.getUuid(callId);
}
```

Then in `ws-dispatch.ts`, update `handleToolContentResponse` to use the UUID-based lookup:

```typescript
function handleToolContentResponse(
	msg: Extract<RelayMessage, { type: "tool_content" }>,
): void {
	const { toolId, content } = msg;
	const messages = [...chatState.messages];
	const found = findMessage(messages, "tool", (m) => m.id === toolId);
	if (found) {
		chatState.messages = messages.map((m, i) => {
			if (i !== found.index) return m;
			const updated: ToolMessage = {
				...found.message,
				result: content,
				isTruncated: false,
			};
			delete updated.fullContentLength;
			return updated;
		});
	}
}
```

Note: This handler doesn't change the tool *status*, so it doesn't go through the registry. It only replaces truncated result content. The existing implementation is fine — no registry involvement needed here. Leave it as-is.

**Step 9: Run existing chat-store tests**

Run: `pnpm vitest run test/unit/stores/chat-store.test.ts`
Expected: All PASS — behavior is identical, only internal wiring changed.

**Step 10: Run full unit test suite**

Run: `pnpm test:unit`
Expected: All PASS

**Step 11: Run type checking and lint**

Run: `pnpm check && pnpm lint`
Expected: Clean (no new errors in changed files)

**Step 12: Commit**

```bash
git add src/lib/frontend/stores/chat.svelte.ts src/lib/frontend/stores/tool-registry.ts
git commit -m "refactor: wire ToolRegistry into chat store, replace ad-hoc tool mutations"
```

---

### Task 3: Remove the earlier handleDone hotfix

**Files:**
- Verify: `src/lib/frontend/stores/chat.svelte.ts` — confirm the old `toolUuidMap.clear()` removal and force-finalization logic from the hotfix is now fully replaced by the registry

**Step 1: Verify no references to toolUuidMap remain**

Run: `grep -rn "toolUuidMap" src/lib/frontend/`
Expected: Zero matches — the map has been completely replaced by the registry.

**Step 2: Run full verification**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: All clean, all pass.

**Step 3: Commit (if any cleanup was needed)**

```bash
git add -A
git commit -m "chore: remove toolUuidMap remnants after ToolRegistry migration"
```

---

## Amendments (from audit)

### Amendment A1: Fix log message in `start()` (Task 1)

Change the duplicate log message from:
```typescript
log("info", `Duplicate tool_start for "${name}" (${id}), re-registered UUID.`);
```
To:
```typescript
log("info", `Duplicate tool_start for "${name}" (${id}), existing entry retained.`);
```

Update dedup test name from `"duplicate start() returns duplicate action and re-registers UUID"` to `"duplicate start() returns duplicate action and retains existing entry"`.

### Amendment A2: Remove dead code in `complete()` (Task 1)

Remove the second guard block:
```typescript
if (!isTerminal(tracked.status) && !canTransition(tracked.status, targetStatus)) { ... }
```
This is unreachable — `canTransition` always returns true for non-terminal states transitioning to `completed` or `error`.

### Amendment A3: Expand `complete()` override to allow late errors (Task 1)

Change the override condition in `complete()` from:
```typescript
if (tracked.status === "completed" && targetStatus === "completed") {
```
To:
```typescript
if (tracked.status === "completed") {
```

This allows `completed -> error` overrides (late error results after `finalizeAll`), not just `completed -> completed`. The override block already handles the update correctly for both cases.

### Amendment A4: Fix `finalizeAll` test fixtures (Task 1)

Replace hand-crafted tool objects with registry-returned tools in three `finalizeAll` tests. Example:

```typescript
it("forces running tools to completed", () => {
    const reg = createToolRegistry();
    const r1 = reg.start("t1", "Bash");
    const r2 = reg.executing("t1");
    if (r1.action !== "create" || r2.action !== "update") throw new Error("unreachable");
    const messages: ChatMessage[] = [r2.tool];
    const result = reg.finalizeAll(messages);
    expect(result.action).toBe("finalized");
    if (result.action !== "finalized") throw new Error("unreachable");
    expect(result.indices).toEqual([0]);
});
```

### Amendment A5: Add missing tests (Task 1)

Add test for `uuidFn`:
```typescript
it("uses custom uuidFn when provided", () => {
    let counter = 0;
    const reg = createToolRegistry({ uuidFn: () => `uuid-${++counter}` });
    const r1 = reg.start("t1", "Read");
    const r2 = reg.start("t2", "Edit");
    if (r1.action !== "create" || r2.action !== "create") throw new Error("unreachable");
    expect(r1.tool.uuid).toBe("uuid-1");
    expect(r2.tool.uuid).toBe("uuid-2");
});
```

Add test for `finalizeAll` with unregistered tools:
```typescript
it("handles tool messages not in the registry (from history)", () => {
    const reg = createToolRegistry();
    const messages: ChatMessage[] = [
        { type: "tool", uuid: "hist-1", id: "hist-tool", name: "Read", status: "pending" },
    ];
    const result = reg.finalizeAll(messages);
    expect(result.action).toBe("finalized");
    if (result.action !== "finalized") throw new Error("unreachable");
    expect(result.indices).toEqual([0]);
    expect(reg.getUuid("hist-tool")).toBeUndefined();
});
```

Add test for late error result after `finalizeAll`:
```typescript
it("allows late error result after finalizeAll", () => {
    const reg = createToolRegistry();
    reg.start("t1", "Edit");
    const messages: ChatMessage[] = [
        { type: "tool", uuid: "x", id: "t1", name: "Edit", status: "pending" },
    ];
    reg.finalizeAll(messages);
    const result = reg.complete("t1", "error msg", true);
    expect(result.action).toBe("update");
    if (result.action !== "update") throw new Error("unreachable");
    expect(result.tool.status).toBe("error");
    expect(result.tool.isError).toBe(true);
});
```

### Amendment A6: Expand handleDone replacement range (Task 2, Step 6)

Replace lines 433-458 (through the closing brace of `handleDone`), not just 433-451. This removes the stale `// Do NOT clear toolUuidMap` comment and avoids duplicated assignments.

### Amendment A7: Update failing test (Task 2)

Update the test at `chat-store.test.ts:313-342` ("re-registers uuid in toolUuidMap after duplicate tool_start so tool_executing still works") to match new registry semantics:

- Rename to: `"after handleDone, duplicate tool_start is ignored and tool stays completed"`
- Update assertions to expect `status: "completed"` (not `"running"`)
- Remove `toolUuidMap` from the test name/comments

### Amendment A8: Widen Task 3 grep scope

Change Task 3 Step 1 from:
```bash
grep -rn "toolUuidMap" src/lib/frontend/
```
To:
```bash
grep -rn "toolUuidMap" src/ test/
```

### Amendment A9: Remove dead `getToolUuid` export (Task 2)

Remove Step 9's `getToolUuid` export from `chat.svelte.ts` since `handleToolContentResponse` doesn't need it (confirmed by audit). Dead code.

### Amendment A10: Add `remove(id)` method to registry (Task 1)

Add a `remove(id: string): void` method to the `ToolRegistry` interface that deletes the entry from the internal map. Call it from `handlePartRemoved` in `chat.svelte.ts` (Task 2).

```typescript
remove(id) {
    tools.delete(id);
},
```
