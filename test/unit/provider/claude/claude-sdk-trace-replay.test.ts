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
			const translator = new ClaudeEventTranslator({ getSink: () => sink });

			for (const raw of rawLines) {
				const message = decodeClaudeSDKMessage(raw) as SDKMessage;
				await Effect.runPromise(translator.translate(ctx, message));
			}

			assertProviderRuntimeStreamInvariants(sink.events);

			// Each streamed text must surface exactly once per part — the
			// per-block snapshot following it must dedupe, not duplicate
			// (2026-07-15: every assistant paragraph rendered twice).
			const textByPart = new Map<string, string>();
			for (const event of sink.events) {
				if (event.type !== "text.delta") continue;
				const data = event.data as { partId: string; text: string };
				textByPart.set(
					data.partId,
					(textByPart.get(data.partId) ?? "") + data.text,
				);
			}
			const texts = [...textByPart.values()];
			const uniqueTexts = new Set(texts);
			expect(uniqueTexts.size).toBe(texts.length);
		});
	});
});
