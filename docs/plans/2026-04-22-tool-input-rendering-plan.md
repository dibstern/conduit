# Tool Input Rendering Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Re-architect the tool rendering pipeline so tool inputs are normalized at the adapter boundary, streamed as a single `tool.started` with complete input, and rendered through a per-tool summarizer registry.

**Architecture:** Four phases landing in order (0 → 1 → 2 → 3), each a separate PR. Phase 0 adds a type-level guardrail to `translateCanonicalEvent`. Phase 1 introduces `CanonicalToolInput` at the adapter seam. Phase 2 buffers Claude tool_use blocks and deletes `tool.input_updated`. Phase 3 replaces the `extractToolSummary` switch with a per-tool summarizer registry.

**Tech Stack:** TypeScript, Svelte 5, Vitest, pnpm

**Design doc:** [`docs/plans/2026-04-19-tool-input-rendering-design.md`](./2026-04-19-tool-input-rendering-design.md)

**Dependencies:** Phase 0 is standalone. Phases 1–3 depend on the per-session-chat-state refactor landing first ([`2026-04-19-session-chat-state-per-session-plan.md`](./2026-04-19-session-chat-state-per-session-plan.md)) because Phase 3 reads `toolRegistry` from `SessionChatState`. **Within this plan:** Phase 2 (Tasks 9–11) depends on Phase 1 (Tasks 4+6) because `handleBlockStop` calls `normalizeToolInput` — Tasks 4+6 must land before Task 9.

---

## Verification Commands

```bash
pnpm check          # type-check
pnpm lint           # biome lint
pnpm test:unit      # all unit tests
# Single file:
pnpm vitest run <path>
```

---

## Phase 0 — Translator Return Type Guardrail

### Task 1: Define `TranslationResult` type and refactor `translateCanonicalEvent`

**Files:**
- Modify: `src/lib/provider/relay-event-sink.ts:231-380`
- Test: `test/unit/provider/relay-event-sink-translation-shape.test.ts` (create)

**Step 1: Write the failing test**

Create `test/unit/provider/relay-event-sink-translation-shape.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { CanonicalEvent } from "../../../src/lib/persistence/events.js";

// We need to test translateCanonicalEvent directly. It's currently a
// module-private function. We'll export it in step 3 and import here.
// For now, test through the public createRelayEventSink.push() surface.

function makeEvent<T extends CanonicalEvent["type"]>(
	type: T,
	data: Extract<CanonicalEvent, { type: T }>["data"],
	metadata: Record<string, unknown> = {},
): CanonicalEvent {
	return {
		eventId: `evt_test`,
		sessionId: "ses-1",
		type,
		data,
		metadata,
		provider: "claude",
		createdAt: Date.now(),
	} as CanonicalEvent;
}

describe("translateCanonicalEvent — TranslationResult shape", () => {
	// Payload-carrying events MUST produce { kind: "emit", messages: [...] }
	// with at least one message.
	const EMIT_CASES: Array<{
		type: CanonicalEvent["type"];
		data: Record<string, unknown>;
		meta?: Record<string, unknown>;
		expectedTypes: string[];
	}> = [
		{ type: "text.delta", data: { messageId: "m", partId: "p", text: "x" }, expectedTypes: ["delta"] },
		{ type: "thinking.start", data: { messageId: "m", partId: "p" }, expectedTypes: ["thinking_start"] },
		{ type: "thinking.delta", data: { messageId: "m", partId: "p", text: "x" }, expectedTypes: ["thinking_delta"] },
		{ type: "thinking.end", data: { messageId: "m", partId: "p" }, expectedTypes: ["thinking_stop"] },
		{
			type: "tool.started",
			data: { messageId: "m", partId: "p", toolName: "Bash", callId: "c", input: {} },
			expectedTypes: ["tool_start", "tool_executing"],
		},
		{
			type: "tool.completed",
			data: { messageId: "m", partId: "p", result: "ok", duration: 0 },
			expectedTypes: ["tool_result"],
		},
		{
			type: "tool.input_updated",
			data: { messageId: "m", partId: "c", input: { command: "ls" } },
			expectedTypes: ["tool_executing"],
		},
		{
			type: "turn.completed",
			data: { messageId: "m", tokens: { input: 1, output: 1 }, cost: 0, duration: 0 },
			expectedTypes: ["result", "done"],
		},
		{
			type: "turn.error",
			data: { messageId: "m", error: "boom", code: "err" },
			expectedTypes: ["error", "done"],
		},
		{ type: "turn.interrupted", data: { messageId: "m" }, expectedTypes: ["done"] },
		{
			type: "session.status",
			data: { sessionId: "s", status: "retry" },
			meta: { correlationId: "Retrying" },
			expectedTypes: ["error"],
		},
	];

	for (const { type, data, meta, expectedTypes } of EMIT_CASES) {
		it(`${type} returns kind=emit with correct message types`, async () => {
			const sent: Array<{ type: string }> = [];
			const { createRelayEventSink } = await import(
				"../../../src/lib/provider/relay-event-sink.js"
			);
			const sink = createRelayEventSink({
				sessionId: "ses-1",
				send: (msg: unknown) => sent.push(msg as { type: string }),
			});
			await sink.push(makeEvent(type, data as never, meta));
			expect(sent.map((m) => m.type)).toEqual(expectedTypes);
		});
	}

	// Intentionally-silent events MUST NOT produce relay messages.
	const SILENT_CASES: Array<{
		type: CanonicalEvent["type"];
		data: Record<string, unknown>;
	}> = [
		{ type: "tool.running", data: { messageId: "m", partId: "p" } },
		{ type: "session.status", data: { sessionId: "s", status: "idle" } },
		{ type: "session.status", data: { sessionId: "s", status: "busy" } },
		{ type: "session.status", data: { sessionId: "s", status: "error" } },
		{ type: "message.created", data: { messageId: "m", role: "assistant", sessionId: "s" } },
		{ type: "session.created", data: { sessionId: "s", title: "t", provider: "p" } },
		{ type: "session.renamed", data: { sessionId: "s", title: "t" } },
		{
			type: "session.provider_changed",
			data: { sessionId: "s", oldProvider: "a", newProvider: "b" },
		},
		{ type: "permission.asked", data: { id: "p", sessionId: "s", toolName: "Bash", input: {} } },
		{ type: "permission.resolved", data: { id: "p", decision: "once" } },
		{ type: "question.asked", data: { id: "q", sessionId: "s", questions: [] } },
		{ type: "question.resolved", data: { id: "q", answers: {} } },
	];

	for (const { type, data } of SILENT_CASES) {
		it(`${type} produces zero relay messages (silent)`, async () => {
			const sent: unknown[] = [];
			const { createRelayEventSink } = await import(
				"../../../src/lib/provider/relay-event-sink.js"
			);
			const sink = createRelayEventSink({
				sessionId: "ses-1",
				send: (msg: unknown) => sent.push(msg),
			});
			await sink.push(makeEvent(type, data as never));
			expect(sent).toHaveLength(0);
		});
	}
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/provider/relay-event-sink-translation-shape.test.ts`
Expected: PASS (this baseline test validates current behavior before the refactor — it should pass against the existing code).

> Note: The test will pass now because it tests through the public API. The refactor in step 3 changes the internal return type without changing observable behavior. The value is that if someone later changes a case to return `[]` when it shouldn't, this test catches it.

**Step 3: Introduce `TranslationResult` type and refactor `translateCanonicalEvent`**

In `src/lib/provider/relay-event-sink.ts`, add the type after line 20:

```ts
// ─── Translation Result ───────────────────────────────────────────────────

type TranslationResult =
	| { kind: "emit"; messages: import("../shared-types.js").UntaggedRelayMessage[] }
	| { kind: "silent"; reason: string };

function emit(
	...messages: import("../shared-types.js").UntaggedRelayMessage[]
): TranslationResult {
	return { kind: "emit", messages };
}

function silent(reason: string): TranslationResult {
	return { kind: "silent", reason };
}
```

Refactor `translateCanonicalEvent` (line 231) to return `TranslationResult`:

```ts
function translateCanonicalEvent(event: CanonicalEvent): TranslationResult {
	switch (event.type) {
		case "text.delta":
			return emit({
				type: "delta",
				text: event.data.text,
				messageId: event.data.messageId,
			});

		case "thinking.start":
			return emit({ type: "thinking_start", messageId: event.data.messageId });

		case "thinking.delta":
			return emit({
				type: "thinking_delta",
				text: event.data.text,
				messageId: event.data.messageId,
			});

		case "thinking.end":
			return emit({ type: "thinking_stop", messageId: event.data.messageId });

		case "tool.started": {
			const { toolName, callId, input, messageId } = event.data;
			return emit(
				{ type: "tool_start", id: callId, name: toolName, messageId },
				{
					type: "tool_executing",
					id: callId,
					name: toolName,
					input: isRecord(input) ? input : undefined,
					messageId,
				},
			);
		}

		case "tool.running":
			return silent(
				"ToolRunningPayload carries no callId; partId anchor already covered by tool.started",
			);

		case "tool.input_updated": {
			const { partId, input, messageId, toolName } = event.data;
			return emit({
				type: "tool_executing",
				id: partId,
				name: toolName ?? "",
				input: isRecord(input) ? input : undefined,
				messageId,
			});
		}

		case "tool.completed": {
			const { partId, result, messageId } = event.data;
			return emit({
				type: "tool_result",
				id: partId,
				content: typeof result === "string" ? result : stringify(result),
				is_error: false,
				messageId,
			});
		}

		case "turn.completed": {
			const { tokens, cost, duration } = event.data;
			return emit(
				{
					type: "result",
					usage: {
						input: tokens?.input ?? 0,
						output: tokens?.output ?? 0,
						cache_read: tokens?.cacheRead ?? 0,
						cache_creation: tokens?.cacheWrite ?? 0,
					},
					cost: cost ?? 0,
					duration: duration ?? 0,
					sessionId: event.sessionId,
				} satisfies RelayMessage,
				{ type: "done", code: 0 },
			);
		}

		case "turn.error": {
			const { error, code } = event.data;
			return emit(
				{ type: "error", code: code ?? "TURN_ERROR", message: error },
				{ type: "done", code: 1 },
			);
		}

		case "turn.interrupted":
			return emit({ type: "done", code: 1 });

		case "session.status":
			if (event.data.status === "retry") {
				const reason =
					typeof event.metadata.correlationId === "string"
						? event.metadata.correlationId
						: "Retrying";
				return emit({ type: "error", code: "RETRY", message: reason });
			}
			return silent(
				"prompt handler owns lifecycle; terminal done/error covers completion",
			);

		case "message.created":
		case "session.created":
		case "session.renamed":
		case "session.provider_changed":
			return silent("persistence-only event; no UI surface in relay");

		case "permission.asked":
		case "permission.resolved":
		case "question.asked":
		case "question.resolved":
			return silent(
				"handled via requestPermission/requestQuestion side-channel",
			);

		default:
			return silent("unhandled event type");
	}
}
```

Update the `push()` caller (line 112 area) to consume the discriminated union:

```ts
const result = translateCanonicalEvent(event);
if (result.kind === "emit") {
	for (const raw of result.messages) {
		const m = tagWithSessionId(raw, sessionId);
		send(m);
		const isTerminal =
			m.type === "done" || (m.type === "error" && m.code !== "RETRY");
		if (isTerminal) finish();
	}
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/provider/relay-event-sink-translation-shape.test.ts test/unit/provider/relay-event-sink.test.ts test/unit/provider/relay-event-sink-exhaustive.test.ts`
Expected: ALL PASS

**Step 5: Run full verification**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/provider/relay-event-sink.ts test/unit/provider/relay-event-sink-translation-shape.test.ts
git commit -m "refactor: introduce TranslationResult discriminated union for translateCanonicalEvent

Phase 0 of tool-input-rendering refactor. Every case in the translator now
returns either emit(...messages) or silent(reason), preventing the class of
bug where a new event type silently returns [] without a compiler signal."
```

---

### Task 2: Add stale-entry guard to exhaustive event type test

**Files:**
- Modify: `test/unit/provider/relay-event-sink-exhaustive.test.ts`

**Step 1: The failing test**

Rewrite `test/unit/provider/relay-event-sink-exhaustive.test.ts` to add a shape assertion. The existing test only checks that every type appears in a set — it doesn't verify behavioral output. We keep the set-membership check and add a new test that the shape test file already covers behavior:

```ts
import { describe, expect, it } from "vitest";
import { CANONICAL_EVENT_TYPES } from "../../../src/lib/persistence/events.js";

