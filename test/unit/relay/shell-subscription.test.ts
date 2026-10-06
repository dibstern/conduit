import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import {
	Effect,
	Exit,
	Fiber,
	Layer,
	Queue,
	Ref,
	Schema,
	Scope,
	Stream,
} from "effect";
import { expect, vi } from "vitest";
import { decodeProviderRuntimeEvent } from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { PendingSendOwnershipLive } from "../../../src/lib/domain/relay/Services/pending-send-ownership.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import type { Envelope } from "../../../src/lib/domain/relay/Services/read-model-subscription.js";
import { RelayStatusSnapshotLive } from "../../../src/lib/domain/relay/Services/relay-status-snapshot.js";
import {
	BackgroundLivenessTag,
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	announceBackgroundWork,
	markSeen,
} from "../../../src/lib/domain/relay/Services/session-attention.js";
import {
	forkOpenCodeSession,
	forkSession,
} from "../../../src/lib/domain/relay/Services/session-command.js";
import {
	SessionEventBusLive,
	type SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { persistSessionPermissionMode } from "../../../src/lib/domain/relay/Services/session-manager-permission-mode.js";
import { deleteSession } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { makeSessionManagerStateLive } from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import { setForkEntry } from "../../../src/lib/domain/relay/Services/session-manager-state-operations.js";
import { subscribeShell } from "../../../src/lib/domain/relay/Services/shell-subscription.js";
import { forkSessionForClient } from "../../../src/lib/handlers/session.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ProviderStateEffectTag } from "../../../src/lib/persistence/effect/provider-state-effect.js";
import {
	type ReadQueryEffect,
	ReadQueryEffectTag,
} from "../../../src/lib/persistence/effect/read-query-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../src/lib/persistence/events.js";
import { defaultClaudeSessionForkSdk } from "../../../src/lib/provider/claude/claude-session-fork.js";
import { makeSessionBackgroundLiveness } from "../../../src/lib/session/background-liveness.js";
import {
	type SessionInfo,
	SessionInfoSchema,
} from "../../../src/lib/shared-types.js";
import {
	MOCK_PROJECT_DIR,
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

const getSessionMessages = vi.spyOn(
	defaultClaudeSessionForkSdk,
	"readTranscript",
);
const sdkForkSession = vi.spyOn(defaultClaudeSessionForkSdk, "forkSession");
// A fresh temp-file persistence stack + the real SessionEventBus per test. The
// shell source reads the sessions projection and nothing else, so what is under
// test is a contract WITH the store: the version column the projectors stamp,
// the advance the commit seam publishes post-COMMIT, and the query that turns
// one into the other. Writes go through `commit` — the real seam — because an
// advance that the seam did not publish is a signal the production path would
// never produce.
//
// The same module-singleton bus layer reference is passed to the persistence
// layer AND merged at the top level, so Effect memoization unifies the persist
// path's publisher, the test driver's publisher and the subscription's listener
// onto one PubSub. No clock anywhere: the version column removed the window.

const makeShellTestLayer = (
	handlerApi?: ReturnType<typeof makeMockOpenCodeAPI>,
) => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-shell-sub-"));
	const filename = join(dir, "events.db");
	const persistenceLayer = makePersistenceEffectLayer(
		filename,
		undefined,
		SessionEventBusLive,
	);
	const cleanup = Layer.scopedDiscard(
		Effect.addFinalizer(() =>
			Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
		),
	);
	return Layer.mergeAll(
		PendingSendOwnershipLive,
		RelayStatusSnapshotLive,
		Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
		persistenceLayer,
		...(handlerApi === undefined
			? []
			: [makeTestHandlerLayer({ api: handlerApi, persistenceLayer })]),
		SessionEventBusLive,
		Layer.succeed(
			OrchestrationEngineTag,
			withDispatchEffect({ dispatch: async () => undefined }),
		),
		Layer.succeed(BackgroundLivenessTag, () => undefined),
		Layer.succeed(
			ConfigTag,
			makeMockConfig({
				configDir: dir,
				claudeSdk: {
					query: () => {
						throw new Error("Unexpected Claude query");
					},
					titleQuery: async function* () {},
					fork: defaultClaudeSessionForkSdk,
				},
			}),
		),
		Layer.succeed(LoggerTag, makeMockLogger()),
		cleanup,
	);
};

// Monotonic clock → deterministic recency ordering across the suite.
let clock = 0;
const at = () => ++clock;

const sessionCreated = (
	sessionId: string,
	title = "Shell",
	parentId?: string,
): CanonicalEvent =>
	canonicalEvent(
		"session.created",
		sessionId,
		{
			sessionId,
			title,
			provider: "claude",
			...(parentId === undefined ? {} : { parentId }),
		},
		{ provider: "claude", createdAt: at() },
	);
const sessionRenamed = (sessionId: string, title: string): CanonicalEvent =>
	canonicalEvent(
		"session.renamed",
		sessionId,
		{ sessionId, title },
		{ provider: "claude", createdAt: at() },
	);
const sessionStatus = (
	sessionId: string,
	status: "idle" | "busy",
): CanonicalEvent =>
	canonicalEvent(
		"session.status",
		sessionId,
		{ sessionId, status },
		{ provider: "claude", createdAt: at() },
	);
const messageCreated = (
	sessionId: string,
	messageId: string,
	createdAt = at(),
): CanonicalEvent =>
	canonicalEvent(
		"message.created",
		sessionId,
		{ messageId, role: "user", sessionId },
		{ provider: "claude", createdAt },
	);
const textDelta = (
	sessionId: string,
	messageId: string,
	text: string,
): CanonicalEvent =>
	canonicalEvent(
		"text.delta",
		sessionId,
		{ messageId, partId: `${messageId}-0`, text },
		{ provider: "claude", createdAt: at() },
	);
const sessionDeleted = (sessionId: string): CanonicalEvent =>
	canonicalEvent(
		"session.deleted",
		sessionId,
		{ sessionId },
		{ provider: "claude", createdAt: at() },
	);

// Recover projections once so projectBatch is permitted.
const recoverProjections = Effect.gen(function* () {
	const runner = yield* ProjectionRunnerEffectTag;
	yield* runner.recover();
});

/** The ingestion choke point: append → project → COMMIT → publish the advance. */
const commit = (events: readonly CanonicalEvent[]) =>
	Effect.flatMap(makeCommitAndSignal, (commitAndSignal) =>
		commitAndSignal(events),
	);

// The production choke point, for the tests that need the seam's own publish
// rather than the hand-rolled one above: `commitAndSignal` appends, projects and
// announces the read-model advance in one uninterruptible step.
const commitThroughSeam = (events: readonly CanonicalEvent[]) =>
	Effect.flatMap(makeCommitAndSignal, (commitAndSignal) =>
		commitAndSignal.write((project) =>
			Effect.gen(function* () {
				const eventStore = yield* EventStoreEffectTag;
				const stored = yield* eventStore.appendBatch(events);
				yield* project(stored);
				return stored;
			}),
		),
	);

/** The number the envelopes speak in. */
const readModelVersion = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const rows = yield* sql<{ value: number }>`
		SELECT value FROM read_model_counter WHERE id = 1`;
	return rows[0]?.value ?? 0;
});

