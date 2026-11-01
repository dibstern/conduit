// The 2.1 rows 25scs lands: main's units read the Run Ledger's view in their own write (CONTRACT.md
// 2.1, 3.5, 3.9, 4.8). Each through real SQLite, main's commit and the reactor's public interface.
// Row 202, markRunning reads the fence. How it could fail:
// 1. a start is claimed and sent while a wake on its native session has work;
// 2. nothing claims it once the wake ends, so it waits for an unrelated drain;
// 3. the claim's own transmission, minted at its run.requested, holds its own fence.
// Row 212, markRunning reads the cap. How it could fail:
// 4. a direct send that always fails retryably is sent forever, or fewer than 5 times;
// 5. past the cap the input is not failed, or fails without main's code and terminal.
// Row 210, the outcome body retries a declined start. How it could fail:
// 6. the declined start ends `interrupted` with its text dropped, as main;
// 7. it is retried with no backoff, or its retry is not a fresh claim of the same row.
// Row 211, the outcome body returns a start cancelled before it reached the agent. How it could fail:
// 8. its text is dropped, as main, or it returns but not behind the pause;
// 9. a start whose message was placed is returned too, so its value is both shown and re-sent.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Duration, Effect, Layer, Scope } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import { makeProviderRuntimeIngestionLive } from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { loadLedgerView } from "../../../src/lib/persistence/effect/run-ledger-arm.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { ProviderInstanceFailure } from "../../../src/lib/provider/errors.js";
import { ProviderSideEffectReactor } from "../../../src/lib/provider/orchestration-side-effect-reactor.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import type {
	ProviderInstance,
	TurnResult,
} from "../../../src/lib/provider/types.js";
import { makeSessionCreatedEvent } from "../../helpers/persistence-factories.js";