describe("relay-event-sink translateCanonicalEvent exhaustiveness", () => {
	// These are the event types handled in the switch statement.
	// Keep this list in sync with translateCanonicalEvent().
	const HANDLED_TYPES = new Set([
		"text.delta",
		"thinking.start",
		"thinking.delta",
		"thinking.end",
		"tool.started",
		"tool.running",
		"tool.input_updated",
		"tool.completed",
		"turn.completed",
		"turn.error",
		"turn.interrupted",
		"session.status",
		"message.created",
		"session.created",
		"session.renamed",
		"session.provider_changed",
		"permission.asked",
		"permission.resolved",
		"question.asked",
		"question.resolved",
	]);

	it("handles every canonical event type", () => {
		const missing = CANONICAL_EVENT_TYPES.filter((t) => !HANDLED_TYPES.has(t));
		expect(missing).toEqual([]);
	});

	it("HANDLED_TYPES does not contain stale entries", () => {
		const stale = [...HANDLED_TYPES].filter(
			(t) => !CANONICAL_EVENT_TYPES.includes(t as (typeof CANONICAL_EVENT_TYPES)[number]),
		);
		expect(stale).toEqual([]);
	});
});
```

**Step 2: Run test to verify it passes**

Run: `pnpm vitest run test/unit/provider/relay-event-sink-exhaustive.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add test/unit/provider/relay-event-sink-exhaustive.test.ts
git commit -m "test: add stale-entry check to exhaustive event type test"
```

---

## Phase 1 — Normalize Tool Inputs at the Adapter Boundary

### Task 3: Define `CanonicalToolInput` type and `schemaVersion` on `EventMetadata`

**Files:**
- Modify: `src/lib/persistence/events.ts:91-96,220-230`

**Step 1: Write the type definition**

After `ToolInputUpdatedPayload` (line 122), add the `CanonicalToolInput` discriminated union:

```ts
// ─── Canonical Tool Input ───────────────────────────────────────────────────
// Provider-agnostic tool input shape. Each adapter's normalizeToolInput()
// maps raw provider casing (snake_case, camelCase) into this canonical form.
// Unknown tools collapse to { tool: "Unknown" } — never lost, always renderable.

export type CanonicalToolInput =
	| { tool: "Read"; filePath: string; offset?: number; limit?: number }
	| { tool: "Edit"; filePath: string; oldString: string; newString: string; replaceAll?: boolean }
	| { tool: "Write"; filePath: string; content: string }
	| { tool: "Bash"; command: string; description?: string; timeoutMs?: number }
	| { tool: "Grep"; pattern: string; path?: string; include?: string; fileType?: string }
	| { tool: "Glob"; pattern: string; path?: string }
	| { tool: "WebFetch"; url: string; prompt?: string }
	| { tool: "WebSearch"; query: string }
	| { tool: "Task"; description: string; prompt: string; subagentType?: string }
	| { tool: "LSP"; operation: string; filePath?: string }
	| { tool: "Skill"; name: string }
	| { tool: "AskUserQuestion"; questions: unknown }
	| { tool: "Unknown"; name: string; raw: Record<string, unknown> };
```

Add `schemaVersion` to `EventMetadata` (line 220):

```ts
export interface EventMetadata {
	readonly commandId?: string;
	readonly causationEventId?: string;
	readonly correlationId?: string;
	readonly adapterKey?: string;
	readonly providerTurnId?: string;
	readonly synthetic?: boolean;
	readonly source?: string;
	readonly sseBatchId?: string;
	readonly sseBatchSize?: number;
	/** Schema version for event data shape migration. Events without this
	 *  field (or < 2) use raw provider-specific input shapes and need
	 *  normalizeToolInput() upcast at replay time. */
	readonly schemaVersion?: number;
}
```

**Step 2: Retype `ToolStartedPayload.input`**

In `src/lib/persistence/events.ts`, change `ToolStartedPayload.input` from `unknown` to `CanonicalToolInput | unknown`:

```ts
export interface ToolStartedPayload {
	readonly messageId: string;
	readonly partId: string;
	readonly toolName: string;
	readonly callId: string;
	readonly input: CanonicalToolInput | unknown;
}
```

> Note: The union `CanonicalToolInput | unknown` collapses to `unknown` at the type level, but signals intent. After all adapters are wired (Tasks 6-7), a follow-up can narrow to `CanonicalToolInput` once all emitters guarantee the canonical shape. For now, this documents the contract without breaking existing consumers.

**Step 3: Run type check**

Run: `pnpm check`
Expected: PASS (additive change — no consumers break)

**Step 4: Commit**

```bash
git add src/lib/persistence/events.ts
git commit -m "feat: add CanonicalToolInput type and schemaVersion to EventMetadata

Phase 1 foundation. CanonicalToolInput is a discriminated union of all known
tool input shapes. schemaVersion on EventMetadata enables replay-time upcast
of historical events stored with raw provider-specific input shapes."
```

---

### Task 4: Create Claude `normalizeToolInput`

**Files:**
- Create: `src/lib/provider/claude/normalize-tool-input.ts`
- Test: `test/unit/provider/claude/normalize-tool-input.test.ts` (create)

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { normalizeToolInput } from "../../../../src/lib/provider/claude/normalize-tool-input.js";

describe("Claude normalizeToolInput", () => {
	it("normalizes Read with snake_case input", () => {
		const result = normalizeToolInput("Read", {
			file_path: "/src/main.ts",
			offset: 10,
			limit: 50,
		});
		expect(result).toEqual({
			tool: "Read",
			filePath: "/src/main.ts",
			offset: 10,
			limit: 50,
		});
	});

	it("normalizes Read with camelCase input (passthrough)", () => {
		const result = normalizeToolInput("Read", {
			filePath: "/src/main.ts",
		});
		expect(result).toEqual({ tool: "Read", filePath: "/src/main.ts" });
	});

	it("normalizes Edit with snake_case input", () => {
		const result = normalizeToolInput("Edit", {
			file_path: "/f.ts",
			old_string: "a",
			new_string: "b",
			replace_all: true,
		});
		expect(result).toEqual({
			tool: "Edit",
			filePath: "/f.ts",
			oldString: "a",
			newString: "b",
			replaceAll: true,
		});
	});

	it("normalizes Write with snake_case input", () => {
		const result = normalizeToolInput("Write", {
			file_path: "/f.ts",
			content: "hello",
		});
		expect(result).toEqual({
			tool: "Write",
			filePath: "/f.ts",
			content: "hello",
		});
	});

	it("normalizes Bash with snake_case input", () => {
		const result = normalizeToolInput("Bash", {
			command: "ls -la",
			description: "list files",
			timeout: 5000,
		});
		expect(result).toEqual({
			tool: "Bash",
			command: "ls -la",
			description: "list files",
			timeoutMs: 5000,
		});
	});

	it("normalizes Grep with Claude SDK field names", () => {
		const result = normalizeToolInput("Grep", {
			pattern: "TODO",
			path: "/src",
			glob: "*.ts",
			type: "ts",
		});
		expect(result).toEqual({
			tool: "Grep",
			pattern: "TODO",
			path: "/src",
			include: "*.ts",
			fileType: "ts",
		});
	});

	it("normalizes Glob", () => {
		const result = normalizeToolInput("Glob", {
			pattern: "**/*.ts",
			path: "/src",
		});
		expect(result).toEqual({
			tool: "Glob",
			pattern: "**/*.ts",
			path: "/src",
		});
	});

	it("normalizes WebFetch", () => {
		const result = normalizeToolInput("WebFetch", {
			url: "https://example.com",
			prompt: "summarize",
		});
		expect(result).toEqual({
			tool: "WebFetch",
			url: "https://example.com",
			prompt: "summarize",
		});
	});

	it("normalizes WebSearch", () => {
		const result = normalizeToolInput("WebSearch", {
			query: "typescript generics",
		});
		expect(result).toEqual({ tool: "WebSearch", query: "typescript generics" });
	});

	it("normalizes Task with snake_case subagent_type", () => {
		const result = normalizeToolInput("Task", {
			description: "find bugs",
			prompt: "look for bugs in main.ts",
			subagent_type: "code-review",
		});
		expect(result).toEqual({
			tool: "Task",
			description: "find bugs",
			prompt: "look for bugs in main.ts",
			subagentType: "code-review",
		});
	});

	it("normalizes LSP with snake_case file_path", () => {
		const result = normalizeToolInput("LSP", {
			operation: "hover",
			file_path: "/src/main.ts",
		});
		expect(result).toEqual({
			tool: "LSP",
			operation: "hover",
			filePath: "/src/main.ts",
		});
	});

	it("normalizes Skill", () => {
		const result = normalizeToolInput("Skill", { name: "commit" });
		expect(result).toEqual({ tool: "Skill", name: "commit" });
	});

	it("normalizes AskUserQuestion", () => {
		const questions = [{ question: "Continue?", header: "Confirm" }];
		const result = normalizeToolInput("AskUserQuestion", { questions });
		expect(result).toEqual({ tool: "AskUserQuestion", questions });
	});

	it("collapses unknown tool to Unknown variant", () => {
		const result = normalizeToolInput("FutureTool", { foo: "bar", baz: 42 });
		expect(result).toEqual({
			tool: "Unknown",
			name: "FutureTool",
			raw: { foo: "bar", baz: 42 },
		});
	});

	it("handles null/undefined input gracefully", () => {
		const result = normalizeToolInput("Read", null);
		expect(result).toEqual({ tool: "Unknown", name: "Read", raw: {} });
	});

	it("handles empty object input", () => {
		const result = normalizeToolInput("Read", {});
		// Missing filePath — should still produce a Read with empty string
		expect(result.tool).toBe("Read");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/provider/claude/normalize-tool-input.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `src/lib/provider/claude/normalize-tool-input.ts`:

```ts
import type { CanonicalToolInput } from "../../persistence/events.js";

/**
 * Normalize raw Claude SDK tool input into CanonicalToolInput.
 * Claude SDK emits snake_case field names (file_path, old_string, etc.).
 * This function maps them to the canonical camelCase shape.
 */