/** Wrap the real read side, counting session re-queries. */
const countingReadQuery = (
	real: ReadQueryEffect,
	requeries: Ref.Ref<number>,
): ReadQueryEffect => ({
	...real,
	readSessionList: (afterVersion) =>
		Ref.update(requeries, (n) => n + 1).pipe(
			Effect.zipRight(real.readSessionList(afterVersion)),
		),
});

// Drain the subscription into a queue so the test pulls envelopes one at a
// time. `readQuery` lets a test substitute a wrapped read side (re-query
// counting, mid-read commits) while everything else stays real.
const openShell = (options?: {
	readonly resumeFromSequence?: number;
	readonly readQuery?: ReadQueryEffect;
}) =>
	Effect.gen(function* () {
		const q = yield* Queue.unbounded<Envelope<SessionInfo>>();
		const run = Stream.runForEach(
			subscribeShell(
				options?.resumeFromSequence === undefined
					? {}
					: { resumeFromSequence: options.resumeFromSequence },
			),
			(env) => Queue.offer(q, env),
		);
		const fiber = yield* (
			options?.readQuery === undefined
				? run
				: run.pipe(Effect.provideService(ReadQueryEffectTag, options.readQuery))
		).pipe(Effect.forkScoped);
		return { q, fiber };
	});

const takeN = <A>(q: Queue.Queue<A>, n: number): Effect.Effect<A[]> =>
	Effect.forEach(Array.from({ length: n }), () => Queue.take(q));

const SID = "session-shell";

