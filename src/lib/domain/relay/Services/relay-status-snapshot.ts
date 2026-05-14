import { Context, Effect, Layer } from "effect";

export interface RelayStatusSnapshot {
	readonly sessionCount: number;
}

export interface RelayStatusSnapshotService {
	readonly getSnapshot: () => RelayStatusSnapshot;
	readonly setSessionCount: (sessionCount: number) => Effect.Effect<void>;
}

export class RelayStatusSnapshotTag extends Context.Tag("RelayStatusSnapshot")<
	RelayStatusSnapshotTag,
	RelayStatusSnapshotService
>() {}

export const makeRelayStatusSnapshot = (): RelayStatusSnapshotService => {
	let snapshot: RelayStatusSnapshot = { sessionCount: 0 };
	return {
		getSnapshot: () => snapshot,
		setSessionCount: (sessionCount) =>
			Effect.sync(() => {
				snapshot = { ...snapshot, sessionCount };
			}),
	};
};

export const RelayStatusSnapshotLive = Layer.sync(
	RelayStatusSnapshotTag,
	makeRelayStatusSnapshot,
);
