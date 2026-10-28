import { Clock, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { vi } from "vitest";
import { AccountDirectory } from "../../src/lib/domain/daemon/Services/account-directory.js";
import { ProviderRuntimeIngestionTag } from "../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { makeCommitAndSignal } from "../../src/lib/persistence/effect/commit-and-signal.js";
import {
	ProviderInstanceFailure,
	ProviderNotRegistered,
} from "../../src/lib/provider/errors.js";
import { ProviderControlPayloadSchema } from "../../src/lib/provider/orchestration-command-contracts.js";
import { controlFingerprintHash } from "../../src/lib/provider/orchestration-command-fingerprint.js";
import { OrchestrationEngine } from "../../src/lib/provider/orchestration-engine.js";
import { CommandReadModelRepository } from "../../src/lib/provider/orchestration-read-model.js";
import { ProviderRegistry } from "../../src/lib/provider/provider-registry.js";
import type { ProviderInstance } from "../../src/lib/provider/types.js";
import { partialFake } from "./partial-fake.js";

export function withDispatchEffect<T extends object>(
	engine: T,
): T & OrchestrationEngine {
	const mutable = engine as T & {
		dispatch?: (command: unknown) => Promise<unknown>;
		dispatchEffect?: (command: unknown) => Effect.Effect<unknown, unknown>;
		getProviderForSessionEffect?: (
			sessionId: string,
		) => Effect.Effect<string | undefined>;
		resolveCallContextEffect?: OrchestrationEngine["resolveCallContextEffect"];
		preparePreWarmSessionEffect?: OrchestrationEngine["preparePreWarmSessionEffect"];
		resolveSessionCallContextEffect?: OrchestrationEngine["resolveSessionCallContextEffect"];
		bindSession?: (sessionId: string, providerId: string) => void;
		unbindSession?: (sessionId: string) => void;
	};
	const bindings = new Map<string, string>();
	mutable.resolveCallContextEffect ??= vi.fn(() => Effect.succeed(undefined));
	mutable.preparePreWarmSessionEffect ??= (_sessionId, preparation) =>
		preparation;
	mutable.resolveSessionCallContextEffect ??= vi.fn(() =>
		Effect.succeed(undefined),
	);
	const originalGetProviderForSession =
		mutable.getProviderForSessionEffect?.bind(mutable);
	mutable.getProviderForSessionEffect = vi.fn((sessionId: string) => {
		const boundProviderId = bindings.get(sessionId);
		return boundProviderId !== undefined || !originalGetProviderForSession
			? Effect.succeed(boundProviderId)
			: originalGetProviderForSession(sessionId);
	});
	mutable.bindSession = vi.fn((sessionId: string, providerId: string) => {
		bindings.set(sessionId, providerId);
	});
	mutable.unbindSession = vi.fn((sessionId: string) => {
		bindings.delete(sessionId);
	});
	if (!mutable.dispatchEffect && mutable.dispatch) {
		mutable.dispatchEffect = vi.fn((command: unknown) =>
			Effect.tryPromise(() => Promise.resolve(mutable.dispatch?.(command))),
		);
	}
	return mutable as T & OrchestrationEngine;
}

// These service tests fake dispatch. Stop acceptance still uses the production
// engine and writer, so its cohort and pending settlement cannot drift.
export const withDurableStopAcceptance = (engine: OrchestrationEngine) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const commit = yield* makeCommitAndSignal;
		const ingestion = yield* ProviderRuntimeIngestionTag;
		const directory = yield* AccountDirectory;
		const dispatch = engine.dispatchEffect.bind(engine);
		engine.acceptStopEffect = (input) =>
			Effect.gen(function* () {
				const providerId =
					(yield* engine.getProviderForSessionEffect(input.sessionId)) ??
					"opencode";
				// Older fixtures predate project ownership and durable control receipts.
				yield* sql`INSERT OR IGNORE INTO sessions (id, project_id, provider, created_at, updated_at) VALUES (${input.sessionId}, 'test-project', ${providerId}, 1, 1)`;
				yield* sql`UPDATE sessions SET project_id = 'test-project' WHERE id = ${input.sessionId}`;
				const [stored] = yield* sql<{
					payload_json: string;
					requested_at: number;
				}>`SELECT payload_json, requested_at FROM provider_command_outbox WHERE command_id = ${input.commandId} AND effect_type IN ('interrupt_turn', 'end_session')`;
				if (stored) {
					const payload = Schema.decodeSync(
						Schema.fromJsonString(ProviderControlPayloadSchema),
					)(stored.payload_json);
					yield* sql`INSERT OR IGNORE INTO command_receipts (command_id, session_id, project_key, command_type, status, fingerprint_hash, fingerprint_version, created_at, updated_at)
						VALUES (${input.commandId}, ${input.sessionId}, 'test-project', ${payload.type}, 'side_effect_requested', ${controlFingerprintHash(payload)}, 2, ${stored.requested_at}, ${stored.requested_at})`;
				}
				const now = yield* Clock.currentTimeMillis;
				const acceptedBy = new OrchestrationEngine({
					registry: new ProviderRegistry(
						["claude", "opencode", "cursor"].map((driver) =>
							partialFake<ProviderInstance>({
								providerId: driver,
								getControlProcessIdEffect: () =>
									Effect.succeed("fixture-process"),
							}),
						),
					),
					accountDirectory: directory,
					durableCommands: {
						sql,
						projectKey: "test-project",
						snapshot: yield* new CommandReadModelRepository(
							sql,
							"test-project",
						).bootstrap(),
						ingestion,
						write: commit.write,
						now: () => now,
						generateId: () => "unused-stop-id",
					},
				});
				acceptedBy.bindSession(input.sessionId, providerId);
				return yield* acceptedBy
					.acceptStopEffect(input)
					.pipe(Effect.ensuring(acceptedBy.shutdownEffect()));
			}).pipe(
				Effect.mapError((cause) =>
					cause instanceof ProviderInstanceFailure ||
					cause instanceof ProviderNotRegistered
						? cause
						: new ProviderInstanceFailure({
								providerId: "conduit",
								operation: "fixtureStop",
								cause,
							}),
				),
			);
		engine.executeAcceptedStopEffect = (input) =>
			Effect.gen(function* () {
				const [stored] = yield* sql<{
					payload_json: string;
				}>`SELECT payload_json FROM provider_command_outbox WHERE command_id = ${input.commandId}`;
				if (!stored)
					return yield* new ProviderInstanceFailure({
						providerId: "conduit",
						operation: "fixtureStop",
						cause: new Error("Missing accepted Stop"),
					});
				const { providerProcessId: _target, ...payload } = Schema.decodeSync(
					Schema.fromJsonString(ProviderControlPayloadSchema),
				)(stored.payload_json);
				if (
					payload.type === "interrupt_turn" ||
					payload.type === "end_session"
				) {
					const { stop, ...control } = payload;
					yield* dispatch({
						...control,
						...(stop ? { stop } : {}),
						commandId: input.commandId,
					});
				} else yield* dispatch({ ...payload, commandId: input.commandId });
			}).pipe(
				Effect.mapError((cause) =>
					cause instanceof ProviderInstanceFailure ||
					cause instanceof ProviderNotRegistered
						? cause
						: new ProviderInstanceFailure({
								providerId: "conduit",
								operation: "fixtureStop",
								cause,
							}),
				),
			);
		return engine;
	});