describe("subscribeShell", () => {
	for (const provider of ["opencode", "claude"] as const) {
		it.scoped(
			`${provider} fork commands update an open subscription from the event store`,
			() =>
				Effect.gen(function* () {
					yield* recoverProjections;
					yield* commit([
						sessionCreated("parent"),
						canonicalEvent(
							"session.created",
							"child",
							{ sessionId: "child", title: "Child", provider },
							{ provider },
						),
					]);
					const { q } = yield* openShell();
					yield* takeN(q, 2);
					yield* setForkEntry("child", {
						parentID: "parent",
						forkMessageId: "fork-point",
					});
					expect(yield* Queue.take(q)).toMatchObject({
						_tag: "upsert",
						item: { id: "parent" },
					});
				}).pipe(
					Effect.provide(
						Layer.merge(makeShellTestLayer(), makeSessionManagerStateLive()),
					),
				),
		);
	}
	for (const entry of ["command", "handler"] as const) {
		it.scoped(
			`a new Claude fork through the ${entry} publishes both lineage fields and resumes the SDK child`,
			() => {
				const api = makeMockOpenCodeAPI();
				return Effect.gen(function* () {
					yield* recoverProjections;
					yield* commit([
						sessionCreated("claude-parent"),
						messageCreated("claude-parent", "ui-boundary", 1000),
					]);
					const state = yield* ProviderStateEffectTag;
					yield* state.saveUpdates("claude-parent", [
						{ key: "resumeSessionId", value: "sdk-parent" },
					]);
					vi.mocked(getSessionMessages).mockResolvedValue([
						{
							type: "assistant",
							uuid: "transcript-boundary",
							session_id: "sdk-parent",
							message: { id: "ui-boundary", role: "assistant", content: [] },
							parent_tool_use_id: null,
							parent_agent_id: null,
						},
					]);
					vi.mocked(sdkForkSession).mockResolvedValue({
						sessionId: "sdk-child",
					});
					const { q } = yield* openShell();
					yield* takeN(q, 2);
					const child =
						entry === "command"
							? yield* forkSession("claude-parent", {
									messageId: "ui-boundary",
								})
							: yield* forkSessionForClient({
									clientId: "client",
									sessionId: "claude-parent",
									messageId: "ui-boundary",
								});
					if (!child) throw new Error("Expected a fork");
					const read = yield* ReadQueryEffectTag;
					expect(yield* read.getSession(child.id)).toMatchObject({
						provider: "claude",
						parent_id: "claude-parent",
						fork_point_event: "ui-boundary",
					});
					expect(yield* Queue.take(q)).toMatchObject({
						_tag: "upsert",
						item: { id: "claude-parent" },
					});
					expect(sdkForkSession).toHaveBeenCalledWith(
						"sdk-parent",
						expect.objectContaining({ upToMessageId: "transcript-boundary" }),
					);
					expect(yield* state.getState(child.id)).toMatchObject({
						resumeSessionId: "sdk-child",
					});
					expect(api.session.fork).not.toHaveBeenCalled();
					expect(api.session.message).not.toHaveBeenCalled();
					expect(api.session.messagesPage).not.toHaveBeenCalled();
				}).pipe(
					Effect.provide(
						makeShellTestLayer(entry === "handler" ? api : undefined),
					),
				);
			},
		);
	}
	it.scoped(
		"does not create a new Claude fork without a durable boundary key",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([sessionCreated("claude-parent")]);
				const state = yield* ProviderStateEffectTag;
				yield* state.saveUpdates("claude-parent", [
					{ key: "resumeSessionId", value: "sdk-parent" },
				]);
				vi.mocked(getSessionMessages).mockResolvedValue([
					{
						type: "assistant",
						uuid: "missing",
						session_id: "sdk-parent",
						message: { id: "missing" },
						parent_tool_use_id: null,
						parent_agent_id: null,
					},
				]);
				vi.mocked(sdkForkSession).mockResolvedValue({
					sessionId: "unclassified-child",
				});
				vi.mocked(sdkForkSession).mockClear();
				const result = yield* Effect.either(
					forkSession("claude-parent", { messageId: "missing" }),
				);
				expect(result._tag).toBe("Left");
				expect(sdkForkSession).not.toHaveBeenCalled();
			}).pipe(Effect.provide(makeShellTestLayer())),
	);
	it.scoped(
		"a Claude tip fork records the actual parent transcript boundary",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([
					sessionCreated("claude-parent"),
					messageCreated("claude-parent", "ui-tip", 1000),
				]);
				const state = yield* ProviderStateEffectTag;
				yield* state.saveUpdates("claude-parent", [
					{ key: "resumeSessionId", value: "sdk-parent" },
				]);
				vi.mocked(getSessionMessages).mockResolvedValue([
					{
						type: "assistant",
						uuid: "transcript-tip",
						session_id: "sdk-parent",
						message: { id: "api-final-round", role: "assistant", content: [] },
						parent_tool_use_id: null,
						parent_agent_id: null,
					},
				]);
				vi.mocked(sdkForkSession).mockResolvedValue({
					sessionId: "sdk-tip-child",
				});
				const child = yield* forkSession("claude-parent");
				const read = yield* ReadQueryEffectTag;
				expect(yield* read.getSession(child.id)).toMatchObject({
					parent_id: "claude-parent",
					fork_point_event: "ui-tip",
					fork_point_timestamp: 1000,
					fork_point_message_id: "ui-tip",
				});
				expect(sdkForkSession).toHaveBeenCalledWith(
					"sdk-parent",
					expect.objectContaining({ dir: MOCK_PROJECT_DIR }),
				);
			}).pipe(Effect.provide(makeShellTestLayer())),
	);
	// hk9m.7: the imported turns were the parent's to read, so the fork has no dot.
	it.scoped("a Claude fork starts seen up to its last imported turn end", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([
				sessionCreated("claude-parent"),
				messageCreated("claude-parent", "ui-tip", 1000),
				canonicalEvent(
					"turn.completed",
					"claude-parent",
					{ messageId: "ui-tip" },
					{ provider: "claude", createdAt: at() },
				),
			]);
			const state = yield* ProviderStateEffectTag;
			yield* state.saveUpdates("claude-parent", [
				{ key: "resumeSessionId", value: "sdk-parent" },
			]);
			vi.mocked(getSessionMessages).mockResolvedValue([
				{
					type: "assistant",
					uuid: "transcript-tip",
					session_id: "sdk-parent",
					message: { id: "api-final-round", role: "assistant", content: [] },
					parent_tool_use_id: null,
					parent_agent_id: null,
				},
			]);
			vi.mocked(sdkForkSession).mockResolvedValue({
				sessionId: "sdk-seen-child",
			});
			const child = yield* forkSession("claude-parent");
			const read = yield* ReadQueryEffectTag;
			const row = yield* read.getSession(child.id);
			expect(row?.last_turn_end_version).not.toBeNull();
			expect(row).toMatchObject({
				seen_version: row?.last_turn_end_version,
				unread: 0,
			});
		}).pipe(Effect.provide(makeShellTestLayer())),
	);
	it.scoped(
		"rejects a Claude UI boundary that continues through tool rounds",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([sessionCreated("claude-parent")]);
				const state = yield* ProviderStateEffectTag;
				yield* state.saveUpdates("claude-parent", [
					{ key: "resumeSessionId", value: "sdk-parent" },
				]);
				vi.mocked(getSessionMessages).mockResolvedValue([
					{
						type: "assistant",
						uuid: "round-one",
						session_id: "sdk-parent",
						message: { id: "ui-boundary", content: [] },
						parent_tool_use_id: null,
						parent_agent_id: null,
					},
					{
						type: "user",
						uuid: "tool-result",
						session_id: "sdk-parent",
						message: {
							content: [{ type: "tool_result", tool_use_id: "call" }],
						},
						parent_tool_use_id: null,
						parent_agent_id: null,
					},
					{
						type: "assistant",
						uuid: "round-two",
						session_id: "sdk-parent",
						message: { id: "api-second-round", content: [] },
						parent_tool_use_id: null,
						parent_agent_id: null,
					},
				]);
				vi.mocked(sdkForkSession).mockClear();
				vi.mocked(sdkForkSession).mockResolvedValue({
					sessionId: "incorrect-child",
				});
				const result = yield* Effect.either(
					forkSession("claude-parent", { messageId: "ui-boundary" }),
				);
				expect(result._tag).toBe("Left");
				expect(sdkForkSession).not.toHaveBeenCalled();
			}).pipe(Effect.provide(makeShellTestLayer())),
	);
	it.scoped(
		"a Claude fork is not published if its resume state cannot be saved",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([sessionCreated("claude-parent")]);
				const state = yield* ProviderStateEffectTag;
				yield* state.saveUpdates("claude-parent", [
					{ key: "resumeSessionId", value: "sdk-parent" },
				]);
				vi.mocked(getSessionMessages).mockResolvedValue([
					{
						type: "assistant",
						uuid: "transcript-tip",
						session_id: "sdk-parent",
						message: { id: "api-tip", content: [] },
						parent_tool_use_id: null,
						parent_agent_id: null,
					},
				]);
				vi.mocked(sdkForkSession).mockResolvedValue({
					sessionId: "unresumable-child",
				});
				const sql = yield* SqlClient.SqlClient;
				yield* sql`CREATE TRIGGER reject_child_state BEFORE INSERT ON provider_state WHEN NEW.session_id = 'unresumable-child' BEGIN SELECT RAISE(ABORT, 'resume state unavailable'); END`;
				yield* commit([messageCreated("claude-parent", "api-tip", 1000)]);
				const result = yield* Effect.either(forkSession("claude-parent"));
				expect(result._tag).toBe("Left");
				const read = yield* ReadQueryEffectTag;
				expect(yield* read.getSession("unresumable-child")).toBeUndefined();
			}).pipe(Effect.provide(makeShellTestLayer())),
	);
	it.scoped(
		"rejects a Claude fork whose transcript store differs from the SDK process",
		() =>
			Effect.gen(function* () {
				const configDir = mkdtempSync(join(tmpdir(), "claude-fork-config-"));
				yield* Effect.addFinalizer(() =>
					Effect.sync(() =>
						rmSync(configDir, { recursive: true, force: true }),
					),
				);
				writeFileSync(
					join(configDir, "daemon.json"),
					JSON.stringify({
						claudeConfigDir: "/isolated-claude-fork-store",
						projects: [],
					}),
				);
				yield* recoverProjections;
				yield* commit([
					sessionCreated("claude-parent"),
					messageCreated("claude-parent", "api-tip", 1000),
				]);
				const state = yield* ProviderStateEffectTag;
				yield* state.saveUpdates("claude-parent", [
					{ key: "resumeSessionId", value: "sdk-parent" },
				]);
				vi.mocked(getSessionMessages).mockClear();
				vi.mocked(getSessionMessages).mockResolvedValue([]);
				const config = yield* ConfigTag;
				const result = yield* Effect.either(
					forkSession("claude-parent", { messageId: "api-tip" }).pipe(
						Effect.provideService(ConfigTag, { ...config, configDir }),
					),
				);
				expect(result).toMatchObject({
					_tag: "Left",
					left: { message: expect.stringContaining("Claude transcript") },
				});
				expect(getSessionMessages).toHaveBeenCalledWith("sdk-parent", {
					dir: MOCK_PROJECT_DIR,
				});
			}).pipe(Effect.provide(makeShellTestLayer())),
	);
	for (const messageId of ["fork-message", undefined]) {
		// OpenCode keeps message identity across a fork.
		it.scoped(
			`a new OpenCode fork exposes its parent and fork point ${messageId ?? "at tip"} without a metadata cache`,
			() => {
				const api = makeMockOpenCodeAPI();
				vi.mocked(api.session.messagesPage).mockResolvedValue([
					{ id: "fork-message", role: "user", sessionID: "new-fork" },
				]);
				vi.mocked(api.session.fork).mockResolvedValue({
					id: "new-fork",
					title: "Fork",
					projectID: "project",
					directory: "/project",
					version: "1",
					time: { created: 1, updated: 1 },
				});
				return Effect.gen(function* () {
					yield* recoverProjections;
					yield* commit([sessionCreated("parent")]);
					const { q } = yield* openShell();
					yield* takeN(q, 2);
					yield* forkOpenCodeSession("parent", messageId);
					const envelope = yield* Queue.take(q);
					expect(envelope).toMatchObject({
						_tag: "upsert",
						item: { id: "parent" },
					});
				}).pipe(
					Effect.provide(
						Layer.merge(
							makeShellTestLayer(),
							Layer.succeed(OpenCodeAPITag, api),
						),
					),
				);
			},
		);
	}
	it.scoped("successive committed bursts deliver successive current rows", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([sessionCreated(SID)]);
			const { q } = yield* openShell();
			yield* takeN(q, 2);
			yield* commit([sessionRenamed(SID, "First")]);
			const first = yield* Queue.take(q);
			yield* commit([sessionRenamed(SID, "Second")]);
			const second = yield* Queue.take(q);
			if (first._tag !== "upsert" || second._tag !== "upsert")
				throw new Error("expected upserts");
			expect(first.item.title).toBe("First");
			expect(second.item.title).toBe("Second");
			expect(second.sequence).toBeGreaterThan(first.sequence);
			expect(yield* Queue.size(q)).toBe(0);
		}).pipe(Effect.provide(makeShellTestLayer())),
	);

	it.scoped(
		"snapshot orders rows by recency and excludes unprojected history from its version",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				const readQuery = yield* ReadQueryEffectTag;
				expect(yield* readQuery.readSessionList()).toEqual({
					rows: [],
					version: yield* readModelVersion,
				});
				yield* commit([
					sessionCreated("shell-old"),
					sessionCreated("shell-new"),
				]);
				const projected = yield* readQuery.readSessionList();
				expect(projected.rows.map(({ item }) => item.id)).toEqual([
					"shell-new",
					"shell-old",
				]);
				expect(projected.version).toBe(yield* readModelVersion);
				const eventStore = yield* EventStoreEffectTag;
				yield* eventStore.appendBatch([
					sessionRenamed("shell-old", "unprojected"),
				]);
				expect(yield* readQuery.readSessionList()).toEqual(projected);
			}).pipe(Effect.provide(makeShellTestLayer())),
	);

	it.scoped(
		"resume after a parent deletion rebases away both parent and child",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([
					sessionCreated("shell-parent"),
					sessionCreated("shell-child", "Child", "shell-parent"),
				]);
				const cursor = yield* readModelVersion;
				yield* deleteSession("shell-parent");
				const { q } = yield* openShell({ resumeFromSequence: cursor });
				expect(yield* takeN(q, 2)).toEqual([
					{ _tag: "snapshot", rows: [], sequence: yield* readModelVersion },
					{ _tag: "synchronized" },
				]);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						makeShellTestLayer(),
						Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
						makeSessionManagerStateLive(),
					),
				),
			),
	);

	it.scoped(
		"resume covers more than a log page and excludes deleted sessions",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([sessionCreated("shell-a")]);
				yield* commit(
					Array.from({ length: 1000 }, (_, i) =>
						messageCreated("shell-a", `m${i}`),
					),
				);
				yield* commit([sessionCreated("shell-b"), sessionCreated("shell-c")]);
				const persist = yield* ClaudeEventPersistEffectTag;
				yield* persist.persistEvent(sessionDeleted("shell-c"));
				const { q } = yield* openShell({ resumeFromSequence: 0 });
				const [snapshot, synchronized] = yield* takeN(q, 2);
				if (snapshot?._tag !== "snapshot") throw new Error("expected snapshot");
				expect(snapshot.rows.map((row) => row.id).sort()).toEqual([
					"shell-a",
					"shell-b",
				]);
				expect(snapshot.sequence).toBe(yield* readModelVersion);
				expect(synchronized).toEqual({ _tag: "synchronized" });
			}).pipe(Effect.provide(makeShellTestLayer())),
	);

	it.scoped(
		"cold start snapshots the list, then upserts the whole current row per advance",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([sessionCreated(SID)]);

				const { q } = yield* openShell();
				const [snapshot, synchronized] = yield* takeN(q, 2);
				if (snapshot?._tag !== "snapshot") throw new Error("expected snapshot");
				expect(synchronized).toEqual({ _tag: "synchronized" });
				expect(snapshot.rows.map((row) => row.id)).toEqual([SID]);
				expect(snapshot.sequence).toBe(yield* readModelVersion);

				yield* commit([
					sessionRenamed(SID, "Renamed"),
					sessionStatus(SID, "busy"),
				]);

				const delta = yield* Queue.take(q);
				if (delta._tag !== "upsert") throw new Error("expected upsert");
				// The re-query returns the CURRENT whole row, so one envelope carries
				// every change the commit made to it.
				expect(delta.item.id).toBe(SID);
				expect(delta.item.title).toBe("Renamed");
				expect(delta.item.status).toBe("busy");
				// The stream carries the single session type (ni8.5 T-1), not the
				// projection row: everything on the item is in the contract and
				// nothing outside it rides along.
				expect(Schema.decodeUnknownSync(SessionInfoSchema)(delta.item)).toEqual(
					delta.item,
				);
				// The sequence is the read-model version, not an event sequence.
				expect(delta.sequence).toBe(yield* readModelVersion);
				expect(yield* Queue.size(q)).toBe(0);
			}).pipe(Effect.provide(makeShellTestLayer())),
	);

	it.scoped("two sessions moved by one commit arrive as one upsert each", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([sessionCreated("shell-a"), sessionCreated("shell-b")]);

			const { q } = yield* openShell();
			yield* takeN(q, 2);

			yield* commit([
				sessionRenamed("shell-a", "A1"),
				sessionStatus("shell-b", "busy"),
			]);

			const version = yield* readModelVersion;
			const [first, second] = yield* takeN(q, 2);
			if (first?._tag !== "upsert" || second?._tag !== "upsert") {
				throw new Error("expected two upserts");
			}
			// Recency order out of the query; both stamped by the same commit, so
			// both carry the version that commit moved the read model to.
			expect([first.item.id, second.item.id].sort()).toEqual([
				"shell-a",
				"shell-b",
			]);
			expect(first.sequence).toBe(version);
			expect(second.sequence).toBe(version);
			expect(yield* Queue.size(q)).toBe(0);
		}).pipe(Effect.provide(makeShellTestLayer())),
	);

	it.scoped("traffic that moves no session row emits nothing", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([sessionCreated(SID), messageCreated(SID, "m1")]);

			const requeries = yield* Ref.make(0);
			const real = yield* ReadQueryEffectTag;
			const { q } = yield* openShell({
				readQuery: countingReadQuery(real, requeries),
			});
			yield* takeN(q, 2);

			// Per-token streaming traffic. It advances the message row it belongs
			// to, so the advance does name this session and the shell does look:
			// one indexed range scan over `sessions` that comes back empty. That is
			// what the event-type allowlist — a second copy of the session
			// projector's event list, free to drift from it — used to buy.
			yield* commit(
				Array.from({ length: 200 }, (_, i) => textDelta(SID, "m1", `t${i}`)),
			);
			// FIFO: anything leaked above would surface ahead of this rename.
			yield* commit([sessionRenamed(SID, "Only This")]);

			const delta = yield* Queue.take(q);
			if (delta._tag !== "upsert") throw new Error("expected upsert");
			expect(delta.item.title).toBe("Only This");
			expect(yield* Queue.size(q)).toBe(0);
			// Base read plus at most one scan per ADVANCE — 200 streamed parts in
			// one commit are one advance, and a re-query that overtakes a later
			// advance spends it, so two reads is also a correct outcome here.
			expect(yield* Ref.get(requeries)).toBeLessThanOrEqual(3);
		}).pipe(Effect.provide(makeShellTestLayer())),
	);

	it.scoped(
		"session.deleted through the persist choke point projects the row away and the shell emits remove",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([sessionCreated(SID)]);

				const { q } = yield* openShell();
				const [snapshot] = yield* takeN(q, 2);
				if (snapshot?._tag !== "snapshot") throw new Error("expected snapshot");
				expect(snapshot.rows.map((row) => row.id)).toEqual([SID]);

				// The real producer path: append → project (DELETE row) → publish.
				const persist = yield* ClaudeEventPersistEffectTag;
				yield* persist.persistEvent(sessionDeleted(SID));

				const readQuery = yield* ReadQueryEffectTag;
				expect(yield* readQuery.getSession(SID)).toBeUndefined();

				const delta = yield* Queue.take(q);
				if (delta._tag !== "remove") throw new Error("expected remove");
				expect(delta.id).toBe(SID);
				// A deleted row leaves no version behind (§8), so the removal carries
				// the advance's own version — the number the client resumes from.
				expect(delta.sequence).toBe(yield* readModelVersion);
				expect(yield* Queue.size(q)).toBe(0);
			}).pipe(Effect.provide(makeShellTestLayer())),
	);

	it.scoped(
		"deleteSession appends the session.deleted tombstone: row gone, shell emits remove live",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([sessionCreated(SID)]);
				const { q } = yield* openShell();
				yield* takeN(q, 2);

				// The real service-level delete path (provider delete mocked).
				yield* deleteSession(SID);

				const readQuery = yield* ReadQueryEffectTag;
				expect(yield* readQuery.getSession(SID)).toBeUndefined();

				const delta = yield* Queue.take(q);
				if (delta._tag !== "remove") throw new Error("expected remove");
				expect(delta.id).toBe(SID);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						makeShellTestLayer(),
						Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
						makeSessionManagerStateLive(),
					),
				),
			),
	);

	it.scoped(
		"deleting a parent emits remove(parent) AND remove(child) at one sequence, live",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([
					sessionCreated("shell-parent"),
					sessionCreated("shell-child", "Child", "shell-parent"),
				]);

				const { q } = yield* openShell();
				yield* takeN(q, 2);

				const readQuery = yield* ReadQueryEffectTag;
				const before = yield* readQuery.getSession("shell-child");
				expect(before?.parent_id).toBe("shell-parent");

				// The real service-level delete: the tombstone captures descendant ids
				// BEFORE the schema cascade deletes them, so the advance can name
				// every removed row alongside the parent.
				yield* deleteSession("shell-parent");

				const [first, second] = yield* takeN(q, 2);
				if (first?._tag !== "remove") throw new Error("expected remove first");
				if (second?._tag !== "remove")
					throw new Error("expected remove second");
				expect([first.id, second.id].sort()).toEqual([
					"shell-child",
					"shell-parent",
				]);
				// One commit, one version: the pair is a group the client's resume
				// cursor may only cross whole (T-3).
				expect(second.sequence).toBe(first.sequence);
				expect(yield* Queue.size(q)).toBe(0);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						makeShellTestLayer(),
						Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
						makeSessionManagerStateLive(),
					),
				),
			),
	);

	it.scoped(
		"resume rebases: the reconnecting client is told what still exists, not what moved",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([
					sessionCreated("shell-kept"),
					sessionCreated("shell-doomed"),
				]);
				const cursor = yield* readModelVersion;

				// Both changes land while the client is away: one row moves, one
				// disappears. A version-only catch-up could only report the first —
				// the deleted row leaves nothing behind to find — so the client would
				// reconnect still showing a session that is gone.
				yield* commit([sessionRenamed("shell-kept", "Kept")]);
				yield* deleteSession("shell-doomed");

				const { q } = yield* openShell({ resumeFromSequence: cursor });
				const [snapshot, synchronized] = yield* takeN(q, 2);
				if (snapshot?._tag !== "snapshot") throw new Error("expected snapshot");
				expect(snapshot.rows.map((row) => row.id)).toEqual(["shell-kept"]);
				expect(snapshot.rows[0]?.title).toBe("Kept");
				expect(snapshot.sequence).toBe(yield* readModelVersion);
				expect(snapshot.sequence).toBeGreaterThan(cursor);
				expect(synchronized).toEqual({ _tag: "synchronized" });

				// And live continues from the number that snapshot carried.
				yield* commit([sessionStatus("shell-kept", "busy")]);
				const delta = yield* Queue.take(q);
				if (delta._tag !== "upsert") throw new Error("expected upsert");
				expect(delta.item.status).toBe("busy");
				expect(delta.sequence).toBe(yield* readModelVersion);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						makeShellTestLayer(),
						Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
						makeSessionManagerStateLive(),
					),
				),
			),
	);

	it.scoped(
		"exactly-once across the base read: a commit during the read is not re-delivered",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([sessionCreated(SID)]);

				const real = yield* ReadQueryEffectTag;
				const services = yield* Effect.context<
					| EventStoreEffectTag
					| ProjectionRunnerEffectTag
					| SessionEventBusTag
					| SqlClient.SqlClient
				>();
				// A commit lands (and publishes its advance) WHILE the base is being
				// read — after the advance subscription exists, before the rows are
				// taken. The base therefore already carries it, and its buffered
				// advance is at or below the base's version, so the orchestrator
				// drops it rather than re-querying and re-sending the same row.
				const raced = yield* Ref.make(false);
				const racingReadQuery: ReadQueryEffect = {
					...real,
					readSessionList: (afterVersion) =>
						Ref.getAndSet(raced, true).pipe(
							Effect.flatMap((already) =>
								already
									? Effect.void
									: Effect.orDie(
											commit([sessionRenamed(SID, "Raced")]).pipe(
												Effect.provide(services),
											),
										),
							),
							Effect.zipRight(real.readSessionList(afterVersion)),
						),
				};

				const { q } = yield* openShell({ readQuery: racingReadQuery });
				const [snapshot, synchronized] = yield* takeN(q, 2);
				if (snapshot?._tag !== "snapshot") throw new Error("expected snapshot");
				expect(synchronized).toEqual({ _tag: "synchronized" });
				expect(snapshot.rows[0]?.title).toBe("Raced");

				// A genuinely new change still flows exactly once. (The racing wrapper
				// commits on every read, so this one arrives ahead of it in FIFO
				// order and a re-delivered "Raced" would have to precede it.)
				yield* commit([sessionRenamed(SID, "Fresh")]);
				const delta = yield* Queue.take(q);
				if (delta._tag !== "upsert") throw new Error("expected upsert");
				expect(delta.item.title).toBe("Fresh");
			}).pipe(Effect.provide(makeShellTestLayer())),
	);

	it.scoped("closing the scope tears down the advance subscription", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([sessionCreated(SID)]);

			const scope = yield* Scope.make();
			const q = yield* Queue.unbounded<Envelope<SessionInfo>>();
			const fiber = yield* Stream.runForEach(subscribeShell(), (env) =>
				Queue.offer(q, env),
			).pipe(Effect.forkIn(scope));

			yield* takeN(q, 2); // running & subscribed
			yield* Scope.close(scope, Exit.void);

			expect(Exit.isInterrupted(yield* Fiber.await(fiber))).toBe(true);
		}).pipe(Effect.provide(makeShellTestLayer())),
	);
	// Unread is a turn end past the seen marker, and only SessionAttention
	// moves the marker (ADR-0004, Scope; conduit-test-hk9m.3).
	it.scoped(
		"a seen mark reaches a live subscriber with the updated unread state",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commitThroughSeam([
					sessionCreated(SID),
					messageCreated(SID, "m1"),
					canonicalEvent(
						"turn.completed",
						SID,
						{ messageId: "m1" },
						{ provider: "claude" },
					),
				]);

				const { q } = yield* openShell();
				const [snapshot, synchronized] = yield* takeN(q, 2);
				if (snapshot?._tag !== "snapshot") throw new Error("expected snapshot");
				expect(synchronized).toEqual({ _tag: "synchronized" });
				// A turn has ended and nobody has looked: the badge is on.
				expect(snapshot.rows[0]?.unread).toBe(true);
				const baseVersion = snapshot.sequence;

				expect(yield* markSeen(SID, Number.MAX_SAFE_INTEGER)).toBe(true);
				yield* Effect.yieldNow();

				const delta = yield* Queue.take(q);
				if (delta._tag !== "upsert") throw new Error("expected upsert");
				expect(delta.item.id).toBe(SID);
				expect(delta.item.unread).toBeUndefined();
				expect(delta.sequence).toBeGreaterThan(baseVersion);
				expect(delta.sequence).toBe(yield* readModelVersion);
				expect(yield* Queue.size(q)).toBe(0);
			}).pipe(Effect.provide(makeShellTestLayer())),
	);

	// Background work outlives the turn that started it, so the session row
	// says idle while the work runs. Only the in-memory liveness knows.
	it.scoped(
		"background work starting and ending reaches a live subscriber",
		() => {
			const liveness = makeSessionBackgroundLiveness();
			return Effect.gen(function* () {
				yield* recoverProjections;
				yield* commitThroughSeam([sessionCreated(SID)]);
				const { q } = yield* openShell();
				yield* takeN(q, 2);

				const attentionAfter = (types: string[]) =>
					Effect.gen(function* () {
						liveness.record({
							sessionId: SID,
							kind: "snapshot",
							tasks: types.map((type, index) => ({
								id: String(index),
								type,
								description: "Task",
							})),
						});
						yield* announceBackgroundWork(SID);
						yield* Effect.yieldNow();
						const delta = yield* Queue.take(q).pipe(
							Effect.timeout("2 seconds"),
						);
						if (delta._tag !== "upsert") throw new Error("expected upsert");
						return delta.item.attention;
					});
				expect(yield* attentionAfter(["local_agent"])).toBe("working");
				expect(yield* attentionAfter(["local_bash"])).toBe("monitoring");
				expect(yield* attentionAfter([])).toBe("idle");
				expect(yield* Queue.size(q)).toBe(0);
			}).pipe(
				Effect.provideService(BackgroundLivenessTag, liveness.backgroundOf),
				Effect.provide(makeShellTestLayer()),
			);
		},
	);

	it.scoped(
		"a view of an unknown session announces nothing and emits nothing",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commitThroughSeam([sessionCreated(SID)]);

				const { q } = yield* openShell();
				yield* takeN(q, 2);

				yield* commitThroughSeam([
					canonicalEvent(
						"session.read",
						"no-such-session",
						{ sessionId: "no-such-session" },
						{ provider: "claude", createdAt: 9_999_999 },
					),
				]);
				yield* Effect.yieldNow();
				expect(yield* Queue.size(q)).toBe(0);
			}).pipe(Effect.provide(makeShellTestLayer())),
	);

	it.scoped("a message-only advance does not re-emit the session row", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commitThroughSeam([
				sessionCreated(SID),
				messageCreated(SID, "m1"),
			]);

			const { q } = yield* openShell();
			yield* takeN(q, 2);

			// A token advances `messages`, and its advance names the owning
			// session — but the session ROW did not move. Re-emitting the shell
			// row on every token would undo the whole point of coalescing.
			yield* commitThroughSeam([textDelta(SID, "m1", "hello")]);
			yield* Effect.yieldNow();

			expect(yield* Queue.size(q)).toBe(0);
		}).pipe(Effect.provide(makeShellTestLayer())),
	);

	it.scoped("a projection and its advance still produce ONE upsert", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commitThroughSeam([sessionCreated(SID)]);

			const requeries = yield* Ref.make(0);
			const real = yield* ReadQueryEffectTag;
			const { q } = yield* openShell({
				readQuery: countingReadQuery(real, requeries),
			});
			yield* takeN(q, 2);

			// The seam publishes the events AND the advance for the same commit.
			// The subscriber follows the advance and must emit only once.
			yield* commitThroughSeam([sessionRenamed(SID, "Renamed")]);
			yield* Effect.yieldNow();

			const delta = yield* Queue.take(q);
			if (delta._tag !== "upsert") throw new Error("expected upsert");
			expect(delta.item.title).toBe("Renamed");
			expect(yield* Ref.get(requeries)).toBe(2);
			expect(yield* Queue.size(q)).toBe(0);
		}).pipe(Effect.provide(makeShellTestLayer())),
	);
	// ni8.12 group 2: the session's approval mode rides the shell row, so every
	// open subscriber (every tab) follows a switch with no refetch.
	it.scoped(
		"a permission-mode switch reaches two open subscribers as the row's permissionMode",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([sessionCreated(SID)]);
				const tabA = yield* openShell();
				const tabB = yield* openShell();
				const [snapshotA] = yield* takeN(tabA.q, 2);
				yield* takeN(tabB.q, 2);
				if (snapshotA?._tag !== "snapshot")
					throw new Error("expected snapshot");
				expect(snapshotA.rows[0]?.permissionMode).toBeUndefined();

				yield* persistSessionPermissionMode(SID, "plan");

				for (const { q } of [tabA, tabB]) {
					const delta = yield* Queue.take(q);
					if (delta._tag !== "upsert") throw new Error("expected upsert");
					expect(delta.item).toMatchObject({ id: SID, permissionMode: "plan" });
				}
			}).pipe(Effect.provide(makeShellTestLayer())),
	);

	it.scoped(
		"a provider-reported permission mode reaches an open subscription",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([sessionCreated(SID)]);
				const { q } = yield* openShell();
				yield* takeN(q, 2);

				const ingestion = yield* ProviderRuntimeIngestionTag;
				yield* ingestion.ingest(
					decodeProviderRuntimeEvent({
						eventId: "rt-permission-mode",
						type: "session.permission_mode_changed",
						providerId: "claude",
						sessionId: SID,
						createdAt: "2026-10-06T00:00:00.000Z",
						rawSource: {
							kind: "claude.sdk.message",
							providerMessageType: "system",
						},
						providerRefs: { providerSessionId: "provider-shell" },
						data: { sessionId: SID, mode: "acceptEdits" },
					}),
				);

				const delta = yield* Queue.take(q);
				if (delta._tag !== "upsert") throw new Error("expected upsert");
				expect(delta.item).toMatchObject({
					id: SID,
					permissionMode: "acceptEdits",
				});
			}).pipe(
				Effect.provide(
					Layer.provideMerge(
						ProviderRuntimeIngestionLive,
						makeShellTestLayer(),
					),
				),
			),
	);
});
