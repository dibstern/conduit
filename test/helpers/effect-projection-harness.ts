// ─── Effect Projection Test Harness ─────────────────────────────────────────
// Drives the projection path the daemon actually runs: a provider runtime event
// goes through ProviderRuntimeIngestion, which translates it to canonical form,
// appends it to the event store and hands it to the Effect projection runner.
//
// Tests that construct a projector directly cannot catch a projector that is
// never dispatched to. Compaction persistence was dead for three months behind
// a green suite for exactly that reason, so reach for this harness whenever the
// question is "does this event actually land in the read model".

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { ProviderRuntimeEvent } from "../../src/lib/contracts/providers/provider-runtime-event.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { EventStoreEffectTag } from "../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	createAllEffectProjectors,
	type EffectProjector,
} from "../../src/lib/persistence/effect/projectors-effect.js";
import { ReadQueryEffectTag } from "../../src/lib/persistence/effect/read-query-effect.js";
import type { StoredEvent } from "../../src/lib/persistence/events.js";
import type { MessageWithParts } from "../../src/lib/persistence/read-model-types.js";

export interface EffectProjectionHarness {
	/** Submit one provider runtime event and wait for projection to settle. */
	readonly ingest: (event: ProviderRuntimeEvent) => Promise<number>;
	readonly ingestBatch: (
		events: readonly ProviderRuntimeEvent[],
	) => Promise<number>;
	/** Rows from the read model, e.g. `query("SELECT * FROM messages")`. */
	readonly query: <T extends object>(
		statement: string,
		params?: readonly (string | number | null)[],
	) => Promise<readonly T[]>;
	/** Raw events as appended, for asserting what was stored versus projected. */
	readonly storedEvents: (sessionId: string) => Promise<readonly StoredEvent[]>;
	/** Re-run projection over already-stored events, as a replay or backfill would. */
	readonly reproject: (events: readonly StoredEvent[]) => Promise<void>;
	/** The read model as session history loads it. */
	readonly sessionMessagesWithParts: (
		sessionId: string,
	) => Promise<MessageWithParts[]>;
	readonly dbPath: string;
	readonly dispose: () => Promise<void>;
}

export function makeEffectProjectionHarness(
	projectors: readonly EffectProjector[] = createAllEffectProjectors(),
): EffectProjectionHarness {
	const dir = mkdtempSync(join(tmpdir(), "conduit-effect-projection-"));
	const dbPath = join(dir, "events.db");

	const persistenceLayer = makePersistenceEffectLayer(dbPath, projectors);
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(
			persistenceLayer,
			ProviderRuntimeIngestionLive.pipe(Layer.provide(persistenceLayer)),
		),
	);

	// The daemon recovers the runner once at startup and the runner refuses to
	// project until it has; do the same here rather than per call.
	let recovered: Promise<void> | undefined;
	const ensureRecovered = () => {
		recovered ??= runtime.runPromise(
			Effect.gen(function* () {
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.recover();
			}),
		);
		return recovered;
	};

	const ingestBatch = async (events: readonly ProviderRuntimeEvent[]) => {
		await ensureRecovered();
		return runtime.runPromise(
			Effect.gen(function* () {
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const count = yield* ingestion.ingestBatch(events);
				yield* ingestion.drain();
				return count;
			}),
		);
	};

	return {
		ingest: (event) => ingestBatch([event]),
		ingestBatch,
		query: <T extends object>(
			statement: string,
			params: readonly (string | number | null)[] = [],
		) =>
			runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					return yield* sql.unsafe<T>(statement, [...params]);
				}),
			),
		reproject: async (events) => {
			await ensureRecovered();
			await runtime.runPromise(
				Effect.gen(function* () {
					const runner = yield* ProjectionRunnerEffectTag;
					yield* runner.projectBatch(events);
				}),
			);
		},
		sessionMessagesWithParts: (sessionId) =>
			runtime.runPromise(
				Effect.flatMap(ReadQueryEffectTag, (readQuery) =>
					readQuery.getSessionMessagesWithParts(sessionId),
				),
			),
		storedEvents: (sessionId) =>
			runtime.runPromise(
				Effect.gen(function* () {
					const eventStore = yield* EventStoreEffectTag;
					return yield* eventStore.readBySession(sessionId);
				}),
			),
		dbPath,
		dispose: async () => {
			await runtime.dispose();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
