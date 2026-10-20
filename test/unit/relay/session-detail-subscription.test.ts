import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import {
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Queue,
	Ref,
	Scope,
	Stream,
} from "effect";
import { RpcClientError } from "effect/rpc/RpcClientError";
import { SocketCloseError } from "effect/socket/Socket";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { accountsStateFromConfig } from "../../../src/lib/account-directory.js";
import {
	decodeProviderRuntimeEvent,
	type ProviderRuntimeEvent,
} from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import type { HistoryMessageSchema } from "../../../src/lib/contracts/ws-rpc.js";
import { defaultDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import {
	AccountDirectory,
	makeAccountDirectory,
} from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { makeEffectOpenCodeRuntimeIngress } from "../../../src/lib/domain/relay/Services/opencode-runtime-ingress-service.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import type { Envelope } from "../../../src/lib/domain/relay/Services/read-model-subscription.js";
import {
	type SessionDetailItem,
	subscribeSessionDetail,
} from "../../../src/lib/domain/relay/Services/session-detail-subscription.js";
import {
	type SessionEventBus,
	SessionEventBusLive,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import {
	applyTranscriptEnvelope,
	deriveTranscriptMessages,
	type TranscriptEntry,
} from "../../../src/lib/frontend/stores/transcript.svelte.js";
import { resumeStream } from "../../../src/lib/frontend/transport/resume.js";
import { decodeSessionDetail } from "../../../src/lib/frontend/transport/session-detail-wire.js";
import type { Message } from "../../../src/lib/instance/sdk-types.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	createAllEffectProjectors,
	type EffectProjector,
	ProjectionError,
} from "../../../src/lib/persistence/effect/projectors-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
	type StoredEvent,
} from "../../../src/lib/persistence/events.js";
import { messageRowsToHistory } from "../../../src/lib/persistence/session-history-adapter.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { assembleDetailRows } from "../../helpers/detail-rows.js";
import { makeSSEEvent } from "../../helpers/sse-factories.js";

// Browser markdown rendering is outside this SQLite/subscription contract.
vi.mock("../../../src/lib/frontend/utils/markdown.js", () => ({
	renderMarkdown: (text: string) => text,
}));

let isolatedRoot: string;
beforeEach(() => {
	isolatedRoot = mkdtempSync(join(tmpdir(), "conduit-detail-login-"));
	vi.stubEnv("HOME", isolatedRoot);
	vi.stubEnv("CLAUDE_CONFIG_DIR", join(isolatedRoot, "inherited-login"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(isolatedRoot, { recursive: true, force: true });
});
const detailAccountsLayer = () =>
	Layer.succeed(AccountDirectory)(
		makeAccountDirectory(
			Effect.succeed(
				accountsStateFromConfig(
					defaultDaemonConfig(),
					configuredClaudeConfigDir(join(isolatedRoot, "launch-login")),
				),
			),
		),
	);

// A fresh temp-file persistence stack + the real SessionEventBus per test. The
// detail subscription reads the projected transcript and nothing else, so the
// contracts under test are contracts WITH the store: the version the message
// projector stamps, the advance the commit seam publishes post-COMMIT, and the
// `WHERE session_id = ? AND version > ?` query that turns one into the other.
//
// SessionEventBusLive is passed to makePersistenceEffectLayer AND merged at the
// top level: the same module-singleton layer reference, so Effect memoization
// unifies ClaudeEventPersist's publisher, the driver's publisher, and the
// subscription's listener onto one PubSub.

const makeDetailTestLayer = (options?: {
	readonly projectors?: readonly EffectProjector[];
	readonly busLayer?: Layer.Layer<SessionEventBusTag>;
}) => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-detail-sub-"));
	const filename = join(dir, "events.db");
	const busLayer = options?.busLayer ?? SessionEventBusLive;
	const cleanup = Layer.effectDiscard(
		Effect.addFinalizer(() =>
			Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
		),
	);
	return Layer.mergeAll(
		detailAccountsLayer(),
		makePersistenceEffectLayer(
			filename,
			"test-project",
			options?.projectors,
			busLayer,
		),
		busLayer,
		cleanup,
	);
};

// F4: the real ingestion service on top of the same base — one memoized layer
// reference, so ingestion's store/runner/bus ARE the ones the subscription reads.
const makeDetailIngestionTestLayer = () => {
	const base = makeDetailTestLayer();
	return Layer.merge(
		base,
		ProviderRuntimeIngestionLive.pipe(Layer.provide(base)),
	);
};

// Monotonic clock → deterministic message ordering across the suite.
let clock = 0;
const at = () => ++clock;

const sessionCreated = (sessionId: string): CanonicalEvent =>
	canonicalEvent(
		"session.created",
		sessionId,
		{ sessionId, title: "Detail Session", provider: "claude" },
		{ provider: "claude", createdAt: at() },
	);
const messageCreated = (
	sessionId: string,
	messageId: string,
	role: "user" | "assistant",
): CanonicalEvent =>
	canonicalEvent(
		"message.created",
		sessionId,
		{ messageId, role, sessionId },
		{ provider: "claude", createdAt: at() },
	);
const textDelta = (
	sessionId: string,
	messageId: string,
	partId: string,
	text: string,
): CanonicalEvent =>
	canonicalEvent(
		"text.delta",
		sessionId,
		{ messageId, partId, text },
		{ provider: "claude", createdAt: at() },
	);
const toolStarted = (
	sessionId: string,
	messageId: string,
	partId: string,
): CanonicalEvent =>
	canonicalEvent(
		"tool.started",
		sessionId,
		{
			messageId,
			partId,
			toolName: "Bash",
			callId: partId,
			input: { tool: "Bash", command: "pwd" },
		},
		{ provider: "claude", createdAt: at() },
	);
const toolCompleted = (
	sessionId: string,
	messageId: string,
	partId: string,
): CanonicalEvent =>
	canonicalEvent(
		"tool.completed",
		sessionId,
		{ messageId, partId, result: "ok", duration: 1 },
		{ provider: "claude", createdAt: at() },
	);
const turnCompleted = (sessionId: string, messageId: string): CanonicalEvent =>
	canonicalEvent(
		"turn.completed",
		sessionId,
		{ messageId },
		{ provider: "claude", createdAt: at() },
	);

// Recover projections once so projectBatch is permitted.
const recoverProjections = Effect.gen(function* () {
	const runner = yield* ProjectionRunnerEffectTag;
	yield* runner.recover();
});

const establishSession = (sessionId: string) =>
	Effect.gen(function* () {
		const eventStore = yield* EventStoreEffectTag;
		const runner = yield* ProjectionRunnerEffectTag;
		const stored = yield* eventStore.append(sessionCreated(sessionId));
		yield* runner.projectEvent(stored);
	});

/** The ingestion choke point: append → project → COMMIT → publish the advance. */
const commit = (events: readonly CanonicalEvent[]) =>
	Effect.flatMap(makeCommitAndSignal, (commitAndSignal) =>
		commitAndSignal(events),
	);

/** The number the envelopes speak in. */
const readModelVersion = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const rows = yield* sql<{ value: number }>`
		SELECT value FROM read_model_counter WHERE id = 1`;
	return rows[0]?.value ?? 0;
});

