// ─── End-to-end: subagent turn → sidebar processing dot ─────────────────────
// The translator-level regression test (regression-subagent-activity.test.ts)
// proves the right ProviderRuntimeEvents come out. This one carries a real
// captured subagent turn all the way to the surface the user complained about:
//   translator → domain mapper → event store → session projector
//   → sessions.status → session list adapter → SessionInfo.processing
// Two failures live on this path and only this test sees both:
//   1. reporting idle mid-turn (dot goes dark while the subagent works)
//   2. never releasing busy (dot sticks on forever after the turn ends)

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Reactivity } from "@effect/experimental";
import { SqlClient } from "@effect/sql";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { decodeClaudeSDKMessage } from "../../../../src/lib/contracts/providers/claude-agent-sdk.js";
import type { ProviderRuntimeEvent } from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import {
	EventStoreEffectTag,
	makeEventStoreEffect,
} from "../../../../src/lib/persistence/effect/event-store-effect.js";
import { makeEffectSqlMigrator } from "../../../../src/lib/persistence/effect/migrations.js";
import {
	makeProjectionRunnerEffect,
	ProjectionRunnerEffectTag,
} from "../../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	makeProjectorCursorEffect,
	ProjectorCursorEffectTag,
} from "../../../../src/lib/persistence/effect/projector-cursor-effect.js";
import { createAllEffectProjectors } from "../../../../src/lib/persistence/effect/projectors-effect.js";
import { canonicalEvent } from "../../../../src/lib/persistence/events.js";
import type { SessionRow } from "../../../../src/lib/persistence/read-query-service.js";
import { sessionRowsToSessionInfoList } from "../../../../src/lib/persistence/session-list-adapter.js";
import { ClaudeEventTranslator } from "../../../../src/lib/provider/claude/claude-event-translator.js";
import type {
	ClaudeSessionContext,
	SDKMessage,
} from "../../../../src/lib/provider/claude/types.js";
import {
	emptyProviderRuntimeDomainMapperState,
	translateProviderRuntimeEventToDomain,
} from "../../../../src/lib/provider/provider-runtime-event-to-domain.js";
import type { EventSink } from "../../../../src/lib/provider/types.js";

const SESSION_ID = "parent-session";
const TRACE = join(
	import.meta.dirname,
	"../../../fixtures/claude-sdk-traces/subagent-task-turn.jsonl",
);

// ─── Stage 1: SDK messages → ProviderRuntimeEvents ──────────────────────────

function makeCtx(): ClaudeSessionContext {
	return {
		sessionId: SESSION_ID,
		workspaceRoot: "/tmp/ws",
		startedAt: "2026-08-12T00:00:00.000Z",
		promptQueue: {} as unknown as ClaudeSessionContext["promptQueue"],
		query: {} as unknown as ClaudeSessionContext["query"],
		pendingApprovals: new Map(),
		pendingQuestions: new Map(),
		inFlightTools: new Map(),
		eventSink: undefined,
		currentTurnId: "turn-1",
		turnInFlight: true,
		currentModel: "claude-sonnet-5",
		resumeSessionId: undefined,
		lastAssistantUuid: undefined,
		turnCount: 0,
		stopped: false,
	};
}

async function runtimeEvents(): Promise<ProviderRuntimeEvent[]> {
	const events: ProviderRuntimeEvent[] = [];
	const sink: EventSink = {
		push: (event: ProviderRuntimeEvent) =>
			Effect.sync(() => {
				events.push(event);
			}),
		requestPermission: vi.fn(() =>
			Effect.succeed({ decision: "once" as const }),
		),
		requestQuestion: vi.fn(() => Effect.succeed({})),
		resolvePermission: vi.fn(() => Effect.void),
		resolveQuestion: vi.fn(() => Effect.void),
	};
	const ctx = makeCtx();
	const translator = new ClaudeEventTranslator({ getSink: () => sink });
	for (const line of readFileSync(TRACE, "utf8").split("\n")) {
		if (!line.trim()) continue;
		const message = decodeClaudeSDKMessage(JSON.parse(line)) as SDKMessage;
		await Effect.runPromise(translator.translate(ctx, message));
	}
	return events;
}

