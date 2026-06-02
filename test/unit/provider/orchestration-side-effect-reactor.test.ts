import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	decodeProviderRuntimeEvent,
	type ProviderRuntimeEvent,
} from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import { ProviderInstanceFailure } from "../../../src/lib/provider/errors.js";
import { ProviderSideEffectReactor } from "../../../src/lib/provider/orchestration-side-effect-reactor.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import type {
	ProviderCapabilities,
	ProviderInstance,
	SendTurnInput,
	TurnResult,
} from "../../../src/lib/provider/types.js";

const completedTurn: TurnResult = {
	status: "completed",
	cost: 0,
	tokens: { input: 0, output: 0 },
	durationMs: 1,
	providerStateUpdates: [],
};

const emptyCapabilities: ProviderCapabilities = {
	models: [],
	supportsTools: false,
	supportsThinking: false,
	supportsPermissions: false,
	supportsQuestions: false,
	supportsAttachments: false,
	supportsFork: false,
	supportsRevert: false,
	commands: [],
};

function makeProvider(
	sendTurnEffect: ProviderInstance["sendTurnEffect"],
): ProviderInstance {
	return {
		providerId: "claude",
		discoverEffect: () => Effect.succeed(emptyCapabilities),
		sendTurnEffect,
		interruptTurnEffect: () => Effect.void,
		resolvePermissionEffect: () => Effect.void,
		resolveQuestionEffect: () => Effect.void,
		shutdownEffect: () => Effect.void,
		endSessionEffect: () => Effect.void,
	};
}

