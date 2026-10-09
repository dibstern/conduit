import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { makeProviderStateEffect } from "../../src/lib/persistence/effect/provider-state-effect.js";

export const readNativeThread = (
	filename: string,
	sessionId: string,
	instanceId = "claude",
) =>
	Effect.runPromise(
		makeProviderStateEffect.pipe(
			Effect.flatMap((state) => state.nativeThread(sessionId, instanceId)),
			Effect.provide(
				SqliteClient.layer({ filename, readonly: true, disableWAL: true }),
			),
		),
	);
