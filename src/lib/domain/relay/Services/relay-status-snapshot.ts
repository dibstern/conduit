import { Context, Effect, Layer } from "effect";

export interface RelayStatusSnapshot {
	readonly sessionCount: number;
	readonly isProcessing: boolean;
}

export interface RelayStatusSnapshotService {
	readonly getSnapshot: () => RelayStatusSnapshot;
	readonly setSessionCount: (sessionCount: number) => Effect.Effect<void>;
	readonly setIsProcessing: (isProcessing: boolean) => Effect.Effect<void>;
}

export class RelayStatusSnapshotTag extends Context.Tag("RelayStatusSnapshot")<
	RelayStatusSnapshotTag,
	RelayStatusSnapshotService
>() {}

export const makeRelayStatusSnapshot = (): RelayStatusSnapshotService => {
	let snapshot: RelayStatusSnapshot = { sessionCount: 0, isProcessing: false };
	return {
		getSnapshot: () => snapshot,
		setSessionCount: (sessionCount) =>
			Effect.sync(() => {
				snapshot = { ...snapshot, sessionCount };
			}),
		setIsProcessing: (isProcessing) =>
			Effect.sync(() => {
				snapshot = { ...snapshot, isProcessing };
			}),
	};
};

export const RelayStatusSnapshotLive = Layer.sync(
	RelayStatusSnapshotTag,
	makeRelayStatusSnapshot,
);