describe("ProviderSideEffectReactor", () => {
	let db: SqliteClient;

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
	});

	afterEach(() => {
		db.close();
	});

	it("executes committed side effects once after commit", async () => {
		const sendTurn = vi.fn((_input: SendTurnInput) =>
			Effect.succeed(completedTurn),
		);
		seedSendTurnOutbox(db);
		const reactor = new ProviderSideEffectReactor({
			db,
			registry: new ProviderRegistry([makeProvider(sendTurn)]),
			ingestion: { ingest: vi.fn(() => Effect.succeed(1)) },
			nowMs: () => 2000,
		});

		expect(sendTurn).not.toHaveBeenCalled();
		await Effect.runPromise(reactor.drain());
		await Effect.runPromise(reactor.drain());

		expect(sendTurn).toHaveBeenCalledTimes(1);
		expect(sendTurn.mock.calls[0]?.[0]).toMatchObject({
			sessionId: "session-1",
			turnId: "turn-1",
			prompt: "hello",
			workspaceRoot: "/repo",
		});
		expect(
			db.queryOne<{ status: string; attempt_count: number }>(
				"SELECT status, attempt_count FROM provider_command_outbox WHERE request_sequence = ?",
				[10],
			),
		).toEqual({ status: "completed", attempt_count: 1 });
		expect(
			db.queryOne<{ status: string }>(
				"SELECT status FROM command_receipts WHERE command_id = ?",
				["cmd-1"],
			),
		).toEqual({ status: "side_effect_completed" });
	});

	it("hands provider output to provider runtime ingestion", async () => {
		const runtimeEvent = decodeProviderRuntimeEvent({
			eventId: "runtime-text-1",
			type: "text.delta",
			providerId: "claude",
			sessionId: "session-1",
			turnId: "turn-1",
			providerRefs: {},
			rawSource: { kind: "test.provider-runtime" },
			createdAt: 1000,
			data: {
				messageId: "message-1",
				partId: "text-1",
				text: "streamed",
			},
		});
		const ingest = vi.fn((_event: ProviderRuntimeEvent) => Effect.succeed(1));
		const sendTurn = vi.fn(
			(
				input: SendTurnInput,
			): Effect.Effect<TurnResult, ProviderInstanceFailure> =>
				input.eventSink.push(runtimeEvent).pipe(
					Effect.as(completedTurn),
					Effect.mapError(
						(cause) =>
							new ProviderInstanceFailure({
								providerId: "claude",
								operation: "sendTurn",
								cause,
							}),
					),
				),
		);
		seedSendTurnOutbox(db);
		const reactor = new ProviderSideEffectReactor({
			db,
			registry: new ProviderRegistry([makeProvider(sendTurn)]),
			ingestion: { ingest },
			nowMs: () => 2000,
		});

		await Effect.runPromise(reactor.drain());

		expect(ingest).toHaveBeenCalledWith(runtimeEvent);
	});

	it("backs off retryable provider failures without hot looping", async () => {
		let now = 2000;
		const sendTurn = vi.fn(
			(
				_input: SendTurnInput,
			): Effect.Effect<TurnResult, ProviderInstanceFailure> =>
				Effect.fail(
					new ProviderInstanceFailure({
						providerId: "claude",
						operation: "sendTurn",
						cause: { code: "rate_limit", retryable: true },
					}),
				),
		);
		seedSendTurnOutbox(db);
		const reactor = new ProviderSideEffectReactor({
			db,
			registry: new ProviderRegistry([makeProvider(sendTurn)]),
			ingestion: { ingest: vi.fn(() => Effect.succeed(1)) },
			nowMs: () => now,
			retryDelayMs: 500,
		});

		await Effect.runPromise(reactor.drain());
		await Effect.runPromise(reactor.drain());

		expect(sendTurn).toHaveBeenCalledTimes(1);
		expect(
			db.queryOne<{
				status: string;
				attempt_count: number;
				error_code: string | null;
				next_attempt_at: number | null;
			}>(
				`SELECT status, attempt_count, error_code, next_attempt_at
				 FROM provider_command_outbox WHERE request_sequence = ?`,
				[10],
			),
		).toEqual({
			status: "retryable_failed",
			attempt_count: 1,
			error_code: "rate_limit",
			next_attempt_at: 2500,
		});

		now = 2500;
		await Effect.runPromise(reactor.drain());

		expect(sendTurn).toHaveBeenCalledTimes(2);
	});

	it("marks provider lookup failures instead of leaving outbox rows running", async () => {
		seedSendTurnOutbox(db);
		const reactor = new ProviderSideEffectReactor({
			db,
			registry: new ProviderRegistry(),
			ingestion: { ingest: vi.fn(() => Effect.succeed(1)) },
			nowMs: () => 2000,
		});

		await Effect.runPromise(reactor.runOnce());

		expect(
			db.queryOne<{
				status: string;
				attempt_count: number;
				error_code: string | null;
			}>(
				`SELECT status, attempt_count, error_code
				 FROM provider_command_outbox WHERE request_sequence = ?`,
				[10],
			),
		).toEqual({
			status: "failed",
			attempt_count: 1,
			error_code: "provider_not_registered",
		});
	});

	it("marks malformed outbox payloads as typed failures", async () => {
		const sendTurn = vi.fn((_input: SendTurnInput) =>
			Effect.succeed(completedTurn),
		);
		seedSendTurnOutbox(db, { payloadJson: "{not json" });
		const reactor = new ProviderSideEffectReactor({
			db,
			registry: new ProviderRegistry([makeProvider(sendTurn)]),
			ingestion: { ingest: vi.fn(() => Effect.succeed(1)) },
			nowMs: () => 2000,
		});

		await Effect.runPromise(reactor.runOnce());

		expect(sendTurn).not.toHaveBeenCalled();
		expect(
			db.queryOne<{ status: string; error_code: string | null }>(
				`SELECT status, error_code
				 FROM provider_command_outbox WHERE request_sequence = ?`,
				[10],
			),
		).toEqual({
			status: "failed",
			error_code: "provider_command_payload_parse_failed",
		});
	});

	it("marks structurally invalid outbox payloads as typed failures", async () => {
		const sendTurn = vi.fn((_input: SendTurnInput) =>
			Effect.succeed(completedTurn),
		);
		seedSendTurnOutbox(db, {
			payloadJson: JSON.stringify({ sessionId: "session-1" }),
		});
		const reactor = new ProviderSideEffectReactor({
			db,
			registry: new ProviderRegistry([makeProvider(sendTurn)]),
			ingestion: { ingest: vi.fn(() => Effect.succeed(1)) },
			nowMs: () => 2000,
		});

		await Effect.runPromise(reactor.runOnce());

		expect(sendTurn).not.toHaveBeenCalled();
		expect(
			db.queryOne<{ status: string; error_code: string | null }>(
				`SELECT status, error_code
				 FROM provider_command_outbox WHERE request_sequence = ?`,
				[10],
			),
		).toEqual({
			status: "failed",
			error_code: "provider_command_payload_parse_failed",
		});
	});

	it("returns typed unsupported interaction failures from the reactor event sink", async () => {
		const sendTurn = vi.fn((input: SendTurnInput) =>
			input.eventSink
				.requestPermission({
					requestId: "req-1",
					toolName: "Bash",
					toolInput: { command: "whoami" },
					sessionId: "session-1",
					turnId: "turn-1",
					providerItemId: "tool-1",
				})
				.pipe(
					Effect.as(completedTurn),
					Effect.mapError(
						(cause) =>
							new ProviderInstanceFailure({
								providerId: "claude",
								operation: "sendTurn",
								cause,
							}),
					),
				),
		);
		seedSendTurnOutbox(db);
		const reactor = new ProviderSideEffectReactor({
			db,
			registry: new ProviderRegistry([makeProvider(sendTurn)]),
			ingestion: { ingest: vi.fn(() => Effect.succeed(1)) },
			nowMs: () => 2000,
		});

		await Effect.runPromise(reactor.runOnce());

		expect(
			db.queryOne<{ status: string; error_code: string | null }>(
				`SELECT status, error_code
				 FROM provider_command_outbox WHERE request_sequence = ?`,
				[10],
			),
		).toEqual({
			status: "failed",
			error_code: "provider_side_effect_interaction_unsupported",
		});
	});
});

function seedSendTurnOutbox(
	db: SqliteClient,
	options: { readonly payloadJson?: string } = {},
): void {
	db.execute(
		`INSERT INTO command_receipts (
			command_id, session_id, status, created_at, command_type, project_key,
			fingerprint_hash, fingerprint_version, side_effect_sequence, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			"cmd-1",
			"session-1",
			"side_effect_requested",
			1000,
			"send_turn",
			"project-1",
			"sha256:abc",
			1,
			10,
			1000,
		],
	);
	db.execute(
		`INSERT INTO provider_command_outbox (
			request_sequence, command_id, project_key, session_id, provider_id,
			effect_type, payload_json, status, attempt_count, requested_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
		[
			10,
			"cmd-1",
			"project-1",
			"session-1",
			"claude",
			"send_turn",
			options.payloadJson ??
				JSON.stringify({
					sessionId: "session-1",
					turnId: "turn-1",
					prompt: "hello",
					history: [],
					providerState: {},
					workspaceRoot: "/repo",
				}),
			1000,
			1000,
		],
	);
}
