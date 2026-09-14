// ─── Captured-trace replay: the Provider Contract, pinned by real wire ──────
// Every fixture under test/fixtures/claude-sdk-traces/ is REAL Claude Agent
// SDK traffic captured via CONDUIT_CLAUDE_SDK_CAPTURE (see sdk-trace-capture.ts
// and docs/adr/0002). Hand-written fixtures encode what we BELIEVE the SDK
// emits; these encode what it actually emitted — the 2026-07-15 incident
// (undocumented `ping` keepalives, per-block snapshots with restarted content
// indexes) diverged from belief in exactly the ways hand-written fixtures
// couldn't catch.
//
// Two contracts are pinned per trace:
// 1. Decode: every captured message must decode against ClaudeSDKMessageSchema.
//    A failure here after an SDK upgrade means the vocabulary drifted — extend
//    the schema (and capture a fresh trace), don't loosen the assert.
// 2. Translate: replaying the trace through ClaudeEventTranslator must satisfy
//    the canonical stream invariants and emit each text exactly once.
//
// To add a fixture: run any real Claude turn (e.g. an integration test) with
// CONDUIT_CLAUDE_SDK_CAPTURE=<dir>, review the trace for private hook/memory
// output (redact string contents, never envelope fields), and drop it here.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { decodeClaudeSDKMessage } from "../../../../src/lib/contracts/providers/claude-agent-sdk.js";
import type { ProviderRuntimeEvent } from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import type { Logger } from "../../../../src/lib/logger.js";
import { ClaudeEventTranslator } from "../../../../src/lib/provider/claude/claude-event-translator.js";
import type {
	ClaudeSessionContext,
	SDKMessage,
} from "../../../../src/lib/provider/claude/types.js";
import type { EventSink } from "../../../../src/lib/provider/types.js";
import { assertProviderRuntimeStreamInvariants } from "../../../helpers/provider-runtime-stream-invariants.js";

const TRACES_DIR = join(
	import.meta.dirname,
	"../../../fixtures/claude-sdk-traces",
);

const traceFiles = readdirSync(TRACES_DIR).filter((name) =>
	name.endsWith(".jsonl"),
);

function makeStubSink(): EventSink & { events: ProviderRuntimeEvent[] } {
	const events: ProviderRuntimeEvent[] = [];
	return {
		events,
		push: vi.fn((event: ProviderRuntimeEvent) =>
			Effect.sync(() => {
				events.push(event);
			}),
		),
		requestPermission: vi.fn(() =>
			Effect.succeed({ decision: "once" as const }),
		),
		requestQuestion: vi.fn(() => Effect.succeed({})),
		resolvePermission: vi.fn(() => Effect.void),
		resolveQuestion: vi.fn(() => Effect.void),
	};
}

function makeCtx(): ClaudeSessionContext {
	return {
		sessionId: "trace-replay-session",
		workspaceRoot: "/tmp/ws",
		startedAt: "2026-07-16T00:00:00.000Z",
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
		currentTurnId: "turn-1",
		currentModel: "claude-fable-5",
		resumeSessionId: undefined,
		lastAssistantUuid: undefined,
		turnCount: 0,
		stopped: false,
	};
}

function makeStubLogger(warnings: string[]): Logger {
	const logger: Logger = {
		debug: () => {},
		verbose: () => {},
		info: () => {},
		warn: (...args: unknown[]) => {
			warnings.push(String(args[0]));
		},
		error: () => {},
		child: () => logger,
	};
	return logger;
}

type Part = { readonly kind: "text" | "thinking"; readonly text: string };

/** The assistant text the translator actually emitted, one entry per part in
 *  the order the parts first produced text. */
function emittedParts(events: readonly ProviderRuntimeEvent[]): Part[] {
	const byPart = new Map<string, { kind: Part["kind"]; text: string }>();
	for (const event of events) {
		if (event.type !== "text.delta" && event.type !== "thinking.delta") {
			continue;
		}
		const data = event.data as { partId: string; text: string };
		const existing = byPart.get(data.partId);
		if (existing) {
			existing.text += data.text;
			continue;
		}
		byPart.set(data.partId, {
			kind: event.type === "text.delta" ? "text" : "thinking",
			text: data.text,
		});
	}
	return [...byPart.values()];
}

