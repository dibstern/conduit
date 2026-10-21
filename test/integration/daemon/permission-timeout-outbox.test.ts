// Failures: a committed answer times out while delivery waits, a timeout reads
// before an answer commits, unanswered prompts never expire, or a failed durable
// lookup denies a prompt whose answer may already be committed.
import { writeFileSync } from "node:fs";
import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { afterAll, expect } from "vitest";
import {
	makePendingInteractionServiceLive,
	PendingInteractionServiceTag,
} from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { LoggerTag } from "../../../src/lib/domain/relay/Services/services.js";
import { recordPermissionTimedOut } from "../../../src/lib/handlers/permissions.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import { CommandReadModelRepository } from "../../../src/lib/provider/orchestration-read-model.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import type { ProviderInstance } from "../../../src/lib/provider/types.js";
import { PermissionId } from "../../../src/lib/shared-types.js";

const evidence: Record<string, unknown>[] = [];
afterAll(() => {
	writeFileSync(
		"/tmp/82tn27-2-permission-timeout.json",
		JSON.stringify(evidence, null, 2),
	);
});

const fixture = () => {
	const persistence = makePersistenceEffectLayer(":memory:", "test-project");
	return Layer.mergeAll(
		persistence,
		ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
		makePendingInteractionServiceLive({ permissionTimeoutMs: 1_000 }),
		Layer.succeed(LoggerTag)(createSilentLogger()),
	);
};

const seed = Effect.gen(function* () {
	const commit = yield* makeCommitAndSignal;
	yield* commit([
		canonicalEvent("session.created", "session-1", {
			sessionId: "session-1",
			title: "Permission timeout",
			provider: "claude",
		}),
		canonicalEvent("permission.asked", "session-1", {
			id: "permission-1",
			sessionId: "session-1",
			toolName: "Bash",
			input: {},
			providerProcessId: "process-1",
			providerRequestId: "native-1",
		}),
	]);
	const pending = yield* PendingInteractionServiceTag;
	const permission = yield* pending.beginPermissionRequest({
		requestId: Schema.decodeUnknownSync(PermissionId)("permission-1"),
		sessionId: "session-1",
		toolName: "Bash",
		toolInput: {},
	});
	return { commit, pending, permission };
});

const makeEngine = (
	resolvePermissionEffect: ProviderInstance["resolvePermissionEffect"],
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const commit = yield* makeCommitAndSignal;
		const instance: ProviderInstance = {
			providerId: "claude",
			getControlProcessIdEffect: () => Effect.succeed("process-1"),
			discoverEffect: () => Effect.never,
			sendTurnEffect: () => Effect.never,
			interruptTurnEffect: () => Effect.void,
			resolvePermissionEffect,
			resolveQuestionEffect: () => Effect.void,
			endSessionEffect: () => Effect.void,
			shutdownEffect: () => Effect.void,
		};
		const engine = new OrchestrationEngine({
			registry: new ProviderRegistry([instance]),
			durableCommands: {
				sql,
				snapshot: yield* new CommandReadModelRepository(
					sql,
					"test-project",
				).bootstrap(),
				projectKey: "test-project",
				now: () => 1000,
				generateId: () => "unused-run",
				ingestion: yield* ProviderRuntimeIngestionTag,
				write: commit.write,
			},
		});
		yield* Effect.addFinalizer(() => engine.shutdownEffect());
		engine.bindSession("session-1", "claude");
		return engine;
	});

