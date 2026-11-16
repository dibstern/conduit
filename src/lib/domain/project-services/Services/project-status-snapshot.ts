import { Context, Effect, Layer } from "effect";

export interface ProjectStatusSnapshot {
	readonly sessionCount: number;
	readonly isProcessing: boolean;
}

export interface ProjectStatusSnapshotService {
	readonly getSnapshot: () => ProjectStatusSnapshot;
	readonly setSessionCount: (sessionCount: number) => Effect.Effect<void>;
	readonly setIsProcessing: (isProcessing: boolean) => Effect.Effect<void>;
}

export class ProjectStatusSnapshotTag extends Context.Service<
	ProjectStatusSnapshotTag,
	ProjectStatusSnapshotService
>()("ProjectStatusSnapshot") {}

export const makeProjectStatusSnapshot = (): ProjectStatusSnapshotService => {
	let snapshot: ProjectStatusSnapshot = {
		sessionCount: 0,
		isProcessing: false,
	};
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

export const ProjectStatusSnapshotLive = Layer.sync(
	ProjectStatusSnapshotTag,
	makeProjectStatusSnapshot,
);