export function normalizeToolInput(
	name: string,
	rawInput: unknown,
): CanonicalToolInput {
	const input = toRecord(rawInput);

	switch (name) {
		case "Read":
			return {
				tool: "Read",
				filePath: str(input, "file_path", "filePath"),
				...optNum(input, "offset"),
				...optNum(input, "limit"),
			};

		case "Edit":
			return {
				tool: "Edit",
				filePath: str(input, "file_path", "filePath"),
				oldString: str(input, "old_string", "oldString"),
				newString: str(input, "new_string", "newString"),
				...optBool(input, "replace_all", "replaceAll"),
			};

		case "Write":
			return {
				tool: "Write",
				filePath: str(input, "file_path", "filePath"),
				content: str(input, "content"),
			};

		case "Bash":
			return {
				tool: "Bash",
				command: str(input, "command"),
				...optStr(input, "description"),
				...optTimeoutMs(input),
			};

		case "Grep":
			return {
				tool: "Grep",
				pattern: str(input, "pattern"),
				...optStr(input, "path"),
				...optField("include", input, "glob", "include"),
				...optField("fileType", input, "type", "fileType"),
			};

		case "Glob":
			return {
				tool: "Glob",
				pattern: str(input, "pattern"),
				...optStr(input, "path"),
			};

		case "WebFetch":
			return {
				tool: "WebFetch",
				url: str(input, "url"),
				...optStr(input, "prompt"),
			};

		case "WebSearch":
			return {
				tool: "WebSearch",
				query: str(input, "query"),
			};

		case "Task":
			return {
				tool: "Task",
				description: str(input, "description"),
				prompt: str(input, "prompt"),
				...optField("subagentType", input, "subagent_type", "subagentType"),
			};

		case "LSP":
			return {
				tool: "LSP",
				operation: str(input, "operation"),
				...optField("filePath", input, "file_path", "filePath"),
			};

		case "Skill":
			return {
				tool: "Skill",
				name: str(input, "name"),
			};

		case "AskUserQuestion":
			return {
				tool: "AskUserQuestion",
				questions: input["questions"] ?? null,
			};

		default:
			return { tool: "Unknown", name, raw: input };
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function toRecord(v: unknown): Record<string, unknown> {
	if (v && typeof v === "object" && !Array.isArray(v)) {
		return v as Record<string, unknown>;
	}
	return {};
}

/** Read the first defined string value from multiple key aliases. */
function str(input: Record<string, unknown>, ...keys: string[]): string {
	for (const k of keys) {
		const v = input[k];
		if (typeof v === "string") return v;
	}
	return "";
}

/** Optional string field — only included if defined. */
function optStr(
	input: Record<string, unknown>,
	...keys: string[]
): Record<string, string> {
	for (const k of keys) {
		const v = input[k];
		if (typeof v === "string" && v.length > 0) return { [k]: v };
	}
	return {};
}

/** Optional number field — only included if defined. */
function optNum(
	input: Record<string, unknown>,
	...keys: string[]
): Record<string, number> {
	for (const k of keys) {
		const v = input[k];
		if (typeof v === "number") return { [k]: v };
	}
	return {};
}

/** Optional boolean field — only included if defined. */
function optBool(
	input: Record<string, unknown>,
	...keys: string[]
): Record<string, boolean> {
	for (const k of keys) {
		const v = input[k];
		if (typeof v === "boolean") return { [keys[keys.length - 1]!]: v };
	}
	return {};
}

/** Optional field with a canonical output key, reading from multiple input aliases. */
function optField(
	canonicalKey: string,
	input: Record<string, unknown>,
	...inputKeys: string[]
): Record<string, unknown> {
	for (const k of inputKeys) {
		const v = input[k];
		if (v !== undefined && v !== null && v !== "") return { [canonicalKey]: v };
	}
	return {};
}

/** Map Claude's `timeout` (number) to canonical `timeoutMs`. */
function optTimeoutMs(
	input: Record<string, unknown>,
): { timeoutMs: number } | Record<string, never> {
	const v = input["timeout"] ?? input["timeout_ms"] ?? input["timeoutMs"];
	if (typeof v === "number") return { timeoutMs: v };
	return {};
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/provider/claude/normalize-tool-input.test.ts`
Expected: PASS

**Step 5: Run full verification**

Run: `pnpm check && pnpm lint`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/provider/claude/normalize-tool-input.ts test/unit/provider/claude/normalize-tool-input.test.ts
git commit -m "feat: add Claude normalizeToolInput for canonical tool input normalization

Maps snake_case Claude SDK field names to the canonical CanonicalToolInput
shape. Unknown tools collapse to { tool: 'Unknown', name, raw }."
```

---

### Task 5: Create OpenCode `normalizeToolInput`

**Files:**
- Create: `src/lib/provider/opencode/normalize-tool-input.ts`
- Test: `test/unit/provider/opencode/normalize-tool-input.test.ts` (create)

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { normalizeToolInput } from "../../../../src/lib/provider/opencode/normalize-tool-input.js";

describe("OpenCode normalizeToolInput", () => {
	it("passes through camelCase Read input", () => {
		const result = normalizeToolInput("Read", {
			filePath: "/src/main.ts",
			offset: 10,
			limit: 50,
		});
		expect(result).toEqual({
			tool: "Read",
			filePath: "/src/main.ts",
			offset: 10,
			limit: 50,
		});
	});

	it("normalizes Bash", () => {
		const result = normalizeToolInput("Bash", {
			command: "ls",
			description: "list",
		});
		expect(result).toEqual({
			tool: "Bash",
			command: "ls",
			description: "list",
		});
	});

	it("normalizes WebSearch with url → hostname-based query fallback", () => {
		const result = normalizeToolInput("WebSearch", {
			url: "https://docs.example.com/search?q=test",
		});
		expect(result).toEqual({
			tool: "WebSearch",
			query: "docs.example.com",
		});
	});

	it("normalizes WebSearch with query (passthrough)", () => {
		const result = normalizeToolInput("WebSearch", {
			query: "typescript generics",
		});
		expect(result).toEqual({ tool: "WebSearch", query: "typescript generics" });
	});

	it("collapses unknown tool to Unknown variant", () => {
		const result = normalizeToolInput("CustomTool", { x: 1 });
		expect(result).toEqual({ tool: "Unknown", name: "CustomTool", raw: { x: 1 } });
	});

	it("handles null input", () => {
		const result = normalizeToolInput("Read", null);
		expect(result).toEqual({ tool: "Unknown", name: "Read", raw: {} });
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/provider/opencode/normalize-tool-input.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `src/lib/provider/opencode/normalize-tool-input.ts`:

```ts
import type { CanonicalToolInput } from "../../persistence/events.js";

/**
 * Normalize raw OpenCode tool input into CanonicalToolInput.
 * OpenCode emits camelCase field names — mostly passthrough.
 * Special case: WebSearch may carry `url` instead of `query`.
 */
export function normalizeToolInput(
	name: string,
	rawInput: unknown,
): CanonicalToolInput {
	const input = toRecord(rawInput);

	switch (name) {
		case "Read":
			return {
				tool: "Read",
				filePath: str(input, "filePath"),
				...optNum(input, "offset"),
				...optNum(input, "limit"),
			};

		case "Edit":
			return {
				tool: "Edit",
				filePath: str(input, "filePath"),
				oldString: str(input, "oldString"),
				newString: str(input, "newString"),
				...optBool(input, "replaceAll"),
			};

		case "Write":
			return {
				tool: "Write",
				filePath: str(input, "filePath"),
				content: str(input, "content"),
			};

		case "Bash":
			return {
				tool: "Bash",
				command: str(input, "command"),
				...optStr(input, "description"),
				...optNum(input, "timeoutMs"),
			};

		case "Grep":
			return {
				tool: "Grep",
				pattern: str(input, "pattern"),
				...optStr(input, "path"),
				...optStr(input, "include"),
				...optStr(input, "fileType"),
			};

		case "Glob":
			return {
				tool: "Glob",
				pattern: str(input, "pattern"),
				...optStr(input, "path"),
			};

		case "WebFetch":
			return {
				tool: "WebFetch",
				url: str(input, "url"),
				...optStr(input, "prompt"),
			};

		case "WebSearch": {
			// OpenCode may pass `url` instead of `query` — extract hostname as query fallback
			const query = str(input, "query");
			if (query) return { tool: "WebSearch", query };
			const url = str(input, "url");
			if (url) {
				const hostname = extractHostname(url);
				return { tool: "WebSearch", query: hostname ?? url };
			}
			return { tool: "WebSearch", query: "" };
		}

		case "Task":
			return {
				tool: "Task",
				description: str(input, "description"),
				prompt: str(input, "prompt"),
				...optStr(input, "subagentType"),
			};

		case "LSP":
			return {
				tool: "LSP",
				operation: str(input, "operation"),
				...optStr(input, "filePath"),
			};

		case "Skill":
			return {
				tool: "Skill",
				name: str(input, "name"),
			};

		case "AskUserQuestion":
			return {
				tool: "AskUserQuestion",
				questions: input["questions"] ?? null,
			};

		default:
			return { tool: "Unknown", name, raw: input };
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function toRecord(v: unknown): Record<string, unknown> {
	if (v && typeof v === "object" && !Array.isArray(v)) {
		return v as Record<string, unknown>;
	}
	return {};
}

function str(input: Record<string, unknown>, key: string): string {
	const v = input[key];
	return typeof v === "string" ? v : "";
}

function optStr(input: Record<string, unknown>, key: string): Record<string, string> {
	const v = input[key];
	if (typeof v === "string" && v.length > 0) return { [key]: v };
	return {};
}

function optNum(input: Record<string, unknown>, key: string): Record<string, number> {
	const v = input[key];
	if (typeof v === "number") return { [key]: v };
	return {};
}

function optBool(input: Record<string, unknown>, key: string): Record<string, boolean> {
	const v = input[key];
	if (typeof v === "boolean") return { [key]: v };
	return {};
}

function extractHostname(url: string): string | undefined {
	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/provider/opencode/normalize-tool-input.test.ts`
Expected: PASS

**Step 5: Run verification**

Run: `pnpm check && pnpm lint`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/provider/opencode/normalize-tool-input.ts test/unit/provider/opencode/normalize-tool-input.test.ts
git commit -m "feat: add OpenCode normalizeToolInput for canonical tool input normalization

Mostly passthrough (OpenCode uses camelCase). Special case: WebSearch url
is converted to hostname-based query for canonical shape."
```

---

### Task 6: Wire Claude translator to normalize at emit sites

**Files:**
- Modify: `src/lib/provider/claude/claude-event-translator.ts:430-462,502-538`

**Step 1: Write the failing test**

Create `test/unit/provider/claude/claude-translator-normalized-input.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ClaudeEventTranslator } from "../../../../src/lib/provider/claude/claude-event-translator.js";
import type { CanonicalEvent } from "../../../../src/lib/persistence/events.js";
import type { ClaudeSessionContext } from "../../../../src/lib/provider/claude/types.js";

function makeCtx(
	overrides: Partial<ClaudeSessionContext> = {},
): ClaudeSessionContext {
	return {
		sessionId: "ses-1",
		workspaceRoot: "/tmp/ws",
		startedAt: "2026-04-22T00:00:00.000Z",
		promptQueue: {
			enqueue: vi.fn(),
			close: vi.fn(),
			[Symbol.asyncIterator]: vi.fn(),
		} as unknown as ClaudeSessionContext["promptQueue"],
		query: {
			interrupt: vi.fn(),
			close: vi.fn(),
			setModel: vi.fn(),
			setPermissionMode: vi.fn(),
			[Symbol.asyncIterator]: vi.fn(),
		} as unknown as ClaudeSessionContext["query"],
		pendingApprovals: new Map(),
		pendingQuestions: new Map(),
		inFlightTools: new Map(),
		eventSink: undefined,
		streamConsumer: undefined,
		currentTurnId: "turn-1",
		currentModel: "claude-sonnet-4",
		resumeSessionId: undefined,
		lastAssistantUuid: undefined,
		turnCount: 0,
		stopped: false,
		...overrides,
	};
}

describe("ClaudeEventTranslator — normalized tool input", () => {
	it("tool.started event carries CanonicalToolInput with camelCase fields", async () => {
		const events: CanonicalEvent[] = [];
		const translator = new ClaudeEventTranslator({
			sink: {
				push: async (e: CanonicalEvent) => { events.push(e); },
				requestPermission: vi.fn(),
				requestQuestion: vi.fn(),
			},
		});

		const ctx = makeCtx();

		// Simulate content_block_start with a Read tool_use block
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu_123",
					name: "Read",
					input: { file_path: "/src/main.ts", offset: 10 },
				},
			},
		} as never);

		const toolStarted = events.find((e) => e.type === "tool.started");
		expect(toolStarted).toBeDefined();
		expect(toolStarted!.data.input).toEqual({
			tool: "Read",
			filePath: "/src/main.ts",
			offset: 10,
		});
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/provider/claude/claude-translator-normalized-input.test.ts`
Expected: FAIL — input is raw `{ file_path: "/src/main.ts", offset: 10 }`, not normalized

**Step 3: Wire normalizeToolInput at the emit sites**

In `src/lib/provider/claude/claude-event-translator.ts`, add the import at the top:

```ts
import { normalizeToolInput } from "./normalize-tool-input.js";
```

In `handleBlockStart` tool_use branch (around line 458), change:

```ts
// Before:
input,
// After:
input: normalizeToolInput(toolName, input),
```

In `handleBlockDelta` input_json_delta branch (around line 534), change:

```ts
// Before:
input: parsed,
// After:
input: normalizeToolInput(tool.toolName, parsed),
```

Also tag tool events with schemaVersion. Add `metadata: { schemaVersion: 2 }` only at the `tool.started` and `tool.input_updated` emit sites (not globally in `makeCanonicalEvent` — non-tool events like `text.delta` don't need it, and Task 7's OpenCode translator adds it per-site too, so both adapters should be consistent):

```ts
// At the tool.started emit site:
this.push(makeCanonicalEvent("tool.started", ctx.sessionId, {
	...data,
	input: normalizeToolInput(toolName, input),
}, { metadata: { schemaVersion: 2 } }));
```

> Note: `makeCanonicalEvent` may need an optional `opts` parameter to merge metadata. Alternatively, call `canonicalEvent` directly at tool emit sites with the extra metadata.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/provider/claude/claude-translator-normalized-input.test.ts`
Expected: PASS

**Step 5: Update existing translator tests for normalized input shape**

Existing tests in `test/unit/provider/claude/claude-event-translator.test.ts` assert on raw input shapes (e.g., `expect(data["input"]).toEqual({ command: "ls" })`). After normalization, input becomes `{ tool: "Bash", command: "ls" }`. Update all tool-related assertions:

- Find all `expect(data["input"]).toEqual(...)` assertions for tool.started and tool.input_updated events
- Update expected values to include the `tool` discriminant field
- Example: `{ command: "ls" }` → `{ tool: "Bash", command: "ls" }`
- Example: `{ file_path: "/src/main.ts" }` → `{ tool: "Read", filePath: "/src/main.ts" }`

**Step 6: Run full verification**

Run: `pnpm check && pnpm test:unit`
Expected: PASS

**Step 7: Commit**

```bash
git add src/lib/provider/claude/claude-event-translator.ts test/unit/provider/claude/claude-event-translator.test.ts
git commit -m "feat: wire normalizeToolInput at Claude translator emit sites

tool.started and tool.input_updated events now carry CanonicalToolInput
with camelCase fields. Events tagged with schemaVersion: 2."
```

---

### Task 7: Wire OpenCode canonical event translator to normalize

**Files:**
- Modify: `src/lib/persistence/canonical-event-translator.ts:265-300`

**Step 1: Write the failing test**

Create `test/unit/persistence/canonical-event-translator-normalized.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CanonicalEventTranslator } from "../../../src/lib/persistence/canonical-event-translator.js";

describe("CanonicalEventTranslator — normalized tool input", () => {
	it("tool.started carries CanonicalToolInput for pending tool", () => {
		const translator = new CanonicalEventTranslator();
		const events = translator.translate(
			{
				type: "message.part.updated",
				properties: {
					messageID: "msg-1",
					partID: "part-1",
					part: {
						type: "tool",
						id: "part-1",
						tool: "read",
						callID: "call-1",
						state: {
							status: "pending",
							input: { filePath: "/src/main.ts", offset: 5 },
						},
					},
				},
			} as never,
			"ses-1",
		);

		expect(events).not.toBeNull();
		const toolStarted = events!.find((e) => e.type === "tool.started");
		expect(toolStarted).toBeDefined();
		expect(toolStarted!.data.input).toEqual({
			tool: "Read",
			filePath: "/src/main.ts",
			offset: 5,
		});
	});

	it("tool.started carries CanonicalToolInput when first seen as running", () => {
		const translator = new CanonicalEventTranslator();
		const events = translator.translate(
			{
				type: "message.part.updated",
				properties: {
					messageID: "msg-1",
					partID: "part-2",
					part: {
						type: "tool",
						id: "part-2",
						tool: "bash",
						callID: "call-2",
						state: {
							status: "running",
							input: { command: "ls -la" },
						},
					},
				},
			} as never,
			"ses-1",
		);

		expect(events).not.toBeNull();
		const toolStarted = events!.find((e) => e.type === "tool.started");
		expect(toolStarted).toBeDefined();
		expect(toolStarted!.data.input).toEqual({
			tool: "Bash",
			command: "ls -la",
		});
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/canonical-event-translator-normalized.test.ts`
Expected: FAIL — input is raw `{ filePath: "/src/main.ts", offset: 5 }`, not `{ tool: "Read", ... }`

**Step 3: Wire normalizeToolInput**

In `src/lib/persistence/canonical-event-translator.ts`, add the import:

```ts
import { normalizeToolInput } from "../provider/opencode/normalize-tool-input.js";
```

In the `translatePartUpdated` tool lifecycle section (around line 268 and 288), change:

```ts
// Before (line ~272):
input: rawPart.state?.input ?? null,
// After:
input: normalizeToolInput(toolName, rawPart.state?.input),
```

Apply the same change at both emit sites (pending and first-seen-as-running).

Also add `schemaVersion: 2` to the metadata. Update the `canonicalEvent` calls to include it:

```ts
canonicalEvent("tool.started", sessionId, {
	messageId,
	partId,
	toolName,
	callId,
	input: normalizeToolInput(toolName, rawPart.state?.input),
}, { metadata: { schemaVersion: 2 } }),
```

> Note: The `mapToolName` import already exists at the top of the file (`import { mapToolName } from "../relay/event-translator.js"`). The `mapToolName` function capitalizes tool names (e.g., "read" → "Read"), which is what `normalizeToolInput` expects.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/canonical-event-translator-normalized.test.ts`
Expected: PASS

**Step 5: Update existing translator tests for normalized input shape**

Existing tests in `test/unit/persistence/canonical-event-translator.test.ts` assert on raw input shapes (e.g., `{ file: "test.ts" }`). After normalization with `mapToolName`, input becomes canonical shape (e.g., `{ tool: "Read", filePath: "" }`). Update all tool-related assertions to expect the canonical shape.

**Step 6: Run full verification**

Run: `pnpm check && pnpm test:unit`
Expected: PASS

**Step 7: Commit**

```bash
git add src/lib/persistence/canonical-event-translator.ts test/unit/persistence/canonical-event-translator.test.ts
git commit -m "feat: wire normalizeToolInput at OpenCode canonical event translator

tool.started events emitted by the OpenCode → canonical path now carry
CanonicalToolInput. Events tagged with schemaVersion: 2."
```

---

### Task 8: Migrate `extractToolSummary` to typed `CanonicalToolInput` access; delete `readStr`

**Files:**
- Modify: `src/lib/frontend/utils/group-tools.ts:60-233`
- Test: `test/unit/frontend/group-tools-summary.test.ts` (create)

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { extractToolSummary } from "../../../src/lib/frontend/utils/group-tools.js";

describe("extractToolSummary — CanonicalToolInput", () => {
	it("Read with CanonicalToolInput shape", () => {
		const result = extractToolSummary("Read", {
			tool: "Read",
			filePath: "/src/main.ts",
			offset: 10,
			limit: 50,
		});
		expect(result.subtitle).toBe("/src/main.ts");
		expect(result.tags).toContain("offset:10");
		expect(result.tags).toContain("limit:50");
	});

	it("Bash with CanonicalToolInput shape", () => {
		const result = extractToolSummary("Bash", {
			tool: "Bash",
			command: "ls -la /very/long/path/that/exceeds/forty/characters/easily",
		});
		expect(result.subtitle).toBeDefined();
		expect(result.subtitle!.length).toBeLessThanOrEqual(41); // 40 + ellipsis
	});

	it("Edit with CanonicalToolInput shape", () => {
		const result = extractToolSummary("Edit", {
			tool: "Edit",
			filePath: "/src/main.ts",
			oldString: "a",
			newString: "b",
		});
		expect(result.subtitle).toBe("/src/main.ts");
	});

	it("Grep with CanonicalToolInput shape", () => {
		const result = extractToolSummary("Grep", {
			tool: "Grep",
			pattern: "TODO",
			path: "/src",
			include: "*.ts",
		});
		expect(result.subtitle).toBe("TODO");
	});

	it("WebFetch with CanonicalToolInput shape", () => {
		const result = extractToolSummary("WebFetch", {
			tool: "WebFetch",
			url: "https://docs.example.com/page",
		});
		expect(result.subtitle).toBe("docs.example.com");
	});

	it("Task with CanonicalToolInput shape", () => {
		const result = extractToolSummary("Task", {
			tool: "Task",
			description: "find bugs",
			prompt: "look",
			subagentType: "review",
		});
		expect(result.subtitle).toBe("find bugs");
	});

	it("still works with legacy raw input (backwards compat)", () => {
		// Pre-normalization: raw camelCase input without `tool` discriminant
		const result = extractToolSummary("Read", {
			filePath: "/src/legacy.ts",
		});
		expect(result.subtitle).toBe("/src/legacy.ts");
	});

	it("still works with legacy snake_case input (backwards compat)", () => {
		const result = extractToolSummary("Read", {
			file_path: "/src/snake.ts",
		});
		expect(result.subtitle).toBe("/src/snake.ts");
	});
});
```

**Step 2: Run test to verify baseline**

Run: `pnpm vitest run test/unit/frontend/group-tools-summary.test.ts`
Expected: The legacy tests PASS (existing `readStr` handles them). The CanonicalToolInput test may pass or fail depending on whether `extractToolSummary` reads `filePath` directly vs through `readStr`. Check the result — if all pass, proceed; if the canonical test fails, proceed to step 3.

**Step 3: Update `extractToolSummary`**

In `src/lib/frontend/utils/group-tools.ts`, update the function to accept `CanonicalToolInput` or legacy raw input. Since we're keeping backwards compatibility during the transition:

Keep `readStr` for now (it will be deleted in Phase 3 cleanup when all consumers are migrated). The function already reads `filePath` as the first alias in `readStr(input, "filePath", "file_path")`, so `CanonicalToolInput` shapes (which use `filePath`) already work.

The key change: when the input has a `tool` discriminant field, use typed access directly without `readStr`. Update the switch:

```ts
export function extractToolSummary(
	name: string,
	input?: Record<string, unknown>,
	repoRoot?: string,
): { subtitle?: string; tags?: string[] } {
	if (!input) return {};

	// If input carries a CanonicalToolInput discriminant, use typed access.
	// Otherwise fall through to readStr-based legacy access.
	const isCanonical = typeof input["tool"] === "string";

	switch (name) {
		case "Read": {
			const filePath = isCanonical
				? (input["filePath"] as string | undefined)
				: readStr(input, "filePath", "file_path");
			const tags: string[] = [];
			if (input["offset"] != null) tags.push(`offset:${input["offset"]}`);
			if (input["limit"] != null) tags.push(`limit:${input["limit"]}`);
			return {
				...(filePath != null && {
					subtitle: stripRepoRoot(filePath, repoRoot),
				}),
				...(tags.length > 0 ? { tags } : {}),
			};
		}
		// ... same pattern for other cases
```

Apply the `isCanonical` guard to every case in the switch. For canonical inputs, access fields directly with their camelCase names. For legacy inputs, keep the `readStr` fallback.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/frontend/group-tools-summary.test.ts`
Expected: PASS

**Step 5: Run full verification**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/frontend/utils/group-tools.ts test/unit/frontend/group-tools-summary.test.ts
git commit -m "feat: extractToolSummary accepts CanonicalToolInput with typed field access

Adds isCanonical guard: when input carries a 'tool' discriminant, fields are
accessed directly by camelCase name. Legacy readStr fallback preserved for
pre-normalization events."
```

---

## Phase 2 — Buffer `tool.started`; Delete `tool.input_updated`

### Task 9: Buffer tool_use blocks in `ClaudeEventTranslator`

**Files:**
- Modify: `src/lib/provider/claude/claude-event-translator.ts:397-546`
- Modify: `src/lib/provider/claude/types.ts` (add `pendingStart` and `bufferedInput` to `ToolInFlight`)
- Test: `test/unit/provider/claude/tool-use-buffering.test.ts` (create)

**Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { ClaudeEventTranslator } from "../../../../src/lib/provider/claude/claude-event-translator.js";
import type { CanonicalEvent } from "../../../../src/lib/persistence/events.js";
import type { ClaudeSessionContext } from "../../../../src/lib/provider/claude/types.js";

function makeCtx(
	overrides: Partial<ClaudeSessionContext> = {},
): ClaudeSessionContext {
	return {
		sessionId: "ses-1",
		workspaceRoot: "/tmp/ws",
		startedAt: "2026-04-22T00:00:00.000Z",
		promptQueue: {
			enqueue: vi.fn(),
			close: vi.fn(),
			[Symbol.asyncIterator]: vi.fn(),
		} as unknown as ClaudeSessionContext["promptQueue"],
		query: {
			interrupt: vi.fn(),
			close: vi.fn(),
			setModel: vi.fn(),
			setPermissionMode: vi.fn(),
			[Symbol.asyncIterator]: vi.fn(),
		} as unknown as ClaudeSessionContext["query"],
		pendingApprovals: new Map(),
		pendingQuestions: new Map(),
		inFlightTools: new Map(),
		eventSink: undefined,
		streamConsumer: undefined,
		currentTurnId: "turn-1",
		currentModel: "claude-sonnet-4",
		resumeSessionId: undefined,
		lastAssistantUuid: undefined,
		turnCount: 0,
		stopped: false,
		...overrides,
	};
}

function makeTranslator() {
	const events: CanonicalEvent[] = [];
	const translator = new ClaudeEventTranslator({
		sink: {
			push: async (e: CanonicalEvent) => { events.push(e); },
			requestPermission: vi.fn(),
			requestQuestion: vi.fn(),
		},
	});
	return { translator, events };
}

describe("ClaudeEventTranslator — tool_use buffering", () => {
	it("emits exactly one tool.started per tool_use block, at content_block_stop", async () => {
		const { translator, events } = makeTranslator();
		const ctx = makeCtx();

		// message_start
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "message_start",
				message: { id: "msg-1", type: "message", role: "assistant", content: [], model: "claude-4" },
			},
		} as never);

		// content_block_start (tool_use) — should NOT emit tool.started yet
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu_1",
					name: "Read",
					input: {},
				},
			},
		} as never);

		const afterStart = events.filter((e) => e.type === "tool.started");
		expect(afterStart).toHaveLength(0);

		// input_json_delta chunks
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"file_path":' },
			},
		} as never);

		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '"/src/main.ts"}' },
			},
		} as never);

		// Still no tool.started
		expect(events.filter((e) => e.type === "tool.started")).toHaveLength(0);

		// content_block_stop — NOW tool.started should emit with complete input
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: { type: "content_block_stop", index: 0 },
		} as never);

		const toolStarted = events.filter((e) => e.type === "tool.started");
		expect(toolStarted).toHaveLength(1);
		expect(toolStarted[0]!.data.input).toEqual({
			tool: "Read",
			filePath: "/src/main.ts",
		});

		// No tool.input_updated events should have been emitted
		const inputUpdated = events.filter((e) => e.type === "tool.input_updated");
		expect(inputUpdated).toHaveLength(0);
	});

	it("emits tool.started with initial input if no deltas arrive", async () => {
		const { translator, events } = makeTranslator();
		const ctx = makeCtx();

		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu_2",
					name: "Bash",
					input: { command: "echo hi" },
				},
			},
		} as never);

		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: { type: "content_block_stop", index: 0 },
		} as never);

		const toolStarted = events.filter((e) => e.type === "tool.started");
		expect(toolStarted).toHaveLength(1);
		expect(toolStarted[0]!.data.input).toEqual({
			tool: "Bash",
			command: "echo hi",
		});
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/provider/claude/tool-use-buffering.test.ts`
Expected: FAIL — current code emits `tool.started` at `content_block_start` and `tool.input_updated` during deltas

**Step 2b: Emit `tool.running` after `tool.started` at block-stop (REQUIRED)**

> **CRITICAL:** The `message-projector` at `src/lib/persistence/projectors/message-projector.ts:273-278` uses `tool.running` to execute `UPDATE message_parts SET status = 'running'`. Without this event, tool parts stay permanently at `pending` status in the database. The `activity-projector` also inserts an activity row for `tool.running`. The relay-event-sink returns `silent()` for it (no relay impact).

Always emit `tool.running` immediately after `tool.started` at content_block_stop:

```ts
// In handleBlockStop, after emitting tool.started:
await this.push(makeCanonicalEvent("tool.running", ctx.sessionId, {
	messageId: this.currentAssistantMessageId,
	partId: tool.itemId,
}));
```

Also update the buffering tests (Step 1) to verify `tool.running` is emitted after `tool.started`:

```ts
// Add to the "emits exactly one tool.started per tool_use block" test:
const toolRunning = events.filter((e) => e.type === "tool.running");
expect(toolRunning).toHaveLength(1);
// tool.running must come AFTER tool.started
const startIdx = events.findIndex((e) => e.type === "tool.started");
const runIdx = events.findIndex((e) => e.type === "tool.running");
expect(runIdx).toBeGreaterThan(startIdx);
```

**Step 3: Implement buffering**

First, add `pendingStart` and `bufferedInput` fields to `ToolInFlight` in `src/lib/provider/claude/types.ts`:

```ts
export interface ToolInFlight {
	itemId: string;
	toolName: string;
	title: string;
	input: Record<string, unknown>;
	partialInputJson: string;
	lastEmittedFingerprint?: string;
	/** Phase 2: tool_use blocks buffer until content_block_stop. */
	pendingStart?: boolean;
	/** Phase 2: accumulated parsed input from input_json_delta. */
	bufferedInput?: Record<string, unknown>;
}
```

Then modify `claude-event-translator.ts`:

In `handleBlockStart` tool_use branch (~line 452): **remove** the `this.push(makeCanonicalEvent("tool.started", ...))` call. Instead, set `pendingStart: true`:

```ts
case "tool_use":
case "server_tool_use":
case "mcp_tool_use": {
	const toolName = block.name ?? "unknown";
	const itemType = classifyToolItemType(toolName);
	const rawInput = block.input;
	const input =
		rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
			? (rawInput as Record<string, unknown>)
			: {};
	const blockId = block.id ?? randomUUID();
	const tool: ToolInFlight = {
		itemId: blockId,
		toolName,
		title: titleForItemType(itemType),
		input,
		partialInputJson: "",
		pendingStart: true,
	};
	ctx.inFlightTools.set(index, tool);
	// Do NOT emit tool.started here — buffered until content_block_stop
	return;
}
```

In `handleBlockDelta` input_json_delta branch (~line 520): **remove** the `tool.input_updated` and `tool.running` emits. Instead, stash:

```ts
case "input_json_delta": {
	if (!tool) return;
	const partialJson = delta.partial_json;
	const merged = tool.partialInputJson + partialJson;
	tool.partialInputJson = merged;
	let parsed: Record<string, unknown> | undefined;
	try {
		const p: unknown = JSON.parse(merged);
		if (p && typeof p === "object" && !Array.isArray(p)) {
			parsed = p as Record<string, unknown>;
		}
	} catch {
		return;
	}
	if (!parsed) return;

	const fingerprint = JSON.stringify(parsed);
	if (tool.lastEmittedFingerprint === fingerprint) return;
	tool.lastEmittedFingerprint = fingerprint;
	tool.input = parsed;
	tool.bufferedInput = parsed;
	// Do NOT emit tool.input_updated or tool.running — buffered
	return;
}
```

In `handleBlockStop` (~line 360): add handling for `pendingStart`:

```ts
private async handleBlockStop(
	ctx: ClaudeSessionContext,
	event: StreamEvent & { type: "content_block_stop" },
): Promise<void> {
	const index = event.index;
	const tool = ctx.inFlightTools.get(index);
	if (!tool) return;

	if (tool.toolName === "__thinking") {
		ctx.inFlightTools.delete(index);
		await this.push(
			makeCanonicalEvent("thinking.end", ctx.sessionId, {
				messageId: this.currentAssistantMessageId,
				partId: tool.itemId,
			}),
		);
		return;
	}

	if (tool.toolName === "__text") {
		ctx.inFlightTools.delete(index);
		await this.push(
			makeCanonicalEvent("tool.completed", ctx.sessionId, {
				messageId: tool.itemId,
				partId: `part-stop-${index}`,
				result: null,
				duration: 0,
			}),
		);
		return;
	}

	// tool_use blocks: emit buffered tool.started now with complete input
	if (tool.pendingStart) {
		tool.pendingStart = false;
		const finalInput = tool.bufferedInput ?? tool.input;
		await this.push(
			makeCanonicalEvent("tool.started", ctx.sessionId, {
				messageId: this.currentAssistantMessageId,
				partId: tool.itemId,
				toolName: tool.toolName,
				callId: tool.itemId,
				input: normalizeToolInput(tool.toolName, finalInput),
			}),
		);
	}
	// Do NOT delete from inFlightTools — tool_use blocks wait for tool_result
}
```

**Step 3b: Handle stream interruption for `pendingStart` tools**

In `claude-adapter.ts` `cleanupSession` (or the equivalent cleanup path that emits `tool.completed` for in-flight tools): before emitting `tool.completed` for an in-flight tool, check `tool.pendingStart`. If true, emit `tool.started` first (with partial input from `tool.bufferedInput ?? tool.input`) so downstream consumers never see `tool.completed` for a tool that was never started.

Add a test for this in the buffering test file:

```ts
	it("emits tool.started before cleanup when stream is interrupted mid-buffering", async () => {
		const { translator, events } = makeTranslator();
		const ctx = makeCtx();

		// content_block_start but NO content_block_stop (simulates interruption)
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu_3",
					name: "Read",
					input: {},
				},
			},
		} as never);

		// Verify tool is in pendingStart state
		expect(ctx.inFlightTools.size).toBe(1);
		const tool = ctx.inFlightTools.get(0);
		expect(tool?.pendingStart).toBe(true);

		// Simulate adapter cleanup: flush pendingStart tools
		// The adapter's cleanupSession should emit tool.started then tool.completed
		// for any tool still in pendingStart state.
		await translator.flushPendingTools(ctx);

		const toolStarted = events.filter((e) => e.type === "tool.started");
		expect(toolStarted).toHaveLength(1);
		expect(toolStarted[0]!.data.toolName).toBe("Read");

		// tool.completed should also be emitted for the interrupted tool
		const toolCompleted = events.filter((e) => e.type === "tool.completed");
		expect(toolCompleted).toHaveLength(1);
	});