describe("permission timeout after durable answer acceptance", () => {
	it.effect(
		"commits timeout delivery before releasing the waiter and replays it once",
		() =>
			Effect.gen(function* () {
				const { pending, permission } = yield* seed;
				const sql = yield* SqlClient.SqlClient;
				const waiter = yield* Effect.forkChild(
					Effect.result(permission.awaitResponse),
				);
				yield* TestClock.adjust("1 second");
				yield* pending.takeTimedOutPermissions();
				expect(
					yield* sql`SELECT status, provider_process_id, json_extract(payload_json, '$.decision') AS decision FROM provider_command_outbox`,
				).toEqual([
					{
						status: "pending",
						provider_process_id: "process-1",
						decision: "reject",
					},
				]);
				expect(yield* Fiber.join(waiter)).toMatchObject({ _tag: "Failure" });
				const delivered: string[] = [];
				const restarted = yield* makeEngine((_session, _request, decision) =>
					Effect.sync(() => void delivered.push(decision)),
				);
				yield* restarted.drainSideEffects();
				yield* restarted.drainSideEffects();
				expect(delivered).toEqual(["reject"]);
				expect(yield* sql`SELECT status FROM command_receipts`).toEqual([
					{ status: "side_effect_completed" },
				]);
			}).pipe(Effect.scoped, Effect.provide(fixture())),
	);

	it.effect(
		"recovers a legacy timeout rejection after the notification was lost",
		() =>
			Effect.gen(function* () {
				const { commit } = yield* seed;
				yield* commit([
					canonicalEvent(
						"permission.resolved",
						"session-1",
						{ id: "permission-1", decision: "reject" },
						{ metadata: { source: "permission-timeout" } },
					),
				]);
				const delivered: string[] = [];
				const restarted = yield* makeEngine((_session, _request, decision) =>
					Effect.sync(() => void delivered.push(decision)),
				);
				yield* restarted.drainSideEffects();
				yield* restarted.drainSideEffects();
				expect(delivered).toEqual(["reject"]);
			}).pipe(Effect.scoped, Effect.provide(fixture())),
	);

	it.effect(
		"rolls back timeout resolution when durable delivery cannot commit",
		() =>
			Effect.gen(function* () {
				const { pending, permission } = yield* seed;
				const sql = yield* SqlClient.SqlClient;
				const waiter = yield* Effect.forkChild(permission.awaitResponse);
				yield* sql`CREATE TRIGGER reject_timeout_delivery BEFORE INSERT ON provider_command_outbox BEGIN SELECT RAISE(ABORT, 'timeout delivery failed'); END`;
				yield* TestClock.adjust("1 second");
				expect(yield* pending.takeTimedOutPermissions()).toEqual([]);
				expect(waiter.pollUnsafe()).toBeUndefined();
				expect(yield* sql`SELECT status FROM pending_approvals`).toEqual([
					{ status: "pending" },
				]);
				expect(yield* sql`SELECT command_id FROM command_receipts`).toEqual([]);
				yield* sql`DROP TRIGGER reject_timeout_delivery`;
				expect(yield* pending.takeTimedOutPermissions()).toHaveLength(1);
				expect(yield* pending.takeTimedOutPermissions()).toEqual([]);
				expect(
					yield* sql`SELECT command_id FROM provider_command_outbox`,
				).toHaveLength(1);
			}).pipe(Effect.provide(fixture())),
	);
	it.effect(
		"keeps the waiter alive while the committed answer waits for delivery",
		() =>
			Effect.gen(function* () {
				const { pending, permission } = yield* seed;
				const sql = yield* SqlClient.SqlClient;
				const started = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const delivered: string[] = [];
				let rejected = 0;
				const engine = yield* makeEngine((_session, _request, decision) =>
					Deferred.succeed(started, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
						Effect.andThen(Effect.sync(() => void delivered.push(decision))),
					),
				);
				yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
				const waiter = yield* Effect.forkChild(
					permission.awaitResponse.pipe(
						Effect.tapError(() =>
							Effect.sync(() => {
								rejected++;
							}),
						),
					),
				);
				const dispatch = yield* Effect.forkChild(
					engine.dispatchEffect({
						type: "resolve_permission",
						commandId: "answer-1",
						sessionId: "session-1",
						requestId: "permission-1",
						nativeRequestId: "native-1",
						providerProcessId: "process-1",
						decision: "once",
					}),
				);
				yield* Deferred.await(started);
				const rows =
					yield* sql`SELECT pending_approvals.status AS prompt_status, provider_command_outbox.status AS delivery_status
				FROM pending_approvals JOIN provider_command_outbox ON provider_command_outbox.session_id = pending_approvals.session_id
				WHERE pending_approvals.id = 'permission-1' AND provider_command_outbox.command_id = 'answer-1'`;
				expect(rows).toEqual([
					{ prompt_status: "resolved", delivery_status: "running" },
				]);
				yield* TestClock.adjust("1 second");
				const expired = yield* pending.takeTimedOutPermissions();
				yield* Effect.yieldNow;
				expect(expired).toEqual([]);
				expect(waiter.pollUnsafe()).toBeUndefined();
				expect(rejected).toBe(0);
				expect(delivered).toEqual([]);
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(dispatch);
				yield* pending.resolvePermissionRequest("permission-1", {
					decision: "once",
				});
				expect(yield* Fiber.join(waiter)).toEqual({ decision: "once" });
				expect(delivered).toEqual(["once"]);
				evidence.push({
					scenario: "committed-answer-held-delivery",
					expired,
					rejected,
					delivered,
				});
			}).pipe(Effect.scoped, Effect.provide(fixture())),
	);

	it.effect(
		"rejects a late answer immediately after timeout, before the waiter records its failure",
		() =>
			Effect.gen(function* () {
				const { pending, permission } = yield* seed;
				const sql = yield* SqlClient.SqlClient;
				const delivered: string[] = [];
				const engine = yield* makeEngine((_session, _request, decision) =>
					Effect.sync(() => void delivered.push(decision)),
				);
				const waiter = yield* Effect.forkChild(
					Effect.result(permission.awaitResponse),
				);
				yield* TestClock.adjust("1 second");
				const expired = yield* pending.takeTimedOutPermissions();
				const answer = yield* Effect.result(
					engine.dispatchEffect({
						type: "resolve_permission",
						commandId: "late-answer",
						sessionId: "session-1",
						requestId: "permission-1",
						nativeRequestId: "native-1",
						providerProcessId: "process-1",
						decision: "once",
					}),
				);
				expect(answer).toMatchObject({
					_tag: "Failure",
					failure: { _tag: "StaleCommandRejected" },
				});
				expect(delivered).toEqual([]);
				expect(
					yield* sql`SELECT command_id FROM provider_command_outbox WHERE command_id = 'late-answer'`,
				).toEqual([]);
				expect(
					yield* sql`SELECT status, decision FROM pending_approvals WHERE id = 'permission-1'`,
				).toEqual([{ status: "resolved", decision: "reject" }]);
				expect(
					yield* sql`SELECT json_extract(metadata, '$.source') AS source FROM events WHERE type = 'permission.resolved'`,
				).toEqual([{ source: "permission-timeout" }]);
				expect(yield* Fiber.join(waiter)).toMatchObject({ _tag: "Failure" });
				evidence.push({
					scenario: "timeout-before-late-answer",
					expired,
					answer,
					delivered,
				});
			}).pipe(Effect.scoped, Effect.provide(fixture())),
	);

	it.effect(
		"retains the pending waiter when timeout projection rolls back",
		() =>
			Effect.gen(function* () {
				const { pending, permission } = yield* seed;
				const sql = yield* SqlClient.SqlClient;
				const waiter = yield* Effect.forkChild(permission.awaitResponse);
				yield* sql`CREATE TRIGGER reject_timeout_projection BEFORE UPDATE ON pending_approvals BEGIN SELECT RAISE(ABORT, 'timeout projection failed'); END`;
				yield* TestClock.adjust("1 second");
				const expired = yield* pending.takeTimedOutPermissions();
				expect(expired).toEqual([]);
				expect(waiter.pollUnsafe()).toBeUndefined();
				expect(yield* pending.listPendingPermissions()).toHaveLength(1);
				expect(
					yield* sql`SELECT status FROM pending_approvals WHERE id = 'permission-1'`,
				).toEqual([{ status: "pending" }]);
				expect(
					yield* sql`SELECT sequence FROM events WHERE type = 'permission.resolved'`,
				).toEqual([]);
				evidence.push({ scenario: "timeout-projection-rollback", expired });
			}).pipe(Effect.provide(fixture())),
	);

	it.effect(
		"waits for an answer transaction to commit before deciding expiry",
		() =>
			Effect.gen(function* () {
				const { commit, pending, permission } = yield* seed;
				const projected = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
				const waiter = yield* Effect.forkChild(permission.awaitResponse);
				const answer = yield* Effect.forkChild(
					commit(
						[
							canonicalEvent("permission.resolved", "session-1", {
								id: "permission-1",
								decision: "once",
							}),
						],
						{
							beforeCommit: Deferred.succeed(projected, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
							),
						},
					),
				);
				yield* Deferred.await(projected);
				yield* TestClock.adjust("1 second");
				const expiry = yield* Effect.forkChild(
					pending.takeTimedOutPermissions(),
				);
				yield* Effect.yieldNow;
				expect(expiry.pollUnsafe()).toBeUndefined();
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(answer);
				const expired = yield* Fiber.join(expiry);
				expect(expired).toEqual([]);
				expect(waiter.pollUnsafe()).toBeUndefined();
				yield* pending.resolvePermissionRequest("permission-1", {
					decision: "once",
				});
				expect(yield* Fiber.join(waiter)).toEqual({ decision: "once" });
				evidence.push({ scenario: "answer-commit-races-timeout", expired });
			}).pipe(Effect.scoped, Effect.provide(fixture())),
	);

	it.effect("continues expiring unanswered persisted permissions", () =>
		Effect.gen(function* () {
			const { pending, permission } = yield* seed;
			const waiter = yield* Effect.forkChild(
				Effect.result(permission.awaitResponse),
			);
			yield* TestClock.adjust("1 second");
			const expired = yield* pending.takeTimedOutPermissions();
			expect(expired).toEqual([
				{ id: "permission-1", sessionId: "session-1", awaited: true },
			]);
			expect(yield* Fiber.join(waiter)).toMatchObject({
				_tag: "Failure",
				failure: { reason: "Permission request timed out" },
			});
			evidence.push({ scenario: "unanswered-permission-expires", expired });
		}).pipe(Effect.provide(fixture())),
	);

	it.effect(
		"does not record another rejection after durable timeout of an unwaited prompt",
		() =>
			Effect.gen(function* () {
				const { pending } = yield* seed;
				const sql = yield* SqlClient.SqlClient;
				yield* pending.markPermissionReplied("permission-1");
				yield* pending.recordPermissionRequest({
					requestId: Schema.decodeUnknownSync(PermissionId)("permission-1"),
					sessionId: "session-1",
					toolName: "Bash",
					toolInput: {},
				});
				yield* TestClock.adjust("1 second");
				const expired = yield* pending.takeTimedOutPermissions();
				expect(expired).toEqual([
					{ id: "permission-1", sessionId: "session-1", awaited: false },
				]);
				for (let attempt = 0; attempt < 2; attempt++)
					yield* recordPermissionTimedOut({
						id: "permission-1",
						sessionId: "session-1",
					});
				const resolutions =
					yield* sql`SELECT json_extract(metadata, '$.source') AS source FROM events WHERE type = 'permission.resolved'`;
				expect(resolutions).toEqual([{ source: "permission-timeout" }]);
				evidence.push({
					scenario: "unwaited-timeout-no-duplicate-rejection",
					expired,
					resolutions,
				});
			}).pipe(Effect.provide(fixture())),
	);

	it.effect(
		"leaves waiters alone when durable resolution cannot be checked",
		() =>
			Effect.gen(function* () {
				const { pending, permission } = yield* seed;
				const sql = yield* SqlClient.SqlClient;
				const waiter = yield* Effect.forkChild(permission.awaitResponse);
				yield* sql`ALTER TABLE pending_approvals RENAME TO unavailable_pending_approvals`;
				yield* TestClock.adjust("1 second");
				const expired = yield* pending.takeTimedOutPermissions();
				expect(expired).toEqual([]);
				expect(waiter.pollUnsafe()).toBeUndefined();
				expect(yield* pending.listPendingPermissions()).toHaveLength(1);
				evidence.push({ scenario: "durable-lookup-failure", expired });
			}).pipe(Effect.provide(fixture())),
	);
});