/** The assistant text the SDK itself reported, read straight off the trace:
 *  content_block_deltas for the main chain, and snapshot text for frames that
 *  only ever arrive as snapshots (subagents carry a parent_tool_use_id). */
function streamedParts(rawLines: readonly unknown[]): Part[] {
	const parts: { kind: Part["kind"]; text: string }[] = [];
	let open = new Map<number, { kind: Part["kind"]; text: string }>();
	for (const raw of rawLines) {
		if (!isRecord(raw)) continue;
		if (raw["type"] === "assistant" && raw["parent_tool_use_id"] != null) {
			const message = isRecord(raw["message"]) ? raw["message"] : undefined;
			const content = message?.["content"];
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				if (!isRecord(block)) continue;
				const kind: Part["kind"] =
					block["type"] === "text" ? "text" : "thinking";
				const text = block[kind === "text" ? "text" : "thinking"];
				if (typeof text === "string" && text.length > 0) {
					parts.push({ kind, text });
				}
			}
			continue;
		}
		if (raw["type"] !== "stream_event" || !isRecord(raw["event"])) continue;
		const event = raw["event"];
		if (event["type"] === "message_start") {
			open = new Map();
			continue;
		}
		if (event["type"] === "content_block_start") {
			const block = isRecord(event["content_block"])
				? event["content_block"]
				: undefined;
			if (block?.["type"] !== "text" && block?.["type"] !== "thinking") {
				continue;
			}
			const kind: Part["kind"] = block["type"] === "text" ? "text" : "thinking";
			const initial = block[kind === "text" ? "text" : "thinking"];
			const part = {
				kind,
				text: typeof initial === "string" ? initial : "",
			};
			parts.push(part);
			open.set(Number(event["index"]), part);
			continue;
		}
		if (event["type"] === "content_block_delta") {
			const part = open.get(Number(event["index"]));
			const delta = isRecord(event["delta"]) ? event["delta"] : undefined;
			if (!part || !delta) continue;
			const chunk =
				delta["type"] === "text_delta"
					? delta["text"]
					: delta["type"] === "thinking_delta"
						? delta["thinking"]
						: undefined;
			if (typeof chunk === "string") part.text += chunk;
		}
	}
	return parts.filter((part) => part.text.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

describe("Claude SDK captured-trace replay", () => {
	it("has at least one committed trace fixture", () => {
		expect(traceFiles.length).toBeGreaterThan(0);
	});

	describe.each(traceFiles)("%s", (file) => {
		const rawLines = readFileSync(join(TRACES_DIR, file), "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as unknown);

		it("decodes every captured message (SDK vocabulary contract)", () => {
			for (const [index, raw] of rawLines.entries()) {
				try {
					decodeClaudeSDKMessage(raw);
				} catch (cause) {
					throw new Error(
						`captured message ${index} no longer decodes — the SDK vocabulary drifted; extend the schema, don't skip the message.\n${JSON.stringify(raw).slice(0, 400)}\n${String(cause)}`,
					);
				}
			}
		});

		it("replays through the translator without violating stream invariants", async () => {
			const sink = makeStubSink();
			const ctx = makeCtx();
			const warnings: string[] = [];
			const logger = makeStubLogger(warnings);
			const translator = new ClaudeEventTranslator({
				getSink: () => sink,
				logger,
			});

			for (const raw of rawLines) {
				const message = decodeClaudeSDKMessage(raw) as SDKMessage;
				await Effect.runPromise(translator.translate(ctx, message));
			}

			assertProviderRuntimeStreamInvariants(sink.events);

			// The trace is its own oracle. Whatever the SDK streamed as
			// content_block_deltas is what the model actually produced, so the
			// parts we emit must reproduce it byte for byte, in order — not
			// merely "no two parts are equal", which a rewritten snapshot
			// passes by minting a second, differently-worded part (2026-07-15:
			// every paragraph rendered twice; where indexes collided, spliced).
			expect(emittedParts(sink.events)).toEqual(streamedParts(rawLines));

			// A snapshot that does not extend the stream is dropped, never
			// re-sliced — and says so. The committed subagent trace carries one
			// such block: a MessageDisplay hook prepended a "[HH:MM:SS]" marker
			// to the final assistant text on its way through the SDK.
			for (const warning of warnings) {
				expect(warning).toContain("(prepended)");
			}
			expect(warnings).toHaveLength(
				file === "subagent-task-turn.jsonl" ? 1 : 0,
			);
		});
	});
});