```

**Step 3c: Add additional buffering test cases**

Add to the test file:

```ts
	it("bufferedInput overrides non-empty initial block.input", async () => {
		const { translator, events } = makeTranslator();
		const ctx = makeCtx();

		// content_block_start with non-empty initial input
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu_4",
					name: "Bash",
					input: { command: "partial" },
				},
			},
		} as never);

		// Delta overrides with complete input
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"command":"ls -la","description":"list"}' },
			},
		} as never);

		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: { type: "content_block_stop", index: 0 },
		} as never);

		const toolStarted = events.filter((e) => e.type === "tool.started");
		expect(toolStarted).toHaveLength(1);
		// bufferedInput should win over initial block.input
		expect(toolStarted[0]!.data.input).toEqual({
			tool: "Bash",
			command: "ls -la",
			description: "list",
		});
	});

	it("handles multiple concurrent tool_use blocks at different indices", async () => {
		const { translator, events } = makeTranslator();
		const ctx = makeCtx();

		// Two tool_use blocks started at different indices
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "toolu_a", name: "Read", input: {} },
			},
		} as never);

		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_start",
				index: 1,
				content_block: { type: "tool_use", id: "toolu_b", name: "Bash", input: {} },
			},
		} as never);

		// Deltas for each
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"file_path":"/a.ts"}' },
			},
		} as never);

		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_delta",
				index: 1,
				delta: { type: "input_json_delta", partial_json: '{"command":"echo hi"}' },
			},
		} as never);

		// Stop both
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: { type: "content_block_stop", index: 0 },
		} as never);

		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: { type: "content_block_stop", index: 1 },
		} as never);

		const toolStarted = events.filter((e) => e.type === "tool.started");
		expect(toolStarted).toHaveLength(2);
		expect(toolStarted[0]!.data.toolName).toBe("Read");
		expect(toolStarted[1]!.data.toolName).toBe("Bash");
	});

	it("handles partial JSON that fails to parse mid-stream", async () => {
		const { translator, events } = makeTranslator();
		const ctx = makeCtx();

		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "toolu_5", name: "Grep", input: {} },
			},
		} as never);

		// Chunk 1: incomplete JSON — should not crash
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"pattern":"TO' },
			},
		} as never);

		// Chunk 2: completes the JSON
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: 'DO"}' },
			},
		} as never);

		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "ses-1",
			event: { type: "content_block_stop", index: 0 },
		} as never);

		const toolStarted = events.filter((e) => e.type === "tool.started");
		expect(toolStarted).toHaveLength(1);
		expect(toolStarted[0]!.data.input).toEqual({
			tool: "Grep",
			pattern: "TODO",
		});
	});
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/provider/claude/tool-use-buffering.test.ts`
Expected: PASS

**Step 5: Run full verification**

Run: `pnpm check && pnpm test:unit`
Expected: PASS (existing tests that relied on `tool.started` at block-start or `tool.input_updated` will need updating — fix any failures)

**Step 6: Commit**

```bash
git add src/lib/provider/claude/claude-event-translator.ts src/lib/provider/claude/types.ts test/unit/provider/claude/tool-use-buffering.test.ts
git commit -m "feat: buffer tool_use blocks until content_block_stop