// ─── Stage 2: persistence layer ─────────────────────────────────────────────

function makeTestLayer() {
	const dir = mkdtempSync(join(tmpdir(), "conduit-subagent-activity-"));
	const sqlite = SqliteNode.layer({ filename: join(dir, "events.db") }).pipe(
		Layer.provide(Reactivity.layer),
		Layer.merge(
			Layer.scopedDiscard(
				Effect.addFinalizer(() =>
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			),
		),
	);
	const base = Layer.merge(
		sqlite,
		Layer.effectDiscard(makeEffectSqlMigrator()).pipe(Layer.provide(sqlite)),
	);
	const eventStore = Layer.effect(
		EventStoreEffectTag,
		makeEventStoreEffect,
	).pipe(Layer.provide(base));
	const cursor = Layer.effect(
		ProjectorCursorEffectTag,
		makeProjectorCursorEffect,
	).pipe(Layer.provide(base));
	const runner = Layer.effect(
		ProjectionRunnerEffectTag,
		makeProjectionRunnerEffect(createAllEffectProjectors()),
	).pipe(Layer.provide(Layer.merge(cursor, base)));
	return Layer.mergeAll(base, eventStore, cursor, runner);
}

/** Exactly what the status poller reads and hands the sidebar adapter. */
const readProcessing = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const rows =
		yield* sql<SessionRow>`SELECT * FROM sessions WHERE id = ${SESSION_ID}`;
	const statuses = Object.fromEntries(
		rows.map((row) => [row.id, { type: String(row.status) }]),
	);
	const [info] = sessionRowsToSessionInfoList(Array.from(rows), { statuses });
	return info?.processing === true;
});

/** Replay the turn, sampling the sidebar's processing flag after every event. */
const project = Effect.gen(function* () {
	const store = yield* EventStoreEffectTag;
	const runner = yield* ProjectionRunnerEffectTag;
	yield* runner.recover();

	const samples: { type: string; processing: boolean }[] = [];
	const apply = (event: Parameters<typeof store.append>[0]) =>
		Effect.gen(function* () {
			const stored = yield* store.append(event);
			yield* runner.projectEvent(stored);
			samples.push({ type: event.type, processing: yield* readProcessing });
		});

	yield* apply(
		canonicalEvent("session.created", SESSION_ID, {
			sessionId: SESSION_ID,
			title: "Subagent turn",
			provider: "claude",
		}),
	);

	let state = emptyProviderRuntimeDomainMapperState;
	for (const event of yield* Effect.promise(runtimeEvents)) {
		const mapped = translateProviderRuntimeEventToDomain(event, state);
		state = mapped.state;
		for (const canonical of mapped.events) yield* apply(canonical);
	}
	return samples;
});

const replay = () =>
	Effect.runPromise(
		Effect.provide(project, makeTestLayer()) as Effect.Effect<
			{ type: string; processing: boolean }[]
		>,
	);

describe("subagent turn → sidebar processing dot", () => {
	it("keeps the dot lit for the whole turn, then clears it", async () => {
		const samples = await replay();

		const first = samples.findIndex((s) => s.processing);
		const end = samples.findIndex((s) => s.type === "turn.completed");
		expect(first).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(first);

		// Mid-turn: the main agent is assistant-silent while the Task subagent
		// runs, but the session is still working — the dot must stay lit.
		const dark = samples
			.slice(first, end + 1)
			.filter((s) => !s.processing)
			.map((s) => s.type);
		expect(dark, "sidebar dot went dark mid-turn").toEqual([]);

		// And the lease must actually be released, or it sticks on forever.
		expect(samples.at(-1)?.processing).toBe(false);
	});
});