const withStore = <A, E>(
	effect: Effect.Effect<
		A,
		E,
		| SqlClient.SqlClient
		| Scope.Scope
		| Layer.Success<ReturnType<typeof storeLayer>>
	>,
) =>
	Effect.acquireUseRelease(
		Effect.sync(() => mkdtempSync(join(tmpdir(), "run-ledger-unit-rows-"))),
		(dir) =>
			Effect.scoped(effect).pipe(
				Effect.provide(storeLayer(join(dir, "events.db"))),
			),
		(dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
	);
const storeLayer = (file: string) =>
	Layer.provideMerge(
		makeProviderRuntimeIngestionLive(),
		makePersistenceEffectLayer(file, "test-project"),
	);

const completed: TurnResult = {
	status: "completed",
	cost: 0,
	tokens: { input: 0, output: 0 },
	durationMs: 1,
	providerStateUpdates: [],
};

/** A session, its input u1 admitted and handed off, and main's run.requested r1 at dispatch. */
const dispatched = (
	provider: string,
	before: readonly CanonicalEvent[] = [],
) => [
	makeSessionCreatedEvent("s1", { provider, createdAt: 1000 }),
	...before,
	canonicalEvent(
		"input.admitted",
		"s1",
		{
			sessionId: "s1",
			inputId: "u1",
			delivery: "queue",
			request: { text: "hi", images: [] },
		},
		{ createdAt: 1001 },
	),
	canonicalEvent(
		"input.sent",
		"s1",
		{ sessionId: "s1", inputId: "u1" },
		{ createdAt: 1002 },
	),
	canonicalEvent(
		"run.requested",
		"s1",
		{ runId: "r1", inputId: "u1" },
		{ createdAt: 1003, metadata: { runId: "r1" } },
	),
];

/** Main's outbox row and receipt for u1's send, as the command's commit writes them. */
const seedSend = (sql: SqlClient.SqlClient, provider: string) =>
	Effect.all([
		sql`INSERT INTO command_receipts (command_id, session_id, status, created_at, command_type,
			project_key, fingerprint_hash, fingerprint_version, side_effect_sequence, updated_at)
			VALUES ('u1', 's1', 'side_effect_requested', 1003, 'send_turn', 'test-project',
				'sha256:abc', 1, 1, 1003)`,
		sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id,
			provider_id, effect_type, payload_json, run_id, status, attempt_count, requested_at, updated_at)
			VALUES (1, 'u1', 'test-project', 's1', ${provider}, 'send_turn', ${JSON.stringify(
				{
					sessionId: "s1",
					inputId: "u1",
					prompt: "hi",
					history: [],
					providerState: {},
					workspaceRoot: "/repo",
					configDir: configuredClaudeConfigDir("/tmp/25scs-test-claude"),
					folderSource: "account",
				},
			)}, 'r1', 'pending', 0, 1003, 1003)`,
	]);

const provider = (
	providerId: string,
	sendTurnEffect: ProviderInstance["sendTurnEffect"],
): ProviderInstance => ({
	providerId,
	generateTextEffect: () => Effect.die("unused"),
	discoverEffect: () => Effect.die("unused"),
	sendTurnEffect,
	interruptTurnEffect: () => Effect.void,
	resolvePermissionEffect: () => Effect.void,
	resolveQuestionEffect: () => Effect.void,
	shutdownEffect: () => Effect.void,
	endSessionEffect: () => Effect.void,
});

const reactorFor = (
	instance: ProviderInstance,
	nowMs = () => 2000,
	backoff: Duration.Input = Duration.zero,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const commit = yield* makeCommitAndSignal;
		const { persistUserMessage } = yield* ClaudeEventPersistEffectTag;
		const reactor = new ProviderSideEffectReactor({
			persistUserMessage,
			sql,
			write: commit.write,
			ingestion: {
				ingest: () => Effect.die("unused"),
				ingestBatch: () => Effect.die("unused"),
			},
			registry: new ProviderRegistry([instance]),
			scope: yield* Scope.Scope,
			nowMs,
			retryBackoff: () => backoff,
		});
		return { sql, commit, reactor, persistUserMessage };
	});

const sendRow = (sql: SqlClient.SqlClient) =>
	sql<{
		status: string;
		attempt_count: number;
		error_code: string | null;
	}>`SELECT status, attempt_count, error_code FROM provider_command_outbox WHERE command_id = 'u1'`;

describe("Run Ledger 2.1 unit rows (25scs)", () => {
	it.live(
		"row 202: a start waits with no clock while a wake has work, and the commit that ends it claims it",
		() =>
			withStore(
				Effect.gen(function* () {
					const sent: string[] = [];
					const { sql, commit, reactor } = yield* reactorFor(
						provider("claude", (input) =>
							Effect.sync(() => {
								sent.push(input.inputId ?? "");
								return completed;
							}),
						),
					);
					// A Claude wake on the native session, with no main run (8.3).
					yield* commit(
						dispatched("claude", [
							canonicalEvent(
								"evidence.process_started",
								"s1",
								{ runnerId: "rn", label: "rn:1", reattached: false },
								{ provider: "claude", createdAt: 1000 },
							),
							canonicalEvent(
								"evidence.turn_started",
								"s1",
								{ label: "rn:1" },
								{ provider: "claude", createdAt: 1000 },
							),
						]),
					);
					yield* seedSend(sql, "claude");
					yield* reactor.drain();
					// 1: the fence holds the start before its claim.
					expect(sent).toEqual([]);
					expect(yield* sendRow(sql)).toEqual([
						{ status: "pending", attempt_count: 0, error_code: null },
					]);
					// 2: the wake's end releases the fence; its commit wakes the drain.
					yield* commit([
						canonicalEvent(
							"evidence.turn_ended",
							"s1",
							{ label: "rn:1" },
							{ provider: "claude", createdAt: 1010 },
						),
					]);
					for (let tries = 0; tries < 200 && sent.length === 0; tries++)
						yield* Effect.sleep(10);
					expect(sent).toEqual(["u1"]);
				}),
			),
	);

	it.live(
		"row 212: a direct send that always fails retryably is sent 5 times, then fails its input",
		() =>
			withStore(
				Effect.gen(function* () {
					let sends = 0;
					const { sql, commit, reactor } = yield* reactorFor(
						provider("opencode", () =>
							Effect.suspend(() => {
								sends++;
								return Effect.fail(
									new ProviderInstanceFailure({
										providerId: "opencode",
										operation: "sendTurn",
										cause: {
											code: "ECONNRESET",
											message: "OpenCode unreachable",
											retryable: true,
										},
									}),
								);
							}),
						),
					);
					yield* commit(dispatched("opencode"));
					yield* seedSend(sql, "opencode");
					// 3: the claim's own transmission does not hold its fence.
					for (
						let tries = 0;
						tries < 10 && (yield* sendRow(sql))[0]?.status !== "failed";
						tries++
					)
						yield* reactor.drain();
					// 4, 5: five sends; the sixth claim fails the input with main's exhaustion code.
					expect(sends).toBe(5);
					expect(yield* sendRow(sql)).toEqual([
						{
							status: "failed",
							attempt_count: 6,
							error_code: "provider_send_attempts_exhausted",
						},
					]);
					expect(
						yield* sql`SELECT status FROM command_receipts WHERE command_id = 'u1'`,
					).toEqual([{ status: "side_effect_failed" }]);
					const view = yield* loadLedgerView("s1");
					expect(view?.active).toBeUndefined();
				}),
			),
	);

	it.live(
		"row 210: a declined start is retried with main's backoff, and its retry lands",
		() =>
			withStore(
				Effect.gen(function* () {
					let now = 2000;
					const replies: TurnResult[] = [
						{ ...completed, status: "steer-declined" },
						completed,
					];
					let sends = 0;
					const { sql, commit, reactor } = yield* reactorFor(
						provider("codex", () =>
							Effect.sync(() => replies[sends++] ?? completed),
						),
						() => now,
						Duration.seconds(1),
					);
					yield* commit(dispatched("codex"));
					yield* seedSend(sql, "codex");
					yield* reactor.drain();
					// 6: the decline is a retryable outcome, not an interrupted end.
					expect(sends).toBe(1);
					expect(
						yield* sql`SELECT status, error_code, next_attempt_at FROM provider_command_outbox`,
					).toEqual([
						{
							status: "retryable_failed",
							error_code: "input_declined",
							next_attempt_at: 3000,
						},
					]);
					expect(
						yield* sql`SELECT json_extract(data, '$.code') AS code, json_extract(data, '$.retryable') AS retryable
							FROM events WHERE type IN ('turn.error', 'turn.interrupted')`,
					).toEqual([{ code: "input_declined", retryable: 1 }]);
					// 7: not before its backoff, then a fresh claim of the same row.
					yield* reactor.drain();
					expect(sends).toBe(1);
					now = 3000;
					yield* reactor.drain();
					expect(sends).toBe(2);
					expect(yield* sendRow(sql)).toEqual([
						{ status: "completed", attempt_count: 2, error_code: null },
					]);
				}),
			),
	);

	for (const placed of [false, true])
		it.live(
			`row 211: a start cancelled before it reached the agent returns behind the pause (placed=${placed})`,
			() =>
				withStore(
					Effect.gen(function* () {
						const { sql, commit, reactor, persistUserMessage } =
							yield* reactorFor(
								provider("claude", () =>
									Effect.succeed<TurnResult>({
										...completed,
										status: "cancelled",
									}),
								),
							);
						yield* commit(dispatched("claude"));
						if (placed)
							yield* persistUserMessage("s1", "hi", {
								messageId: "m-u1",
								inputId: "u1",
								runId: "r1",
								provider: "claude",
							});
						yield* seedSend(sql, "claude");
						yield* reactor.drain();
						expect(yield* sql`SELECT status FROM provider_runs`).toEqual([
							{ status: "interrupted" },
						]);
						// 8: returned to the inbox, paused; 9: never when its message was placed.
						expect(
							yield* sql`SELECT json_extract(metadata, '$.runId') AS run_id FROM events WHERE type = 'input.requeued'`,
						).toEqual(placed ? [] : [{ run_id: "r1" }]);
						expect(
							yield* sql`SELECT state FROM pending_inputs WHERE input_id = 'u1'`,
						).toEqual([{ state: placed ? "removed" : "queued" }]);
						const read = yield* ReadQueryEffectTag;
						expect(yield* read.readInboxState("s1")).toMatchObject({
							paused: !placed,
						});
					}),
				),
		);
});