tool.started now fires once per tool_use block with complete input,
at content_block_stop instead of content_block_start. tool.input_updated
and tool.running are no longer emitted during the streaming window."
```

---

### Task 10: Delete `tool.input_updated` event type and all references

**Files:**
- Modify: `src/lib/persistence/events.ts:35-56,111-122,195-216,279-300`
- Modify: `src/lib/provider/relay-event-sink.ts:283-298`
- Modify: `src/lib/provider/claude/event-type-guard.ts:26` (**compile blocker** — `CLAUDE_PRODUCED_TYPES`)
- Modify: `test/unit/provider/relay-event-sink-exhaustive.test.ts`
- Modify: `test/unit/provider/relay-event-sink.test.ts:183-207`
- Modify: `test/unit/provider/relay-event-sink-translation-shape.test.ts`
- Modify: `test/unit/provider/claude/claude-event-translator.test.ts:375-413` (assertions on `tool.input_updated`)
- Modify: `test/unit/persistence/events.test.ts:27` (reference)
- Update: `test/unit/pipeline/__snapshots__/exhaustiveness-guards.test.ts.snap:19` (snapshot — delete and regenerate)

**Step 1: Soft-delete from events.ts**

> **CRITICAL:** Do NOT remove `"tool.input_updated"` from the `CANONICAL_EVENT_TYPES` array. Both `event-store.ts:152` and `projection-runner.ts:707` validate event types against this array. Removing it breaks recovery of historical events already in the database, throwing `UNKNOWN_EVENT_TYPE` errors.

Keep `"tool.input_updated"` in `CANONICAL_EVENT_TYPES` with a comment:

```ts
"tool.input_updated", // Retained for historical event compatibility — no longer emitted after Phase 2
```

Delete `ToolInputUpdatedPayload` interface (lines 111–122).

Remove `"tool.input_updated": ToolInputUpdatedPayload` from `EventPayloadMap` — replace with a no-op entry so the type system still recognizes it:

```ts
"tool.input_updated": { readonly messageId: string; readonly partId: string; readonly [key: string]: unknown },
```

Replace `"tool.input_updated": ["messageId", "partId", "input"]` in `PAYLOAD_REQUIRED_FIELDS` with a minimal entry:

```ts
"tool.input_updated": ["messageId", "partId"], // Historical compat — no longer emitted
```

> Note: `PAYLOAD_REQUIRED_FIELDS` is typed `Record<CanonicalEventType, readonly string[]>`, so EVERY entry in `CANONICAL_EVENT_TYPES` MUST have a key. Removing it causes a compile error.

**Step 2: Delete from relay-event-sink.ts**

Remove the `case "tool.input_updated":` branch (lines 283–298). It was converted to `emit(...)` in Task 1, now delete the entire case.

**Step 2b: Delete from event-type-guard.ts**

Remove `"tool.input_updated"` from the `CLAUDE_PRODUCED_TYPES` array in `src/lib/provider/claude/event-type-guard.ts:26`. **This is a compile blocker** — the type derives from `CANONICAL_EVENT_TYPES` and will fail if the guard references a deleted type.

**Step 3: Update tests**

In `relay-event-sink-exhaustive.test.ts`: remove `"tool.input_updated"` from `HANDLED_TYPES`.

In `relay-event-sink.test.ts`: delete the `"maps tool.input_updated → tool_executing"` test (lines 183–207).

In `relay-event-sink-translation-shape.test.ts`: remove the `tool.input_updated` entry from `EMIT_CASES`.

In `claude-event-translator.test.ts`: delete or update tests at lines 375–413 that assert on `tool.input_updated` events. These tests should now assert that `tool.input_updated` is NOT emitted (covered by Task 9's buffering tests).

In `events.test.ts`: remove any reference to `tool.input_updated` at line 27.

Delete `test/unit/pipeline/__snapshots__/exhaustiveness-guards.test.ts.snap` and regenerate by running: `pnpm vitest run test/unit/pipeline/exhaustiveness-guards.test.ts --update`.

**Step 4: Run tests**

Run: `pnpm check && pnpm test:unit`
Expected: PASS (if any tests reference `tool.input_updated`, they'll fail — fix them)

**Step 5: Commit**

```bash
git add src/lib/persistence/events.ts src/lib/provider/relay-event-sink.ts test/unit/provider/relay-event-sink-exhaustive.test.ts test/unit/provider/relay-event-sink.test.ts test/unit/provider/relay-event-sink-translation-shape.test.ts
git commit -m "refactor: delete tool.input_updated event type