// These tests count and order transcript messages. Ignore only the rewind
// metadata row so it cannot consume a message pull or the reconnect boundary;
// the pending-state tests cover its delivery, and the wire tests retain it.
const subscribeMessages = (
	options: Parameters<typeof subscribeSessionDetail>[0],
) =>
	subscribeSessionDetail(options).pipe(
		decodeSessionDetail,
		Stream.filter(
			(envelope) =>
				envelope._tag !== "upsert" || envelope.item._tag !== "rewind",
		),
		Stream.map((envelope) =>
			envelope._tag === "snapshot"
				? {
						...envelope,
						rows: envelope.rows.filter((row) => row._tag !== "rewind"),
					}
				: envelope,
		),
	);

// Drain the subscription into a queue so the test pulls envelopes one at a time.
// The opening envelopes prove the advance subscription is already acquired — the
// orchestrator acquires it before reading the base — so a commit landing after
// that pull is guaranteed delivered, no sleeps.
const openDetail = (options: Parameters<typeof subscribeSessionDetail>[0]) =>
	Effect.gen(function* () {
		const q = yield* Queue.unbounded<Envelope<SessionDetailItem>>();
		const fiber = yield* Stream.runForEach(subscribeMessages(options), (env) =>
			Queue.offer(q, env),
		).pipe(Effect.forkScoped);
		return { q, fiber };
	});

const takeN = <A>(q: Queue.Queue<A>, n: number): Effect.Effect<A[]> =>
	Effect.forEach(Array.from({ length: n }), () => Queue.take(q));

type Row = Envelope<SessionDetailItem> | SessionDetailItem | undefined;
const itemOf = (
	row: Row,
): Extract<SessionDetailItem, { _tag: "message" | "part" }> => {
	const item = row?._tag === "upsert" ? row.item : row;
	if (item?._tag !== "message" && item?._tag !== "part")
		throw new Error(`expected a transcript row, got ${JSON.stringify(row)}`);
	return item;
};

/** What each row names: a message by its id, a part as `message/part`. */
const namesOf = (rows: readonly Row[]) =>
	rows.map((row) => {
		const item = itemOf(row);
		return item._tag === "message"
			? item.message.id
			: `${item.messageId}/${item.part.id}`;
	});

/** The messages these rows build, as far as the rows go, in header order. */
const messagesOf = (rows: readonly Row[]) => {
	const assemble = assembleDetailRows();
	const messages = new Map<string, typeof HistoryMessageSchema.Type>();
	for (const row of rows) {
		const message = assemble(itemOf(row));
		if (message) messages.set(message.id, message);
	}
	return [...messages.values()];
};

/** The one message these rows build: its header and the parts that moved. */
const expectMessage = (rows: readonly Row[]) => {
	const [message, ...others] = messagesOf(rows);
	if (!message || others.length > 0)
		throw new Error(`expected one message, got ${JSON.stringify(rows)}`);
	return message;
};

const textOf = (message: typeof HistoryMessageSchema.Type): string =>
	(message.parts ?? [])
		.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
		.join("");

const SID = "session-detail";

// Provider runtime-event factory for the real-ingestion test (F4).
const RUNTIME_BASE = {
	providerId: "claude",
	sessionId: SID,
	createdAt: "2026-07-28T00:00:00.000Z",
	rawSource: {
		kind: "claude.sdk.message",
		providerMessageType: "assistant",
	},
	providerRefs: { providerSessionId: "provider-session-detail" },
} as const;

const runtimeEvent = (event: Record<string, unknown>): ProviderRuntimeEvent =>
	decodeProviderRuntimeEvent({ ...RUNTIME_BASE, ...event });