No longer emitted (buffering makes tool.started carry complete input).
Removes: ToolInputUpdatedPayload, EventPayloadMap entry, PAYLOAD_REQUIRED_FIELDS
entry, relay-event-sink translation case, exhaustive test entry, and unit test."
```

---

### Task 11: Narrow tool-registry `executing()` — delete `running→running` merge, add `updateMetadata`

**Files:**
- Modify: `src/lib/frontend/stores/tool-registry.ts:67-72,121-152`
- Modify: `test/unit/stores/tool-registry.test.ts` (existing file — add new tests here, not a new file)

**Step 1: Write the failing tests for post-deletion behavior**

Add to the existing `test/unit/stores/tool-registry.test.ts`:

```ts
describe("ToolRegistry — post-buffering (running→running deleted)", () => {
	it("executing() on already-running tool is rejected (no more merge)", () => {
		const reg = createToolRegistry();
		reg.start("call-1", "Bash", "msg-1");
		reg.executing("call-1", { command: "ls" });

		// Second executing on running tool — should reject now (branch deleted)
		const result = reg.executing("call-1", { command: "pwd" });
		expect(result.action).toBe("reject");
	});

	it("updateMetadata() on running tool merges metadata without changing status", () => {
		const reg = createToolRegistry();
		reg.start("call-1", "Task", "msg-1");
		reg.executing("call-1", { description: "find bugs" });

		const result = reg.updateMetadata("call-1", { sessionId: "sub-1" });
		expect(result.action).toBe("update");
		if (result.action === "update") {
			expect(result.tool.metadata).toEqual({ sessionId: "sub-1" });
			expect(result.tool.input).toEqual({ description: "find bugs" });
			expect(result.tool.status).toBe("running");
		}
	});

	it("updateMetadata() on completed tool is rejected", () => {
		const reg = createToolRegistry();
		reg.start("call-1", "Bash", "msg-1");
		reg.executing("call-1", { command: "ls" });
		reg.complete("call-1", "ok", false);

		const result = reg.updateMetadata("call-1", { sessionId: "sub-1" });
		expect(result.action).toBe("reject");
	});

	it("updateMetadata() on unknown tool is rejected", () => {
		const reg = createToolRegistry();
		const result = reg.updateMetadata("nonexistent", { sessionId: "sub-1" });
		expect(result.action).toBe("reject");
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/stores/tool-registry.test.ts`
Expected: FAIL — `updateMetadata` does not exist; `executing()` on running tool currently returns `"update"` (the branch we're about to delete)

**Step 3: Implement the code change**

In `src/lib/frontend/stores/tool-registry.ts`:

**3a. Delete the `running→running` branch** in `executing()` (around line 131-141). Remove this block:

```ts
// running→running: OpenCode sends multiple tool_executing events
// as the tool part state evolves (e.g. metadata with sessionId arrives
// after the initial running event for subagent/Task tools).
if (tracked.status === "running") {
	// Merge updated input/metadata without changing status
	tracked.tool = {
		...tracked.tool,
		...(input !== undefined && { input }),
		...(metadata !== undefined && { metadata }),
	};
	return { action: "update", uuid: tracked.uuid, tool: tracked.tool };
}
```

Replace with a reject:

```ts
// running→running: After Phase 2 buffering, tool.started carries complete
// input. Redundant executing events are rejected. Metadata-only updates
// go through updateMetadata() instead.
if (tracked.status === "running") {
	return {
		action: "reject",
		reason: "Tool already running (use updateMetadata for metadata-only updates)",
	};
}
```

**3b. Add `updateMetadata` method** to the `ToolRegistry` interface and implementation:

Add to the `ToolRegistry` interface:

```ts
/** Update metadata on a running/pending tool without changing status.
 *  Used by OpenCode's subagent/Task tools where sessionId metadata
 *  arrives after the initial running event. */
updateMetadata(
	id: string,
	metadata: Record<string, unknown>,
): ToolTransitionResult;
```

Add implementation inside `createToolRegistry()`:

```ts
function updateMetadata(
	id: string,
	metadata: Record<string, unknown>,
): ToolTransitionResult {
	const tracked = entries.get(id);
	if (!tracked) {
		return { action: "reject", reason: `Unknown tool ID: ${id}` };
	}
	if (tracked.status === "completed" || tracked.status === "error") {
		return {
			action: "reject",
			reason: `Cannot update metadata on ${tracked.status} tool`,
		};
	}
	tracked.tool = { ...tracked.tool, metadata };
	return { action: "update", uuid: tracked.uuid, tool: tracked.tool };
}
```

Add `updateMetadata` to the returned object.

**3c. Update EMPTY_MESSAGES stub.** If there is an `EMPTY_MESSAGES` or frozen empty-state object that exposes the `ToolRegistry` interface, add `updateMetadata` to it:

```ts
updateMetadata: () => ({ action: "reject" as const, reason: "empty registry" }),
```

**3d. Update callers.** Grep for calls to `executing()` that pass metadata. The primary caller is in the frontend dispatcher (`ws-dispatch.ts` or `chat.svelte.ts`). Where the caller passes `metadata` to `executing()` for a running→running update (OpenCode Task/subagent tools), change it to call `updateMetadata()` instead when only metadata is being passed.

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/stores/tool-registry.test.ts`
Expected: PASS

**Step 5: Run full verification**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/frontend/stores/tool-registry.ts test/unit/stores/tool-registry.test.ts
git commit -m "refactor: delete running→running merge in tool-registry, add updateMetadata

executing() on an already-running tool now rejects. Metadata-only updates
(OpenCode subagent/Task tools) go through the new updateMetadata() method.
Preserves OpenCode's late-metadata flow via a narrower entry point."
```

---

## Phase 3 — Per-Tool Summarizer Registry

### Task 12: Create `ToolSummary` types, registry, `Unknown` fallback, and index

**Files:**
- Create: `src/lib/frontend/utils/tool-summarizers/types.ts`
- Create: `src/lib/frontend/utils/tool-summarizers/unknown.ts`
- Create: `src/lib/frontend/utils/tool-summarizers/registry.ts` (Map + registerSummarizer — separate file to break circular dependency)
- Create: `src/lib/frontend/utils/tool-summarizers/index.ts` (re-exports + side-effect imports)
- Test: `test/unit/frontend/tool-summarizers/unknown.test.ts` (create)
- Test: `test/unit/frontend/tool-summarizers/index.test.ts` (create)

**Step 1: Write the failing test**

Create `test/unit/frontend/tool-summarizers/unknown.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { unknownSummarizer } from "../../../../src/lib/frontend/utils/tool-summarizers/unknown.js";

describe("Unknown summarizer", () => {
	it("renders JSON preview subtitle truncated to 60 chars", () => {
		const result = unknownSummarizer.summarize(
			{ tool: "Unknown", name: "FutureTool", raw: { longKey: "x".repeat(100) } },
			{},
		);
		expect(result.subtitle).toBeDefined();
		expect(result.subtitle!.length).toBeLessThanOrEqual(63); // 60 + "..."
	});

	it("renders expanded text content as formatted JSON", () => {
		const result = unknownSummarizer.summarize(
			{ tool: "Unknown", name: "FutureTool", raw: { key: "val" } },
			{},
		);
		expect(result.expandedContent).toEqual({
			kind: "text",
			body: JSON.stringify({ key: "val" }, null, 2),
		});
	});

	it("never returns empty subtitle", () => {
		const result = unknownSummarizer.summarize(
			{ tool: "Unknown", name: "X", raw: {} },
			{},
		);
		expect(result.subtitle).toBeDefined();
		expect(result.subtitle!.length).toBeGreaterThan(0);
	});
});
```

Create `test/unit/frontend/tool-summarizers/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { lookupSummarizer } from "../../../../src/lib/frontend/utils/tool-summarizers/index.js";

describe("lookupSummarizer", () => {
	it("returns Unknown summarizer for unregistered tool names", () => {
		const summarizer = lookupSummarizer("NonexistentTool");
		expect(summarizer.tool).toBe("Unknown");
	});

	it("never returns undefined", () => {
		const summarizer = lookupSummarizer("AnythingAtAll");
		expect(summarizer).toBeDefined();
		expect(typeof summarizer.summarize).toBe("function");
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/frontend/tool-summarizers/`
Expected: FAIL — modules not found

**Step 3: Create the files**

Create `src/lib/frontend/utils/tool-summarizers/types.ts`:

```ts
import type { CanonicalToolInput } from "../../../persistence/events.js";

export type ToolSummary = {
	subtitle?: string;
	tags?: string[];
	expandedContent?: ExpandedContent;
};

export type ExpandedContent =
	| { kind: "code"; language: string; content: string }
	| { kind: "path"; filePath: string; offset?: number; limit?: number }
	| { kind: "link"; url: string; label: string }
	| { kind: "diff"; before: string; after: string }
	| { kind: "text"; body: string };

export interface SummarizerContext {
	repoRoot?: string;
}

export type ToolSummarizer<I extends CanonicalToolInput = CanonicalToolInput> = {
	readonly tool: I["tool"];
	summarize(input: I, ctx: SummarizerContext): ToolSummary;
};
```

Create `src/lib/frontend/utils/tool-summarizers/unknown.ts`:

```ts
import type { CanonicalToolInput } from "../../../persistence/events.js";
import type { SummarizerContext, ToolSummarizer, ToolSummary } from "./types.js";

type UnknownInput = Extract<CanonicalToolInput, { tool: "Unknown" }>;

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}...` : s;
}

export const unknownSummarizer: ToolSummarizer<UnknownInput> = {
	tool: "Unknown",
	summarize(input: UnknownInput, _ctx: SummarizerContext): ToolSummary {
		const json = JSON.stringify(input.raw);
		return {
			subtitle: truncate(json, 60),
			expandedContent: {
				kind: "text",
				body: JSON.stringify(input.raw, null, 2),
			},
		};
	},
};
```

Create `src/lib/frontend/utils/tool-summarizers/registry.ts` (the Map + registration function — separate file to break circular dependency):

> **CRITICAL:** The registry Map and `registerSummarizer` MUST live in a separate `registry.ts` file, NOT in `index.ts`. If `index.ts` both owns the Map and side-effect-imports per-tool modules that call `registerSummarizer`, a circular dependency forms: `index.ts` → `read.ts` → `index.ts`. In ESM, `SUMMARIZERS` (a `const`) would be in the temporal dead zone when `read.ts` evaluates, causing a `ReferenceError`. Splitting into `registry.ts` breaks the cycle.

```ts
import type { ToolSummarizer } from "./types.js";
import { unknownSummarizer } from "./unknown.js";

// Registry: populated by per-tool modules via registerSummarizer().
const SUMMARIZERS = new Map<string, ToolSummarizer>([
	["Unknown", unknownSummarizer],
]);

/**
 * Look up the summarizer for a tool name.
 * Falls through to Unknown summarizer if no match — never returns undefined.
 */
export function lookupSummarizer(name: string): ToolSummarizer {
	return SUMMARIZERS.get(name) ?? unknownSummarizer;
}

/** Register a summarizer (used by per-tool modules at import time). */
export function registerSummarizer(summarizer: ToolSummarizer): void {
	SUMMARIZERS.set(summarizer.tool, summarizer);
}
```

Create `src/lib/frontend/utils/tool-summarizers/index.ts` (re-exports + side-effect imports):

```ts
// Re-export registry functions (from registry.ts, NOT defined here)
export { lookupSummarizer, registerSummarizer } from "./registry.js";
export type { ToolSummary, ExpandedContent, SummarizerContext, ToolSummarizer } from "./types.js";

// Side-effect imports for per-tool summarizers — these call registerSummarizer
// from registry.ts (no circular dependency since index.ts doesn't own the Map).
// Added incrementally in Tasks 13-14.
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/frontend/tool-summarizers/`
Expected: PASS

**Step 5: Run verification**

Run: `pnpm check && pnpm lint`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/frontend/utils/tool-summarizers/ test/unit/frontend/tool-summarizers/
git commit -m "feat: add tool summarizer registry with ToolSummary types and Unknown fallback

Phase 3 foundation. Registry + types + Unknown summarizer that renders
JSON preview for any unregistered tool. lookupSummarizer never returns
undefined."
```

---

### Task 13: Port Read, Edit, Write, Bash summarizers

**Files:**
- Create: `src/lib/frontend/utils/tool-summarizers/read.ts`
- Create: `src/lib/frontend/utils/tool-summarizers/edit.ts`
- Create: `src/lib/frontend/utils/tool-summarizers/write.ts`
- Create: `src/lib/frontend/utils/tool-summarizers/bash.ts`
- Modify: `src/lib/frontend/utils/tool-summarizers/index.ts`
- Test: `test/unit/frontend/tool-summarizers/read.test.ts` (create)
- Test: `test/unit/frontend/tool-summarizers/bash.test.ts` (create)

**Step 1: Write the failing tests**

Create `test/unit/frontend/tool-summarizers/read.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { lookupSummarizer } from "../../../../src/lib/frontend/utils/tool-summarizers/index.js";

describe("Read summarizer", () => {
	it("returns filePath as subtitle", () => {
		const s = lookupSummarizer("Read");
		const result = s.summarize(
			{ tool: "Read", filePath: "/src/main.ts" } as never,
			{},
		);
		expect(result.subtitle).toBe("/src/main.ts");
	});

	it("strips repoRoot from filePath", () => {
		const s = lookupSummarizer("Read");
		const result = s.summarize(
			{ tool: "Read", filePath: "/home/user/project/src/main.ts" } as never,
			{ repoRoot: "/home/user/project" },
		);
		expect(result.subtitle).toBe("src/main.ts");
	});

	it("includes offset and limit as tags", () => {
		const s = lookupSummarizer("Read");
		const result = s.summarize(
			{ tool: "Read", filePath: "/f.ts", offset: 10, limit: 50 } as never,
			{},
		);
		expect(result.tags).toContain("offset:10");
		expect(result.tags).toContain("limit:50");
	});

	it("returns path expandedContent", () => {
		const s = lookupSummarizer("Read");
		const result = s.summarize(
			{ tool: "Read", filePath: "/f.ts", offset: 10, limit: 50 } as never,
			{},
		);
		expect(result.expandedContent).toEqual({
			kind: "path",
			filePath: "/f.ts",
			offset: 10,
			limit: 50,
		});
	});

	it("handles empty filePath", () => {
		const s = lookupSummarizer("Read");
		const result = s.summarize({ tool: "Read", filePath: "" } as never, {});
		expect(result.subtitle).toBeUndefined();
	});
});
```

Create `test/unit/frontend/tool-summarizers/bash.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { lookupSummarizer } from "../../../../src/lib/frontend/utils/tool-summarizers/index.js";

describe("Bash summarizer", () => {
	it("prefers command over description for subtitle", () => {
		const s = lookupSummarizer("Bash");
		const result = s.summarize(
			{ tool: "Bash", command: "ls -la", description: "list files" } as never,
			{},
		);
		expect(result.subtitle).toBe("ls -la");
	});

	it("truncates long commands at 40 chars", () => {
		const s = lookupSummarizer("Bash");
		const long = "x".repeat(60);
		const result = s.summarize(
			{ tool: "Bash", command: long } as never,
			{},
		);
		expect(result.subtitle!.length).toBeLessThanOrEqual(41);
	});

	it("falls back to description when command is empty", () => {
		const s = lookupSummarizer("Bash");
		const result = s.summarize(
			{ tool: "Bash", command: "", description: "install deps" } as never,
			{},
		);
		expect(result.subtitle).toBe("install deps");
	});

	it("returns code expandedContent with shell language", () => {
		const s = lookupSummarizer("Bash");
		const result = s.summarize(
			{ tool: "Bash", command: "npm install" } as never,
			{},
		);
		expect(result.expandedContent).toEqual({
			kind: "code",
			language: "shell",
			content: "$ npm install",
		});
	});

	it("handles no command and no description", () => {
		const s = lookupSummarizer("Bash");
		const result = s.summarize({ tool: "Bash", command: "" } as never, {});
		expect(result.subtitle).toBeUndefined();
	});
});

describe("Edit summarizer", () => {
	it("returns filePath as subtitle", () => {
		const s = lookupSummarizer("Edit");
		const result = s.summarize(
			{ tool: "Edit", filePath: "/src/main.ts", oldString: "a", newString: "b" } as never,
			{},
		);
		expect(result.subtitle).toBe("/src/main.ts");
	});

	it("returns diff expandedContent when old and new strings present", () => {
		const s = lookupSummarizer("Edit");
		const result = s.summarize(
			{ tool: "Edit", filePath: "/f.ts", oldString: "foo", newString: "bar" } as never,
			{},
		);
		expect(result.expandedContent).toEqual({
			kind: "diff",
			before: "foo",
			after: "bar",
		});
	});

	it("strips repoRoot from filePath", () => {
		const s = lookupSummarizer("Edit");
		const result = s.summarize(
			{ tool: "Edit", filePath: "/home/user/project/f.ts", oldString: "a", newString: "b" } as never,
			{ repoRoot: "/home/user/project" },
		);
		expect(result.subtitle).toBe("f.ts");
	});
});

describe("Write summarizer", () => {
	it("returns filePath as subtitle", () => {
		const s = lookupSummarizer("Write");
		const result = s.summarize(
			{ tool: "Write", filePath: "/src/new.ts", content: "hello" } as never,
			{},
		);
		expect(result.subtitle).toBe("/src/new.ts");
	});

	it("handles empty filePath", () => {
		const s = lookupSummarizer("Write");
		const result = s.summarize(
			{ tool: "Write", filePath: "", content: "hello" } as never,
			{},
		);
		expect(result.subtitle).toBeUndefined();
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/frontend/tool-summarizers/`
Expected: FAIL — Read/Bash/Edit/Write summarizers not registered yet (lookupSummarizer returns Unknown)

**Step 3: Create the summarizer files**

Create `src/lib/frontend/utils/tool-summarizers/read.ts`:

```ts
import type { CanonicalToolInput } from "../../../persistence/events.js";
import { registerSummarizer } from "./registry.js";
import type { SummarizerContext, ToolSummarizer, ToolSummary } from "./types.js";

type ReadInput = Extract<CanonicalToolInput, { tool: "Read" }>;

function stripRepoRoot(filePath: string, repoRoot?: string): string {
	if (!repoRoot) return filePath;
	const prefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
	return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
}

export const readSummarizer: ToolSummarizer<ReadInput> = {
	tool: "Read",
	summarize(input: ReadInput, ctx: SummarizerContext): ToolSummary {
		const filePath = input.filePath || undefined;
		const tags: string[] = [];
		if (input.offset != null) tags.push(`offset:${input.offset}`);
		if (input.limit != null) tags.push(`limit:${input.limit}`);
		return {
			...(filePath && { subtitle: stripRepoRoot(filePath, ctx.repoRoot) }),
			...(tags.length > 0 && { tags }),
			...(filePath && {
				expandedContent: {
					kind: "path" as const,
					filePath: input.filePath,
					...(input.offset != null && { offset: input.offset }),
					...(input.limit != null && { limit: input.limit }),
				},
			}),
		};
	},
};

registerSummarizer(readSummarizer);
```

Create `src/lib/frontend/utils/tool-summarizers/edit.ts`:

```ts
import type { CanonicalToolInput } from "../../../persistence/events.js";
import { registerSummarizer } from "./registry.js";
import type { SummarizerContext, ToolSummarizer, ToolSummary } from "./types.js";

type EditInput = Extract<CanonicalToolInput, { tool: "Edit" }>;

function stripRepoRoot(filePath: string, repoRoot?: string): string {
	if (!repoRoot) return filePath;
	const prefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
	return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
}

export const editSummarizer: ToolSummarizer<EditInput> = {
	tool: "Edit",
	summarize(input: EditInput, ctx: SummarizerContext): ToolSummary {
		const filePath = input.filePath || undefined;
		return {
			...(filePath && { subtitle: stripRepoRoot(filePath, ctx.repoRoot) }),
			...(input.oldString && input.newString && {
				expandedContent: {
					kind: "diff" as const,
					before: input.oldString,
					after: input.newString,
				},
			}),
		};
	},
};

registerSummarizer(editSummarizer);
```

Create `src/lib/frontend/utils/tool-summarizers/write.ts`:

```ts
import type { CanonicalToolInput } from "../../../persistence/events.js";
import { registerSummarizer } from "./registry.js";
import type { SummarizerContext, ToolSummarizer, ToolSummary } from "./types.js";

type WriteInput = Extract<CanonicalToolInput, { tool: "Write" }>;

function stripRepoRoot(filePath: string, repoRoot?: string): string {
	if (!repoRoot) return filePath;
	const prefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
	return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
}

export const writeSummarizer: ToolSummarizer<WriteInput> = {
	tool: "Write",
	summarize(input: WriteInput, ctx: SummarizerContext): ToolSummary {
		const filePath = input.filePath || undefined;
		return {
			...(filePath && { subtitle: stripRepoRoot(filePath, ctx.repoRoot) }),
		};
	},
};

registerSummarizer(writeSummarizer);
```

Create `src/lib/frontend/utils/tool-summarizers/bash.ts`:

```ts
/**
 * Bash summarizer.
 *
 * Subtitle preference: `command` first, `description` fallback.
 *
 * Rationale: the user wants to see what actually ran, not what the model
 * claimed it would do. `description` is model-authored narrative prose;
 * `command` is the shell string that was executed. When both exist, the
 * shell string is more informative and more verifiable.
 *
 * History: this was accidentally the other way around before commit 6f70d0e
 * (description preferred). That was not a design choice — it was an artifact
 * of a switch-statement patch that never revisited its rationale.
 */
import type { CanonicalToolInput } from "../../../persistence/events.js";
import { registerSummarizer } from "./registry.js";
import type { SummarizerContext, ToolSummarizer, ToolSummary } from "./types.js";

type BashInput = Extract<CanonicalToolInput, { tool: "Bash" }>;

export const bashSummarizer: ToolSummarizer<BashInput> = {
	tool: "Bash",
	summarize(input: BashInput, _ctx: SummarizerContext): ToolSummary {
		const command = input.command || undefined;
		const description = input.description || undefined;

		const subtitle = command
			? command.length > 40 ? `${command.slice(0, 40)}…` : command
			: description;

		return {
			...(subtitle && { subtitle }),
			...(command && {
				expandedContent: {
					kind: "code" as const,
					language: "shell",
					content: `$ ${command}`,
				},
			}),
		};
	},
};

registerSummarizer(bashSummarizer);
```

Update `src/lib/frontend/utils/tool-summarizers/index.ts` to add the side-effect imports:

```ts
export { lookupSummarizer, registerSummarizer } from "./registry.js";
export type { ToolSummary, ExpandedContent, SummarizerContext, ToolSummarizer } from "./types.js";

// Side-effect imports — per-tool summarizers self-register via registry.ts
import "./read.js";
import "./edit.js";
import "./write.js";
import "./bash.js";
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/frontend/tool-summarizers/`
Expected: PASS

**Step 5: Run verification**

Run: `pnpm check && pnpm lint`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/frontend/utils/tool-summarizers/ test/unit/frontend/tool-summarizers/
git commit -m "feat: add Read, Edit, Write, Bash tool summarizers

Each summarizer produces typed ToolSummary with subtitle, tags, and
expandedContent. Bash includes command-preferred-over-description rationale."
```

---

### Task 14: Port Grep, Glob, WebFetch, WebSearch, Task, LSP, Skill, AskUserQuestion summarizers

**Files:**
- Create: `src/lib/frontend/utils/tool-summarizers/grep.ts`
- Create: `src/lib/frontend/utils/tool-summarizers/glob.ts`
- Create: `src/lib/frontend/utils/tool-summarizers/web-fetch.ts`
- Create: `src/lib/frontend/utils/tool-summarizers/web-search.ts`
- Create: `src/lib/frontend/utils/tool-summarizers/task.ts`
- Create: `src/lib/frontend/utils/tool-summarizers/lsp.ts`
- Create: `src/lib/frontend/utils/tool-summarizers/skill.ts`
- Create: `src/lib/frontend/utils/tool-summarizers/ask-user-question.ts`
- Modify: `src/lib/frontend/utils/tool-summarizers/index.ts`
- Test: `test/unit/frontend/tool-summarizers/remaining.test.ts` (create)

**Step 1: Write the failing tests**

Create `test/unit/frontend/tool-summarizers/remaining.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { lookupSummarizer } from "../../../../src/lib/frontend/utils/tool-summarizers/index.js";

describe("Grep summarizer", () => {
	it("returns pattern as subtitle with filter tags", () => {
		const s = lookupSummarizer("Grep");
		const result = s.summarize(
			{ tool: "Grep", pattern: "TODO", path: "/src", include: "*.ts", fileType: "ts" } as never,
			{ repoRoot: "/" },
		);
		expect(result.subtitle).toBe("TODO");
		expect(result.tags).toContain("*.ts");
		expect(result.tags).toContain("ts");
		expect(result.tags).toContain("src");
	});
});

describe("Glob summarizer", () => {
	it("returns pattern as subtitle", () => {
		const s = lookupSummarizer("Glob");
		const result = s.summarize(
			{ tool: "Glob", pattern: "**/*.ts", path: "/src" } as never,
			{ repoRoot: "/" },
		);
		expect(result.subtitle).toBe("**/*.ts");
	});
});

describe("WebFetch summarizer", () => {
	it("returns hostname as subtitle", () => {
		const s = lookupSummarizer("WebFetch");
		const result = s.summarize(
			{ tool: "WebFetch", url: "https://docs.example.com/page" } as never,
			{},
		);
		expect(result.subtitle).toBe("docs.example.com");
	});

	it("returns link expandedContent", () => {
		const s = lookupSummarizer("WebFetch");
		const result = s.summarize(
			{ tool: "WebFetch", url: "https://example.com" } as never,
			{},
		);
		expect(result.expandedContent).toEqual({
			kind: "link",
			url: "https://example.com",
			label: "example.com",
		});
	});
});

describe("WebSearch summarizer", () => {
	it("returns query as subtitle", () => {
		const s = lookupSummarizer("WebSearch");
		const result = s.summarize(
			{ tool: "WebSearch", query: "typescript generics" } as never,
			{},
		);
		expect(result.subtitle).toBe("typescript generics");
	});
});

describe("Task summarizer", () => {
	it("returns description as subtitle with subagentType tag", () => {
		const s = lookupSummarizer("Task");
		const result = s.summarize(
			{ tool: "Task", description: "find bugs", prompt: "look", subagentType: "review" } as never,
			{},
		);
		expect(result.subtitle).toBe("find bugs");
		expect(result.tags).toContain("review");
	});
});

describe("LSP summarizer", () => {
	it("returns operation as subtitle with filePath tag", () => {
		const s = lookupSummarizer("LSP");
		const result = s.summarize(
			{ tool: "LSP", operation: "hover", filePath: "/src/main.ts" } as never,
			{ repoRoot: "/" },
		);
		expect(result.subtitle).toBe("hover");
		expect(result.tags).toContain("src/main.ts");
	});
});

describe("Skill summarizer", () => {
	it("returns skill name as subtitle", () => {
		const s = lookupSummarizer("Skill");
		const result = s.summarize({ tool: "Skill", name: "commit" } as never, {});
		expect(result.subtitle).toBe("commit");
	});
});

describe("AskUserQuestion summarizer", () => {
	it("returns first question header as subtitle", () => {
		const s = lookupSummarizer("AskUserQuestion");
		const result = s.summarize(
			{
				tool: "AskUserQuestion",
				questions: [{ header: "Confirm action", question: "Continue?" }],
			} as never,
			{},
		);
		expect(result.subtitle).toBe("Confirm action");
	});

	it("returns 'Question' when no questions provided", () => {
		const s = lookupSummarizer("AskUserQuestion");
		const result = s.summarize(
			{ tool: "AskUserQuestion", questions: null } as never,
			{},
		);
		expect(result.subtitle).toBe("Question");
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/frontend/tool-summarizers/remaining.test.ts`
Expected: FAIL — summarizers not registered

**Step 3: Create all remaining summarizer files**

Each follows the same pattern as Read/Bash. Port the logic from `extractToolSummary` in `group-tools.ts` into individual files. Create each file with its `ToolSummarizer` + `registerSummarizer` call, mirroring the exact logic from the switch cases in `group-tools.ts:97-233`.

For brevity, here are the key patterns (the implementing agent should port each case faithfully):

- **grep.ts**: subtitle = pattern, tags = [include, fileType, path]
- **glob.ts**: subtitle = pattern, tags = [path]
- **web-fetch.ts**: subtitle = hostname from URL, expandedContent = link
- **web-search.ts**: subtitle = query
- **task.ts**: subtitle = description, tags = [subagentType]
- **lsp.ts**: subtitle = operation, tags = [filePath]
- **skill.ts**: subtitle = name
- **ask-user-question.ts**: subtitle = first question header/question, fallback "Question"

Update `src/lib/frontend/utils/tool-summarizers/index.ts` to add remaining side-effect imports:

```ts
export { lookupSummarizer, registerSummarizer } from "./registry.js";
export type { ToolSummary, ExpandedContent, SummarizerContext, ToolSummarizer } from "./types.js";

// Side-effect imports — per-tool summarizers self-register via registry.ts
import "./read.js";
import "./edit.js";
import "./write.js";
import "./bash.js";
import "./grep.js";
import "./glob.js";
import "./web-fetch.js";
import "./web-search.js";
import "./task.js";
import "./lsp.js";
import "./skill.js";
import "./ask-user-question.js";
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/frontend/tool-summarizers/`
Expected: PASS

**Step 5: Run verification**

Run: `pnpm check && pnpm lint`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/frontend/utils/tool-summarizers/ test/unit/frontend/tool-summarizers/remaining.test.ts
git commit -m "feat: add Grep, Glob, WebFetch, WebSearch, Task, LSP, Skill, AskUserQuestion summarizers

All tool types now have dedicated summarizer modules. Logic ported from
extractToolSummary switch with identical behavior."
```

---

### Task 15: Wire `ToolGroupItem` and `ToolGenericCard` to use summarizer registry

**Files:**
- Create: `src/lib/frontend/utils/tool-summarizers/ensure-canonical.ts`
- Modify: `src/lib/frontend/components/chat/ToolGroupItem.svelte:8,16`
- Modify: `src/lib/frontend/components/chat/ToolGenericCard.svelte:8,91`

**Step 0: Create a helper for runtime normalization of legacy input**

> Historical messages loaded from DB may have raw provider-specific input without the `tool` discriminant. The fallback `message.input ?? { tool: "Unknown" }` only handles null/undefined, not pre-normalization objects. We need a runtime guard.

Create a small helper in `src/lib/frontend/utils/tool-summarizers/ensure-canonical.ts`:

```ts
import type { CanonicalToolInput } from "../../../persistence/events.js";
// Import OpenCode normalizer as default — it handles camelCase passthrough
import { normalizeToolInput } from "../../../provider/opencode/normalize-tool-input.js";

/**
 * Ensure input has CanonicalToolInput shape.
 * If input already has a `tool` discriminant, pass through.
 * If input is raw (pre-normalization / historical), normalize it.
 * If input is null/undefined, return Unknown fallback.
 */
export function ensureCanonical(
	name: string,
	input: unknown,
): CanonicalToolInput {
	if (!input || typeof input !== "object") {
		return { tool: "Unknown", name, raw: {} };
	}
	const record = input as Record<string, unknown>;
	if (typeof record["tool"] === "string") {
		return record as unknown as CanonicalToolInput;
	}
	return normalizeToolInput(name, record);
}
```

**Step 1: Update ToolGroupItem.svelte**

Replace the `extractToolSummary` import and usage:

```svelte
<!-- Before -->
import { extractToolSummary } from "../../utils/group-tools.js";
<!-- After -->
import { lookupSummarizer } from "../../utils/tool-summarizers/index.js";
import { ensureCanonical } from "../../utils/tool-summarizers/ensure-canonical.js";
```

Replace the `summary` derived:

```svelte
<!-- Before -->
const summary = $derived(extractToolSummary(message.name, message.input));
<!-- After -->
const summary = $derived(
	lookupSummarizer(message.name).summarize(
		ensureCanonical(message.name, message.input),
		{},
	),
);
```

**Step 2: Update ToolGenericCard.svelte**

Same import replacement (add both `lookupSummarizer` and `ensureCanonical`). Replace:

```svelte
<!-- Before -->
const toolSummary = $derived(extractToolSummary(message.name, message.input as Record<string, unknown> | undefined));
<!-- After -->
const toolSummary = $derived(
	lookupSummarizer(message.name).summarize(
		ensureCanonical(message.name, message.input),
		{},
	),
);
```

**Step 3: Run verification**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/lib/frontend/components/chat/ToolGroupItem.svelte src/lib/frontend/components/chat/ToolGenericCard.svelte
git commit -m "feat: wire ToolGroupItem and ToolGenericCard to summarizer registry

Both components now use lookupSummarizer() instead of extractToolSummary().
Grouping UX unchanged — ToolGroupCard.svelte is untouched."
```

---

### Task 16: Delete `extractToolSummary` and `readStr` from `group-tools.ts`

**Files:**
- Modify: `src/lib/frontend/utils/group-tools.ts:60-233`

**Step 1: Verify no remaining callers**

Run: `pnpm vitest run test/unit/frontend/` — all tests should pass using the new registry.

Search for remaining `extractToolSummary` references:

```bash
grep -r "extractToolSummary" src/ test/ --include="*.ts" --include="*.svelte"
```

Expected: Only `group-tools.ts` itself and `group-tools-summary.test.ts` (if created in Task 8). If other callers exist, migrate them first.

**Step 2: Delete the functions**

Remove from `group-tools.ts`:
- `stripRepoRoot` function (lines 62-68) — moved to individual summarizers
- `extractHostname` function (lines 70-76) — moved to individual summarizers
- `readStr` function (lines 86-95)
- `extractToolSummary` function (lines 97-233)

Remove the `export` from `extractToolSummary` in any barrel/index file.

**Step 3: Update or delete `group-tools-summary.test.ts`**

If created in Task 8, delete it — the per-tool summarizer tests now cover this.

**Step 4: Run verification**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/frontend/utils/group-tools.ts test/unit/frontend/
git commit -m "refactor: delete extractToolSummary and readStr from group-tools.ts

All tool summary logic now lives in per-tool summarizer modules. No more
alias-drift risk from readStr. groupMessages, getToolCategory, and all
grouping logic are preserved unchanged."
```

---

### Task 17: Grouping regression test

**Files:**
- Test: `test/unit/frontend/group-tools-grouping.test.ts` (create)

**Step 1: Write the regression test**

```ts
import { describe, expect, it } from "vitest";
import { groupMessages, type GroupedMessage, type ToolGroup } from "../../../src/lib/frontend/utils/group-tools.js";
import type { ToolMessage, ChatMessage } from "../../../src/lib/frontend/types.js";

function toolMsg(id: string, name: string, status: "completed" | "running" = "completed"): ToolMessage {
	return {
		type: "tool",
		id,
		uuid: `uuid-${id}`,
		name,
		status,
		input: { tool: name, filePath: `/src/${id}.ts` },
	} as ToolMessage;
}

describe("groupMessages — regression", () => {
	it("consecutive same-category tools collapse into a ToolGroup", () => {
		const messages: ChatMessage[] = [
			toolMsg("1", "Read"),
			toolMsg("2", "Grep"),
			toolMsg("3", "Glob"),
		];
		const grouped = groupMessages(messages);
		expect(grouped).toHaveLength(1);
		expect((grouped[0] as ToolGroup).type).toBe("tool-group");
		expect((grouped[0] as ToolGroup).tools).toHaveLength(3);
		expect((grouped[0] as ToolGroup).label).toBe("Explored");
	});

	it("AskUserQuestion is never grouped", () => {
		const messages: ChatMessage[] = [
			toolMsg("1", "Read"),
			toolMsg("2", "AskUserQuestion"),
			toolMsg("3", "Read"),
		];
		const grouped = groupMessages(messages);
		expect(grouped).toHaveLength(3);
		expect((grouped[1] as ToolMessage).name).toBe("AskUserQuestion");
	});

	it("Task is never grouped", () => {
		const messages: ChatMessage[] = [
			toolMsg("1", "Task"),
			toolMsg("2", "Task"),
		];
		const grouped = groupMessages(messages);
		expect(grouped).toHaveLength(2); // Two solo ToolMessages, not a group
	});

	it("Skill is never grouped", () => {
		const messages: ChatMessage[] = [
			toolMsg("1", "Skill"),
			toolMsg("2", "Skill"),
		];
		const grouped = groupMessages(messages);
		expect(grouped).toHaveLength(2);
	});

	it("solo tool stays as ToolMessage", () => {
		const messages: ChatMessage[] = [toolMsg("1", "Bash")];
		const grouped = groupMessages(messages);
		expect(grouped).toHaveLength(1);
		expect((grouped[0] as ToolMessage).type).toBe("tool");
	});

	it("different categories are not grouped together", () => {
		const messages: ChatMessage[] = [
			toolMsg("1", "Read"),  // explore
			toolMsg("2", "Edit"),  // edit
			toolMsg("3", "Bash"),  // shell
		];
		const grouped = groupMessages(messages);
		expect(grouped).toHaveLength(3);
	});

	it("mixed category→group transitions work", () => {
		const messages: ChatMessage[] = [
			toolMsg("1", "Read"),
			toolMsg("2", "Grep"),  // same category as Read → group
			toolMsg("3", "Bash"),  // different → solo
			toolMsg("4", "Edit"),
			toolMsg("5", "Write"), // same category as Edit → group
		];
		const grouped = groupMessages(messages);
		expect(grouped).toHaveLength(3);
		expect((grouped[0] as ToolGroup).type).toBe("tool-group");
		expect((grouped[0] as ToolGroup).tools).toHaveLength(2);
		expect((grouped[1] as ToolMessage).name).toBe("Bash");
		expect((grouped[2] as ToolGroup).type).toBe("tool-group");
		expect((grouped[2] as ToolGroup).tools).toHaveLength(2);
	});
});
```

**Step 2: Run test**

Run: `pnpm vitest run test/unit/frontend/group-tools-grouping.test.ts`
Expected: PASS — grouping logic is unchanged

**Step 3: Commit**

```bash
git add test/unit/frontend/group-tools-grouping.test.ts
git commit -m "test: add grouping regression test for tool-input-rendering Phase 3

Proves that groupMessages behavior is byte-identical after the summarizer
registry migration: same-category grouping, AskUserQuestion/Task/Skill
bypass, solo tools, and category transitions."
```

---

## Summary

| Phase | Tasks | Key outcome |
|-------|-------|-------------|
| 0 | 1–2 | `TranslationResult` discriminated union; no silent `[]` without compiler signal |
| 1 | 3–8 | `CanonicalToolInput` at adapter boundary; typed field access; `schemaVersion` upcast |
| 2 | 9–11 | Buffered `tool.started`; `tool.input_updated` deleted; registry merge narrowed |
| 3 | 12–17 | Per-tool summarizer registry; `extractToolSummary` deleted; grouping preserved |