describe("subscribeSessionDetail", () => {
	it.effect(
		"cold start includes only the newest 50 messages and a paging cursor",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([
					sessionCreated(SID),
					...Array.from({ length: 55 }, (_, index) =>
						messageCreated(
							SID,
							`m${String(index).padStart(2, "0")}`,
							"assistant",
						),
					),
				]);

				const { q } = yield* openDetail({ sessionId: SID });
				const snapshot = yield* Queue.take(q);
				if (snapshot._tag !== "snapshot") throw new Error("expected snapshot");
				expect(snapshot.rows).toHaveLength(50);
				expect(
					snapshot.rows.map((row) =>
						row._tag === "message" ? row.message.id : "part",
					),
				).toEqual(
					Array.from(
						{ length: 50 },
						(_, index) => `m${String(index + 5).padStart(2, "0")}`,
					),
				);
				expect(snapshot.hasMore).toBe(true);
				expect(snapshot.cursor).toBe("m05");
				expect(yield* Queue.take(q)).toEqual({ _tag: "synchronized" });
			}).pipe(Effect.provide(makeDetailTestLayer(), { local: true })),
	);

	it.effect("cold start emits the transcript snapshot then synchronized", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([
				sessionCreated(SID),
				messageCreated(SID, "m1", "assistant"),
				textDelta(SID, "m1", "m1-0", "Hello"),
				textDelta(SID, "m1", "m1-0", " world"),
				turnCompleted(SID, "m1"),
			]);

			const { q } = yield* openDetail({ sessionId: SID });
			const [snapshot, synchronized] = yield* takeN(q, 2);

			if (snapshot?._tag !== "snapshot") throw new Error("expected snapshot");
			expect(synchronized).toEqual({ _tag: "synchronized" });
			// The base carries the read-model version it was read at — the same
			// number a live delta or a resume will speak in.
			expect(snapshot.sequence).toBe(yield* readModelVersion);
			expect(namesOf(snapshot.rows)).toEqual(["m1/m1-0", "m1"]);
			expect(snapshot.hasMore).toBe(false);
			expect(snapshot.cursor).toBe("m1");
			const message = expectMessage(snapshot.rows);
			expect(message.id).toBe("m1");
			expect(message.role).toBe("assistant");
			expect(textOf(message)).toBe("Hello world");
		}).pipe(Effect.provide(makeDetailTestLayer(), { local: true })),
	);

	it.effect(
		"a live commit sends the message and only the parts that moved",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([
					sessionCreated(SID),
					messageCreated(SID, "m1", "assistant"),
					textDelta(SID, "m1", "m1-0", "Hello"),
				]);

				const { q } = yield* openDetail({ sessionId: SID });
				yield* takeN(q, 2);

				// Each part carries its own version, so a commit sends the parts it
				// wrote and the message they advanced, never the parts it did not.
				yield* commit([
					textDelta(SID, "m1", "m1-0", " world"),
					toolStarted(SID, "m1", "tool-1"),
					toolCompleted(SID, "m1", "tool-1"),
				]);

				const rows = yield* takeN(q, 3);
				expect(namesOf(rows)).toEqual(["m1/m1-0", "m1/tool-1", "m1"]);
				const message = expectMessage(rows);
				expect(message.id).toBe("m1");
				expect(textOf(message)).toBe("Hello world");
				expect(message.parts?.map((part) => part.type)).toEqual([
					"text",
					"tool",
				]);
				expect(message.parts?.[1]?.state?.["status"]).toBe("completed");
				expect(yield* Queue.size(q)).toBe(0);

				// Text streaming on: the finished tool part stays where it is.
				yield* commit([textDelta(SID, "m1", "m1-0", "!")]);
				const streamed = yield* takeN(q, 2);
				expect(namesOf(streamed)).toEqual(["m1/m1-0", "m1"]);
				expect(textOf(expectMessage(streamed))).toBe("Hello world!");
				expect(yield* Queue.size(q)).toBe(0);
			}).pipe(Effect.provide(makeDetailTestLayer(), { local: true })),
	);

	it.effect("the sequence on every envelope is the read-model version", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([
				sessionCreated(SID),
				messageCreated(SID, "m1", "assistant"),
			]);

			const { q } = yield* openDetail({ sessionId: SID });
			const [snapshot] = yield* takeN(q, 2);
			if (snapshot?._tag !== "snapshot") throw new Error("expected snapshot");

			// Each commit moves the message and its part, at one version.
			yield* commit([textDelta(SID, "m1", "m1-0", "one")]);
			const [first, firstPart] = yield* takeN(q, 2);
			yield* commit([textDelta(SID, "m1", "m1-0", "two")]);
			const [second, secondPart] = yield* takeN(q, 2);
			if (first?._tag !== "upsert" || second?._tag !== "upsert") {
				throw new Error("expected upserts");
			}
			expect(firstPart).toMatchObject({ sequence: first.sequence });
			expect(secondPart).toMatchObject({ sequence: second.sequence });
			// Monotone, and the last one is exactly where the read model now is:
			// change notification, resume point and high-water mark are one number.
			expect(first.sequence).toBeGreaterThan(snapshot.sequence);
			expect(second.sequence).toBeGreaterThan(first.sequence);
			expect(second.sequence).toBe(yield* readModelVersion);
		}).pipe(Effect.provide(makeDetailTestLayer(), { local: true })),
	);

	it.effect(
		"delivers what the REAL ingestion service committed, as projected messages",
		() =>
			// F4: driven through the ProviderRuntimeIngestion service — its own
			// translate → append → project → publish pipeline (spec acceptance #9).
			Effect.gen(function* () {
				yield* recoverProjections;
				const ingestion = yield* ProviderRuntimeIngestionTag;

				yield* ingestion.ingestBatch([
					runtimeEvent({
						eventId: "rt-session-created",
						type: "session.created",
						data: { sessionId: SID, title: "Detail", provider: "claude" },
					}),
					runtimeEvent({
						eventId: "rt-message-created",
						type: "message.created",
						turnId: "turn-1",
						data: { messageId: "m1", role: "assistant" },
					}),
				]);

				const { q } = yield* openDetail({ sessionId: SID });
				yield* takeN(q, 2); // snapshot + synchronized ⇒ subscribed

				yield* ingestion.ingestBatch([
					runtimeEvent({
						eventId: "rt-text-delta",
						type: "text.delta",
						turnId: "turn-1",
						data: { messageId: "m1", partId: "m1-0", text: "Hi" },
					}),
					runtimeEvent({
						eventId: "rt-tool-started",
						type: "tool.started",
						turnId: "turn-1",
						data: {
							partId: "tool-1",
							toolName: "Bash",
							input: { tool: "Bash", command: "pwd" },
						},
					}),
					runtimeEvent({
						eventId: "rt-tool-completed",
						type: "tool.completed",
						turnId: "turn-1",
						data: {
							messageId: "m1",
							partId: "tool-1",
							toolName: "Bash",
							input: { tool: "Bash", command: "pwd" },
							result: "ok",
						},
					}),
				]);

				const message = expectMessage(yield* takeN(q, 3));
				expect(message.id).toBe("m1");
				expect(textOf(message)).toBe("Hi");
				expect(message.parts?.map((part) => part.type)).toContain("tool");
				// The transcript is durable, so what a subscriber receives outlives
				// event eviction — it is the projection, not the log.
				expect(yield* Queue.size(q)).toBe(0);
			}).pipe(Effect.provide(makeDetailIngestionTestLayer(), { local: true })),
	);

	it.effect(
		"exactly-once across the base read: only messages past the base come back",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				// Subscribe mid-turn: "Hello" is already in the transcript, and an
				// older message m0 is settled.
				yield* commit([
					sessionCreated(SID),
					messageCreated(SID, "m0", "user"),
					textDelta(SID, "m0", "m0-0", "prompt"),
					messageCreated(SID, "m1", "assistant"),
					textDelta(SID, "m1", "m1-0", "Hello"),
				]);

				const { q } = yield* openDetail({ sessionId: SID });
				const [snapshot] = yield* takeN(q, 2);
				if (snapshot?._tag !== "snapshot") throw new Error("expected snapshot");
				expect(namesOf(snapshot.rows)).toEqual([
					"m0/m0-0",
					"m0",
					"m1/m1-0",
					"m1",
				]);

				yield* commit([textDelta(SID, "m1", "m1-0", " world")]);

				// Rows for the one message that moved: m0 is untouched, so its
				// version is below the floor and the query does not return it.
				const rows = yield* takeN(q, 2);
				expect(namesOf(rows)).toEqual(["m1/m1-0", "m1"]);
				const message = expectMessage(rows);
				expect(message.id).toBe("m1");
				expect(textOf(message)).toBe("Hello world");
				expect(yield* Queue.size(q)).toBe(0);
			}).pipe(Effect.provide(makeDetailTestLayer(), { local: true })),
	);

	// Over-limit resumes must choose a snapshot before reading bodies; exactly
	// the limit must still catch up. Saved pages have the smaller ten-message cap.
	it.effect.each([
		{ saved: false, messages: 50, snapshot: false },
		{ saved: false, messages: 51, snapshot: true },
		{ saved: true, messages: 10, snapshot: false },
		{ saved: true, messages: 11, snapshot: true },
	])(
		"resume with saved=$saved and $messages changes uses snapshot=$snapshot",
		(scenario) =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([sessionCreated(SID)]);
				const [base] = yield* subscribeSessionDetail({ sessionId: SID }).pipe(
					Stream.take(2),
					Stream.runCollect,
				);
				if (base?._tag !== "snapshot") throw new Error("expected snapshot");
				yield* commit(
					Array.from({ length: scenario.messages }, (_, index) =>
						messageCreated(SID, `m${index}`, "assistant"),
					),
				);
				const envelopes = yield* subscribeMessages({
					sessionId: SID,
					resumeFromSequence: base.sequence,
					resumeBase: { sequence: base.sequence },
					...(scenario.saved && base.resumePoint
						? { resumePoint: base.resumePoint }
						: {}),
				}).pipe(
					Stream.takeUntil((envelope) => envelope._tag === "synchronized"),
					Stream.runCollect,
				);
				expect(envelopes.some((envelope) => envelope._tag === "snapshot")).toBe(
					scenario.snapshot,
				);
				expect(envelopes.at(-1)?._tag).toBe("synchronized");
			}).pipe(Effect.provide(makeDetailTestLayer(), { local: true })),
	);

	it.effect.each([
		{ parts: 1, snapshot: false },
		{ parts: 200, snapshot: true },
	])(
		"one moved message with $parts parts requests snapshot=$snapshot",
		(scenario) =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([
					sessionCreated(SID),
					messageCreated(SID, "old", "assistant"),
				]);
				const after = yield* readModelVersion;
				yield* commit(
					Array.from({ length: scenario.parts }, (_, index) => [
						toolStarted(SID, "old", `p${index}`),
						toolCompleted(SID, "old", `p${index}`),
					]).flat(),
				);
				const read = yield* ReadQueryEffectTag;
				const result = yield* read.readSessionTranscriptCatchUp(SID, after, 50);
				expect(result === "snapshot").toBe(scenario.snapshot);
			}).pipe(Effect.provide(makeDetailTestLayer(), { local: true })),
	);

	it.effect("resume catches up from the cursor with no base envelope", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([
				sessionCreated(SID),
				messageCreated(SID, "m0", "user"),
				textDelta(SID, "m0", "m0-0", "held by the client"),
			]);
			const cursor = yield* readModelVersion;

			// Two messages land while the client is away.
			yield* commit([
				messageCreated(SID, "m1", "assistant"),
				textDelta(SID, "m1", "m1-0", "missed"),
			]);
			yield* commit([
				messageCreated(SID, "m2", "assistant"),
				textDelta(SID, "m2", "m2-0", "also missed"),
			]);
			const version = yield* readModelVersion;

			const { q } = yield* openDetail({
				sessionId: SID,
				resumeFromSequence: cursor,
			});

			// Timing writes also refresh the prompt the client already holds, but
			// not its text part.
			const replay = yield* takeN(q, 5);
			const boundary = yield* Queue.take(q);
			expect(boundary).toEqual({ _tag: "synchronized" });
			expect(namesOf(replay)).toEqual(["m1/m1-0", "m1", "m0", "m2/m2-0", "m2"]);
			const [, first, , , second] = replay;
			// Each replayed message carries the version of the commit that wrote
			// it, not the counter the replay happened to read. That is what lets a
			// client recognise a row it already holds as the SAME envelope rather
			// than a new one, so an unrelated commit during the gap cannot make it
			// re-deliver (T-3 suppresses a repeated identity only within one
			// sequence group).
			if (first?._tag !== "upsert" || second?._tag !== "upsert") {
				throw new Error("expected upserts");
			}
			expect(first.sequence).toBeGreaterThan(cursor);
			expect(second.sequence).toBeGreaterThan(first.sequence);
			expect(second.sequence).toBe(version);

			// And live continues from there.
			yield* commit([textDelta(SID, "m2", "m2-0", "!")]);
			expect(textOf(expectMessage(yield* takeN(q, 2)))).toBe("also missed!");
		}).pipe(Effect.provide(makeDetailTestLayer(), { local: true })),
	);

	it.effect(
		"resume reports a removed message and fresh transcript omits it",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([
					sessionCreated(SID),
					messageCreated(SID, "gone", "user"),
				]);
				const cursor = yield* readModelVersion;
				yield* commit([
					canonicalEvent("message.removed", SID, { messageId: "gone" }),
				]);
				const removalVersion = yield* readModelVersion;
				const { q } = yield* openDetail({
					sessionId: SID,
					resumeFromSequence: cursor,
				});
				expect(yield* Queue.take(q)).toEqual({
					_tag: "remove",
					id: "gone",
					sequence: removalVersion,
				});
				expect(yield* Queue.take(q)).toEqual({ _tag: "synchronized" });
				const readQuery = yield* ReadQueryEffectTag;
				expect((yield* readQuery.readSessionTranscript(SID)).messages).toEqual(
					[],
				);
			}).pipe(Effect.provide(makeDetailTestLayer(), { local: true })),
	);

	it.effect("live removal emits a remove at the committed version", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([sessionCreated(SID), messageCreated(SID, "gone", "user")]);
			const { q } = yield* openDetail({ sessionId: SID });
			expect((yield* Queue.take(q))._tag).toBe("snapshot");
			expect(yield* Queue.take(q)).toEqual({ _tag: "synchronized" });
			yield* commit([
				canonicalEvent("message.removed", SID, { messageId: "gone" }),
			]);
			expect(yield* Queue.take(q)).toEqual({
				_tag: "remove",
				id: "gone",
				sequence: yield* readModelVersion,
			});
		}).pipe(Effect.provide(makeDetailTestLayer(), { local: true })),
	);

	it.effect(
		"a deleted part is removed live and on resume, and the browser drops it",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([
					sessionCreated(SID),
					messageCreated(SID, "m1", "assistant"),
					textDelta(SID, "m1", "m1-0", "Hello"),
					toolStarted(SID, "m1", "tool-1"),
				]);
				const cursor = yield* readModelVersion;
				const { q } = yield* openDetail({ sessionId: SID });
				const opening = yield* takeN(q, 2);

				yield* commit([
					canonicalEvent("message.part.removed", SID, {
						messageId: "m1",
						partId: "tool-1",
					}),
				]);
				const version = yield* readModelVersion;
				// A part is named by its message and its own id; the removal sorts
				// before the message row it moved.
				const removed = yield* takeN(q, 2);
				expect(removed).toEqual([
					{ _tag: "remove", id: '["m1","tool-1"]', sequence: version },
					expect.objectContaining({
						_tag: "upsert",
						item: expect.objectContaining({ _tag: "message" }),
						sequence: version,
					}),
				]);
				const held = [...opening, ...removed].reduce<TranscriptEntry>(
					applyTranscriptEnvelope,
					{
						project: "project",
						rows: [],
						hwm: null,
						hasMore: false,
						status: { _tag: "live" },
						pending: [],
						waiting: new Map(),
						partOrder: new Map(),
					},
				);
				expect(held.rows[0]?.parts?.map((part) => part.id)).toEqual(["m1-0"]);

				// A client that missed it hears of the deletion from the tombstone.
				const resumed = yield* openDetail({
					sessionId: SID,
					resumeFromSequence: cursor,
				});
				expect(yield* takeN(resumed.q, 3)).toEqual([
					...removed,
					{ _tag: "synchronized" },
				]);
			}).pipe(Effect.provide(makeDetailTestLayer(), { local: true })),
	);

	for (const separateBatches of [false, true]) {
		it.effect(
			`real client resumes without repeating messages after ${separateBatches ? "multiple projection batches in one commit" : "an unrelated commit"}`,
			() =>
				Effect.gen(function* () {
					yield* recoverProjections;
					yield* commit([sessionCreated(SID)]);
					const context = yield* Effect.context<
						ReadQueryEffectTag | SessionEventBusTag | AccountDirectory
					>();
					const requests: (number | undefined)[] = [];
					const dropped = yield* Deferred.make<void>();
					const reconnect = yield* Deferred.make<void>();
					const output = yield* Queue.unbounded<Envelope<SessionDetailItem>>();
					const client = resumeStream((resumeFromSequence) => {
						requests.push(resumeFromSequence);
						const source = subscribeMessages({
							sessionId: SID,
							...(resumeFromSequence === undefined
								? {}
								: { resumeFromSequence }),
						}).pipe(Stream.provideContext(context), Stream.orDie);
						if (requests.length === 1) {
							// Lose the transport after snapshot, synchronized, and m1.
							return source.pipe(
								Stream.take(3),
								Stream.concat(
									Stream.fail(
										new RpcClientError({
											reason: new SocketCloseError({
												code: 1006,
												closeReason: "socket dropped after m1",
											}),
										}),
									),
								),
							);
						}
						return Stream.unwrap(
							Effect.gen(function* () {
								yield* Deferred.succeed(dropped, undefined);
								yield* Deferred.await(reconnect);
								return source;
							}),
						);
					});
					yield* Stream.runForEach(client, (envelope) =>
						Queue.offer(output, envelope),
					).pipe(Effect.forkScoped);
					const opening = yield* takeN(output, 2);
					expect(opening.map((envelope) => envelope._tag)).toEqual([
						"snapshot",
						"synchronized",
					]);

					if (separateBatches) {
						const store = yield* EventStoreEffectTag;
						const commitAndSignal = yield* makeCommitAndSignal;
						yield* commitAndSignal.write((project) =>
							Effect.gen(function* () {
								// One COMMIT, two row versions: m1@2 and m2@3.
								yield* project(
									yield* store.appendBatch([
										messageCreated(SID, "m1", "assistant"),
									]),
								);
								yield* project(
									yield* store.appendBatch([
										messageCreated(SID, "m2", "assistant"),
									]),
								);
							}),
						);
					} else {
						yield* commit([
							messageCreated(SID, "m1", "assistant"),
							messageCreated(SID, "m2", "assistant"),
						]);
					}
					yield* Deferred.await(dropped);
					yield* commit([sessionCreated("some-other-session")]);
					yield* Deferred.succeed(reconnect, undefined);
					const delivered: { id: string; sequence: number }[] = [];
					while (true) {
						const envelope = yield* Queue.take(output);
						if (envelope._tag === "synchronized") break;
						if (envelope._tag !== "upsert") throw new Error("expected upsert");
						delivered.push({
							id: expectMessage([envelope]).id,
							sequence: envelope.sequence,
						});
					}
					expect(delivered).toEqual([
						{ id: "m1", sequence: 2 },
						{ id: "m2", sequence: separateBatches ? 3 : 2 },
					]);
					expect(requests).toEqual([undefined, 1]);
				}).pipe(
					Effect.provide(
						Layer.mergeAll(
							makePersistenceEffectLayer(
								":memory:",
								"test-project",
								undefined,
								SessionEventBusLive,
							),
							SessionEventBusLive,
							detailAccountsLayer(),
						),
						{ local: true },
					),
				),
		);
	}

	it.effect("never emits a remove envelope across a full turn", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([
				sessionCreated(SID),
				messageCreated(SID, "m1", "assistant"),
			]);
			const { q } = yield* openDetail({ sessionId: SID });
			yield* takeN(q, 2);

			for (const event of [
				textDelta(SID, "m1", "m1-0", "hi"),
				toolStarted(SID, "m1", "tool-1"),
				toolCompleted(SID, "m1", "tool-1"),
				turnCompleted(SID, "m1"),
			]) {
				yield* commit([event]);
				const envelope = yield* Queue.take(q);
				// A remove id is a row id, and an advance speaks in sessions: the
				// session's own disappearance is the shell's to report, not this
				// source's.
				expect(envelope._tag).toBe("upsert");
			}
		}).pipe(Effect.provide(makeDetailTestLayer(), { local: true })),
	);

	it.effect("delivers only the subscribed session's messages", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([
				sessionCreated("session-a"),
				messageCreated("session-a", "a1", "assistant"),
				sessionCreated("session-b"),
				messageCreated("session-b", "b1", "assistant"),
			]);

			const { q } = yield* openDetail({ sessionId: "session-a" });
			yield* takeN(q, 2);

			// Interleave both sessions; only session-a must surface. The advance for
			// session-b does not route here, so it costs not even a query.
			yield* commit([textDelta("session-b", "b1", "b1-0", "other")]);
			yield* commit([textDelta("session-a", "a1", "a1-0", "mine")]);

			const message = expectMessage(yield* takeN(q, 2));
			expect(message.id).toBe("a1");
			expect(textOf(message)).toBe("mine");
			expect(yield* Queue.size(q)).toBe(0);
		}).pipe(Effect.provide(makeDetailTestLayer(), { local: true })),
	);

	it.effect("closing the scope tears down the advance subscription", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([
				sessionCreated(SID),
				messageCreated(SID, "m1", "assistant"),
			]);

			const scope = yield* Scope.make();
			const q = yield* Queue.unbounded<Envelope<SessionDetailItem>>();
			const fiber = yield* Stream.runForEach(
				subscribeMessages({ sessionId: SID }),
				(env) => Queue.offer(q, env),
			).pipe(Effect.forkIn(scope));

			yield* takeN(q, 2); // running & subscribed
			yield* Scope.close(scope, Exit.void);

			expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
		}).pipe(Effect.provide(makeDetailTestLayer(), { local: true })),
	);

	it.effect(
		"producer fix: a persisted user message is delivered live to detail subscribers",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* establishSession(SID);
				const { q } = yield* openDetail({ sessionId: SID });
				const [snapshot] = yield* takeN(q, 2);
				if (snapshot?._tag !== "snapshot") throw new Error("expected snapshot");
				expect(snapshot.rows).toEqual([]);
				expect(snapshot.hasMore).toBe(false);
				expect(snapshot.cursor).toBeUndefined();

				const persist = yield* ClaudeEventPersistEffectTag;
				yield* persist.persistUserMessage(SID, "hello from user");

				const message = expectMessage(yield* takeN(q, 2));
				expect(message.role).toBe("user");
				expect(textOf(message)).toBe("hello from user");

				// Lifecycle establishment owns session.created; user persistence adds
				// only message.created(user) and text.delta.
				const sql = yield* SqlClient.SqlClient;
				const counts = yield* sql<{
					event_count: number;
					creation_count: number;
				}>`
					SELECT
						COUNT(*) AS event_count,
						SUM(CASE WHEN type = 'session.created' THEN 1 ELSE 0 END) AS creation_count
					FROM events WHERE session_id = ${SID}`;
				expect(counts[0]).toEqual({ event_count: 3, creation_count: 1 });
			}).pipe(Effect.provide(makeDetailTestLayer(), { local: true })),
	);

	it.effect(
		"publish:false persists silently, and the next advance heals it",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* establishSession(SID);
				const { q } = yield* openDetail({ sessionId: SID });
				yield* takeN(q, 2);

				const persist = yield* ClaudeEventPersistEffectTag;
				yield* persist.persistUserMessage(SID, "silent", { publish: false });
				// Nothing was announced, so nothing is delivered — and when the next
				// advance does arrive, the re-query picks the silent row up too: the
				// floor is the subscriber's version, not the advance's contents. A
				// dropped signal costs latency, never a lost row.
				yield* commit([
					messageCreated(SID, "m-sentinel", "assistant"),
					textDelta(SID, "m-sentinel", "m-sentinel-0", "SENTINEL"),
				]);

				// Both messages, each with its part, from one query.
				expect(
					messagesOf(yield* takeN(q, 4))
						.map(textOf)
						.sort(),
				).toEqual(["SENTINEL", "silent"]);
				expect(yield* Queue.size(q)).toBe(0);
			}).pipe(Effect.provide(makeDetailTestLayer(), { local: true })),
	);

	it.effect(
		"a projector failure fails the persist and suppresses the bus signal",
		() =>
			// F2: the persist service is all-or-nothing — a projection failure rolls
			// the batch back, the persist FAILS, and no change signal is published
			// ("a bus signal implies committed projection").
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* establishSession(SID);
				const bus = yield* SessionEventBusTag;
				const events = yield* bus.subscribe({ sessionId: SID });
				const persist = yield* ClaudeEventPersistEffectTag;

				const result = yield* Effect.result(
					persist.persistEvent(
						canonicalEvent(
							"session.renamed",
							SID,
							{ sessionId: SID, title: "poisoned" },
							{ provider: "claude", createdAt: at() },
						),
					),
				);
				expect(result._tag).toBe("Failure");

				// Sentinel: the next successful persist must be the FIRST bus signal —
				// proving the failed persist published nothing.
				yield* persist.persistEvent(messageCreated(SID, "m-ok", "user"));
				const first = [
					...(yield* events.pipe(Stream.take(1), Stream.runCollect)),
				];
				expect(first[0]?.type).toBe("message.created");
			}).pipe(
				Effect.provide(
					makeDetailTestLayer({
						projectors: [
							...createAllEffectProjectors(),
							{
								name: "failing-renamed-projector",
								handles: ["session.renamed"],
								project: () =>
									Effect.fail(
										new ProjectionError({
											projector: "failing-renamed-projector",
											operation: "project",
											cause: "boom",
										}),
									),
							},
						],
					}),
					{ local: true },
				),
			),
	);

	it.effect(
		"an interrupt cannot split the projection commit from its bus signal",
		() =>
			// F3: append → project → publish is one uninterruptible region. An
			// interrupt landing while the signal is in flight defers until the
			// signal is delivered — projected always implies published.
			Effect.gen(function* () {
				const publishStarted = yield* Deferred.make<void>();
				const publishGate = yield* Deferred.make<void>();
				const published = yield* Ref.make<readonly StoredEvent[]>([]);
				const probeBus: SessionEventBus = {
					publish: (events) =>
						Effect.gen(function* () {
							yield* Deferred.succeed(publishStarted, undefined);
							yield* Deferred.await(publishGate);
							yield* Ref.update(published, (all) => [...all, ...events]);
						}),
					publishAdvance: () => Effect.void,
					subscribe: () => Effect.die(new Error("unused in this test")),
					subscribeAdvances: () => Effect.die(new Error("unused in this test")),
				};

				yield* Effect.gen(function* () {
					yield* recoverProjections;
					yield* establishSession(SID);
					const persist = yield* ClaudeEventPersistEffectTag;
					const sql = yield* SqlClient.SqlClient;

					const fiber = yield* Effect.forkChild(
						persist.persistUserMessage(SID, "hello"),
					);
					yield* Deferred.await(publishStarted);
					// The projection is already committed when publish begins.
					const rows = yield* sql<{ id: string }>`
						SELECT id FROM messages WHERE session_id = ${SID}`;
					expect(rows).toHaveLength(1);

					// Interrupt while the publish is held open at the gate…
					yield* Effect.sync(() => fiber.interruptUnsafe());
					yield* Deferred.succeed(publishGate, undefined);
					yield* Fiber.await(fiber);

					// …the signal still lands: projected ⇒ published, never one only.
					const delivered = yield* Ref.get(published);
					expect(delivered.map((e) => e.type)).toEqual([
						"message.created",
						"text.delta",
					]);
				}).pipe(
					Effect.provide(
						makeDetailTestLayer({
							busLayer: Layer.succeed(SessionEventBusTag)(probeBus),
						}),
						{ local: true },
					),
				);
			}),
	);
});

// ni8.31-35: transcript states the legacy chat arms used to carry. Each one has
// to reach a browser through the projection alone: projector → detail feed →
// the client's own envelope reducer and converter, no legacy relay message.
describe("transcript states carried by the detail feed alone", () => {
	const ev = <K extends CanonicalEvent["type"]>(
		type: K,
		data: Parameters<typeof canonicalEvent<K>>[2],
		createdAt = at(),
	) => canonicalEvent(type, SID, data, { provider: "claude", createdAt });

	/** What the browser renders from these envelopes and nothing else. */
	const chatOf = (envelopes: readonly Envelope<SessionDetailItem>[]) =>
		deriveTranscriptMessages(
			envelopes.reduce<TranscriptEntry>(applyTranscriptEnvelope, {
				project: "project",
				rows: [],
				hwm: null,
				hasMore: false,
				status: { _tag: "live" },
				pending: [],
				waiting: new Map(),
				partOrder: new Map(),
			}),
			[],
		);

	// Failure modes: a null verdict disappears; a part write never advances the
	// feed; wire/history conversion loses provenance; replay changes the verdict;
	// a late verdict changes activity timing or writes another message's part.
	it.effect.each([
		{ probabilities: { ask: 0.8, routine: 0.2 } },
		{ probabilities: null },
	])(
		"text.surfaced persists and reaches typed live assistant parts: $probabilities",
		({ probabilities }) =>
			Effect.gen(function* () {
				yield* recoverProjections;
				const createdAt = at();
				yield* commit([
					sessionCreated(SID),
					messageCreated(SID, "m1", "assistant"),
					ev(
						"text.delta",
						{ messageId: "m1", partId: "p1", text: "A finding" },
						createdAt,
					),
				]);
				const { q } = yield* openDetail({ sessionId: SID });
				const base = yield* takeN(q, 2);
				const verdict = {
					messageId: "m1",
					partId: "p1",
					ordinal: 7,
					categorySetVersion: 3,
					model: "jev-test",
					probabilities,
				};
				yield* commit([
					canonicalEvent("text.surfaced", SID, verdict, {
						provider: "conduit",
						createdAt: at(),
					}),
				]);
				const updates = yield* takeN(q, 2);
				expect(namesOf(updates)).toEqual(["m1/p1", "m1"]);
				const expected = {
					surfacingOrdinal: 7,
					surfacingSetVersion: 3,
					surfacingModel: "jev-test",
					surfacingProbabilities: probabilities,
					createdAt,
				};
				expect(
					chatOf([...base, ...updates]).find(
						(message) => message.type === "assistant",
					),
				).toMatchObject(expected);
				const sql = yield* SqlClient.SqlClient;
				const before =
					yield* sql`SELECT surfacing_ordinal, surfacing_probabilities,
					surfacing_set_version, surfacing_model, text, created_at, updated_at
					FROM message_parts WHERE id = 'p1'`;
				expect(before).toEqual([
					{
						surfacing_ordinal: 7,
						surfacing_probabilities:
							probabilities === null ? null : JSON.stringify(probabilities),
						surfacing_set_version: 3,
						surfacing_model: "jev-test",
						text: "A finding",
						created_at: createdAt,
						updated_at: createdAt,
					},
				]);
				const store = yield* EventStoreEffectTag;
				const stored = (yield* store.readBySession(SID)).find(
					(event) => event.type === "text.surfaced",
				);
				if (!stored) throw new Error("missing verdict in event log");
				expect(stored.data).toEqual(verdict);
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.projectEvent(stored);
				yield* runner.projectEvent(stored);
				expect(
					yield* sql`SELECT surfacing_ordinal, surfacing_probabilities,
					surfacing_set_version, surfacing_model, text, created_at, updated_at
					FROM message_parts WHERE id = 'p1'`,
				).toEqual(before);
				const { q: reloaded } = yield* openDetail({ sessionId: SID });
				expect(
					chatOf(yield* takeN(reloaded, 2)).find(
						(message) => message.type === "assistant",
					),
				).toMatchObject(expected);
			}).pipe(Effect.provide(makeDetailTestLayer(), { local: true })),
	);

	it.effect("text.surfaced targets only the named session's text part", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([
				sessionCreated(SID),
				messageCreated(SID, "m1", "assistant"),
				textDelta(SID, "m1", "p1", "Keep"),
				toolStarted(SID, "m1", "tool1"),
				sessionCreated("other"),
				messageCreated("other", "m2", "assistant"),
				textDelta("other", "m2", "p2", "Other"),
			]);
			for (const target of [
				{ messageId: "m1", partId: "missing" },
				{ messageId: "m1", partId: "tool1" },
				{ messageId: "m1", partId: "p2" },
				{ messageId: "m2", partId: "p2" },
			])
				yield* commit([
					canonicalEvent("text.surfaced", SID, {
						...target,
						ordinal: 1,
						categorySetVersion: 1,
						model: "jev",
						probabilities: null,
					}),
				]);
			const sql = yield* SqlClient.SqlClient;
			expect(
				yield* sql`SELECT id FROM message_parts WHERE surfacing_ordinal IS NOT NULL`,
			).toEqual([]);
			expect(yield* sql`SELECT id FROM message_parts ORDER BY id`).toEqual([
				{ id: "p1" },
				{ id: "p2" },
				{ id: "tool1" },
			]);
		}).pipe(Effect.provide(makeDetailTestLayer(), { local: true })),
	);

	// Failure modes: modern SSE parts arrive before the message header; thinking
	// and tools reorder adjacent text; a late verdict loses its ordinal on the wire;
	// REST reconciliation erases it, duplicates text, or judges the final reply.
	// Verdicts are supplied explicitly: ahu8.4 deferred the judging service.
	it.effect.each([false, true])(
		"OpenCode adapter delivers supplied verdicts live and after REST reload (part first: %s)",
		(partFirst) =>
			Effect.gen(function* () {
				const log = {
					warn: vi.fn(),
					debug: vi.fn(),
					info: vi.fn(),
					verbose: vi.fn(),
				};
				const ingress = yield* makeEffectOpenCodeRuntimeIngress(log);
				yield* Effect.addFinalizer(() => Effect.sync(() => ingress.shutdown()));
				const header = makeSSEEvent("message.updated", {
					sessionID: SID,
					info: { id: "oc-message", role: "assistant", time: { created: 10 } },
				});
				const parts: NonNullable<Message["parts"]> = [
					{
						id: "oc-ask",
						type: "text",
						text: "Should I widen the change?",
						time: { start: 11, end: 12 },
					},
					{
						id: "oc-thinking",
						type: "reasoning",
						text: "Checking the scope",
						time: { start: 12, end: 13 },
					},
					{
						id: "oc-unjudged",
						type: "text",
						text: "The check needs credentials.",
						time: { start: 13, end: 14 },
					},
					{
						id: "oc-tool",
						type: "tool",
						tool: "Bash",
						callID: "oc-call",
						state: {
							status: "completed",
							input: { command: "pwd" },
							output: "/project",
							time: { start: 14, end: 15 },
						},
					},
					{
						id: "oc-final",
						type: "text",
						text: "Finished the review.",
						time: { start: 15, end: 16 },
					},
				];
				const first = makeSSEEvent("message.part.delta", {
					sessionID: SID,
					messageID: "oc-message",
					partID: "oc-ask",
					field: "text",
					delta: "Should I ",
				});
				for (const event of partFirst ? [first, header] : [header, first])
					expect(
						yield* ingress.onSSEEventEffect(event, SID, "opencode"),
					).toMatchObject({ ok: true });
				for (const part of parts) {
					const event = makeSSEEvent("message.part.updated", {
						sessionID: SID,
						part: { ...part, sessionID: SID, messageID: "oc-message" },
					});
					expect(
						yield* ingress.onSSEEventEffect(event, SID, "opencode"),
					).toMatchObject({ ok: true });
				}
				const { q } = yield* openDetail({ sessionId: SID });
				const base = yield* takeN(q, 2);
				expect(
					chatOf(base)
						.filter((part) => part.type === "assistant")
						.map((part) => part.surfacingOrdinal),
				).toEqual([undefined, undefined, undefined]);
				const verdicts = [
					{
						messageId: "oc-message",
						partId: "oc-ask",
						ordinal: 1,
						categorySetVersion: 1,
						model: "jev-test",
						probabilities: { ask: 0.8, routine: 0.2 },
					},
					{
						messageId: "oc-message",
						partId: "oc-unjudged",
						ordinal: 2,
						categorySetVersion: 1,
						model: "jev-test",
						probabilities: null,
					},
				];
				yield* commit(
					verdicts.map((verdict) =>
						canonicalEvent("text.surfaced", SID, verdict, {
							provider: "conduit",
						}),
					),
				);
				const live = chatOf([...base, ...(yield* takeN(q, 3))]);
				const expected = [
					{
						type: "assistant",
						partId: "oc-ask",
						rawText: "Should I widen the change?",
						surfacingOrdinal: 1,
						surfacingProbabilities: { ask: 0.8, routine: 0.2 },
						surfacingSetVersion: 1,
						surfacingModel: "jev-test",
					},
					{ type: "thinking", text: "Checking the scope" },
					{
						type: "assistant",
						partId: "oc-unjudged",
						rawText: "The check needs credentials.",
						surfacingOrdinal: 2,
						surfacingProbabilities: null,
						surfacingSetVersion: 1,
						surfacingModel: "jev-test",
					},
					{ type: "tool", name: "Bash" },
					{
						type: "assistant",
						partId: "oc-final",
						rawText: "Finished the review.",
					},
				];
				expect(live).toMatchObject(expected);
				expect(live.at(-1)).not.toHaveProperty("surfacingOrdinal");
				expect(live.at(-1)).not.toHaveProperty("surfacingProbabilities");
				const rest: Message[] = [
					{
						id: "oc-message",
						sessionID: SID,
						role: "assistant",
						time: { created: 10, completed: 20 },
						parts,
					},
				];
				const fetchMessages = vi.fn(() => Effect.succeed(rest));
				const reconnected = yield* makeEffectOpenCodeRuntimeIngress(
					log,
					fetchMessages,
				);
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => reconnected.shutdown()),
				);
				yield* reconnected.reconcileSession(SID);
				// Wait on the observable completed-message update, not a timer or
				// the reconciler's private background fiber.
				yield* Stream.fromQueue(q).pipe(
					Stream.takeUntil(
						(envelope) =>
							envelope._tag === "upsert" &&
							envelope.item._tag === "message" &&
							envelope.item.message.time?.completed === 20,
					),
					Stream.runDrain,
				);
				expect(fetchMessages).toHaveBeenCalledOnce();
				const { q: reloaded } = yield* openDetail({ sessionId: SID });
				const reload = chatOf(yield* takeN(reloaded, 2));
				// Completion can add a result row, but the same text parts retain the
				// same identities, order, numbers and verdicts after reconciliation.
				const reloadedParts = reload.filter((part) => part.type !== "result");
				expect(reloadedParts).toMatchObject(expected);
				expect(reloadedParts.map((part) => part.uuid)).toEqual(
					live.map((part) => part.uuid),
				);
				expect(reloadedParts.at(-1)).not.toHaveProperty("surfacingOrdinal");
				expect(reloadedParts.at(-1)).not.toHaveProperty(
					"surfacingProbabilities",
				);
				const query = yield* ReadQueryEffectTag;
				const history = messageRowsToHistory(
					yield* query.getSessionMessagesWithParts(SID),
					{ pageSize: 50 },
				);
				expect(
					history.messages[0]?.parts?.filter((part) => part.type === "text"),
				).toMatchObject([
					{
						id: "oc-ask",
						surfacingOrdinal: 1,
						surfacingProbabilities: { ask: 0.8, routine: 0.2 },
					},
					{
						id: "oc-unjudged",
						surfacingOrdinal: 2,
						surfacingProbabilities: null,
					},
					{ id: "oc-final" },
				]);
				expect(log.warn).not.toHaveBeenCalled();
				yield* Effect.sync(() => {
					mkdirSync("test-results", { recursive: true });
					writeFileSync(
						`test-results/ahu8-7-opencode-surfacing-${partFirst ? "part-first" : "header-first"}.json`,
						JSON.stringify(
							{
								verdicts,
								live,
								reload,
								history,
								requests: fetchMessages.mock.calls,
							},
							null,
							2,
						),
					);
				});
			}).pipe(Effect.provide(makeDetailIngestionTestLayer(), { local: true })),
	);

	it.effect(
		"OpenCode snapshots retain text.surfaced facts across reconciliation and history reads",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				const snapshot = (digest: string) =>
					canonicalEvent(
						"message.snapshot",
						SID,
						{
							messageId: "m1",
							digest,
							message: {
								id: "m1",
								sessionID: SID,
								role: "assistant",
								time: { created: 10, completed: 30 },
								parts: [
									{
										id: "p1",
										type: "text",
										text: "Snapshot",
										time: { start: 20, end: 25 },
									},
								],
							},
						},
						{ provider: "opencode", metadata: { rawSource: "opencode.rest" } },
					);
				yield* commit([sessionCreated(SID), snapshot("first")]);
				const { q } = yield* openDetail({ sessionId: SID });
				const base = yield* takeN(q, 2);
				yield* commit([
					canonicalEvent(
						"text.surfaced",
						SID,
						{
							messageId: "m1",
							partId: "p1",
							ordinal: 2,
							categorySetVersion: 4,
							model: "jev",
							probabilities: null,
						},
						{ provider: "conduit" },
					),
				]);
				const expected = {
					surfacingOrdinal: 2,
					surfacingSetVersion: 4,
					surfacingModel: "jev",
					surfacingProbabilities: null,
					createdAt: 20,
				};
				expect(
					chatOf([...base, ...(yield* takeN(q, 2))]).find(
						(message) => message.type === "assistant",
					),
				).toMatchObject(expected);
				yield* commit([snapshot("second")]);
				const sql = yield* SqlClient.SqlClient;
				expect(
					yield* sql`SELECT rest_digest FROM messages WHERE id = 'm1'`,
				).toEqual([{ rest_digest: "second" }]);
				const { q: reloaded } = yield* openDetail({ sessionId: SID });
				expect(
					chatOf(yield* takeN(reloaded, 2)).find(
						(message) => message.type === "assistant",
					),
				).toMatchObject(expected);
				const query = yield* ReadQueryEffectTag;
				const history = messageRowsToHistory(
					yield* query.getSessionMessagesWithParts(SID),
					{ pageSize: 50 },
				);
				const { createdAt: _createdAt, ...surfacing } = expected;
				expect(history.messages[0]?.parts?.[0]).toMatchObject({
					...surfacing,
					time: { start: 20 },
				});
			}).pipe(Effect.provide(makeDetailTestLayer(), { local: true })),
	);

	it.effect(
		"thinking is in progress until thinking.end, which stamps its end",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				const startedAt = at();
				yield* commit([
					sessionCreated(SID),
					messageCreated(SID, "m1", "assistant"),
					ev("thinking.start", { messageId: "m1", partId: "t1" }, startedAt),
					ev("thinking.delta", { messageId: "m1", partId: "t1", text: "hm" }),
				]);
				const { q } = yield* openDetail({ sessionId: SID });
				const opening = yield* takeN(q, 2);
				expect(chatOf(opening)).toMatchObject([
					{ type: "thinking", text: "hm", done: false },
				]);

				const endedAt = at() + 100;
				yield* commit([
					ev("thinking.end", { messageId: "m1", partId: "t1" }, endedAt),
				]);
				// The message and the thinking part it moved.
				const ended = yield* takeN(q, 2);
				expect(chatOf([...opening, ...ended])).toMatchObject([
					{ type: "thinking", done: true, duration: endedAt - startedAt },
				]);
			}).pipe(Effect.provide(makeDetailTestLayer(), { local: true })),
	);

	it.effect("an interrupted turn closes thinking that never ended", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([
				sessionCreated(SID),
				messageCreated(SID, "m1", "assistant"),
				ev("thinking.start", { messageId: "m1", partId: "t1" }),
				ev("turn.interrupted", { messageId: "m1" }),
			]);
			const { q } = yield* openDetail({ sessionId: SID });
			expect(chatOf(yield* takeN(q, 2))).toMatchObject([
				{ type: "thinking", done: true },
			]);
		}).pipe(Effect.provide(makeDetailTestLayer(), { local: true })),
	);

	it.effect("a tool's input refreshed after tool.started reaches the row", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([
				sessionCreated(SID),
				messageCreated(SID, "m1", "assistant"),
				toolStarted(SID, "m1", "p1"),
			]);
			const { q } = yield* openDetail({ sessionId: SID });
			const opening = yield* takeN(q, 2);

			yield* commit([
				ev("tool.running", {
					messageId: "m1",
					partId: "p1",
					callId: "p1",
					toolName: "Bash",
					input: { tool: "Bash", command: "ls" },
				}),
			]);
			const running = yield* takeN(q, 2);
			expect(chatOf([...opening, ...running])).toMatchObject([
				{ type: "tool", input: { command: "ls" } },
			]);

			yield* commit([
				ev("tool.completed", {
					messageId: "m1",
					partId: "p1",
					result: "ok",
					duration: 1,
					input: { tool: "Bash", command: "ls -la" },
				}),
			]);
			const completed = yield* takeN(q, 2);
			expect(chatOf([...opening, ...running, ...completed])).toMatchObject([
				{ type: "tool", input: { command: "ls -la" } },
			]);
		}).pipe(Effect.provide(makeDetailTestLayer(), { local: true })),
	);

	it.effect("a turn error is transcript content and survives a reload", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([
				sessionCreated(SID),
				messageCreated(SID, "m1", "assistant"),
				toolStarted(SID, "m1", "p1"),
			]);
			const { q } = yield* openDetail({ sessionId: SID });
			const opening = yield* takeN(q, 2);

			yield* commit([
				ev("turn.error", {
					messageId: "m1",
					error: "Rate limited",
					code: "provider_error",
				}),
			]);
			// The turn's message moved, and the error is a message with its part.
			const errored = yield* takeN(q, 3);
			expect(namesOf(errored)).toEqual([
				"m1",
				"turn-error-4/turn-error-part-4",
				"turn-error-4",
			]);
			const live = [...opening, ...errored];
			const expected = [
				{ type: "tool", name: "Bash" },
				{
					type: "system",
					variant: "error",
					text: "Rate limited",
					errorCode: "provider_error",
				},
			];
			expect(chatOf(live)).toMatchObject(expected);

			// A fresh subscriber (a reload) sees the same thing from the store.
			const reload = yield* openDetail({ sessionId: SID });
			expect(chatOf(yield* takeN(reload.q, 2))).toMatchObject(expected);
		}).pipe(Effect.provide(makeDetailTestLayer(), { local: true })),
	);

	it.effect(
		"ingestion keeps a compaction's outcome and drops its transient start",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const compaction = (state: "started" | "failed", detail: string) =>
					runtimeEvent({
						eventId: `rt-compaction-${state}`,
						type: "session.compaction",
						data: { sessionId: SID, state, detail },
					});
				yield* ingestion.ingestBatch([
					runtimeEvent({
						eventId: "rt-session-created",
						type: "session.created",
						data: { sessionId: SID, title: "Detail", provider: "claude" },
					}),
					compaction("started", "Compacting conversation…"),
					compaction("failed", "Compaction failed: too large"),
				]);
				const { q } = yield* openDetail({ sessionId: SID });
				expect(chatOf(yield* takeN(q, 2))).toEqual([
					expect.objectContaining({
						compaction: "failed",
						text: "Compaction failed: too large",
					}),
				]);
			}).pipe(Effect.provide(makeDetailIngestionTestLayer(), { local: true })),
	);

	it.effect("a failed compaction is an error notice, not a boundary", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([
				sessionCreated(SID),
				ev("session.compaction", {
					sessionId: SID,
					state: "failed",
					detail: "Compaction failed",
				}),
			]);
			const { q } = yield* openDetail({ sessionId: SID });
			expect(chatOf(yield* takeN(q, 2))).toMatchObject([
				{
					type: "system",
					variant: "error",
					compaction: "failed",
					text: "Compaction failed",
				},
			]);
		}).pipe(Effect.provide(makeDetailTestLayer(), { local: true })),
	);
});
