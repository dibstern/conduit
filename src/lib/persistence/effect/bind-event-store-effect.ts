import { Effect } from "effect";
import {
	type EventStoreEffect,
	EventStoreError,
	type UnboundEventStoreEffect,
} from "./event-store-effect.js";

export const boundProjectMismatch = (
	boundProjectId: string | undefined,
	projectId: string | undefined,
): EventStoreError | undefined =>
	boundProjectId !== undefined &&
	projectId !== undefined &&
	projectId !== boundProjectId
		? new EventStoreError({
				operation: "boundProject",
				projectId,
				ownerProjectId: boundProjectId,
				cause: `Project ${projectId} conflicts with bound project ${boundProjectId}`,
			})
		: undefined;

/** Bind only write provenance; append semantics stay in the daemon store. */
export const bindEventStoreEffect = (
	store: UnboundEventStoreEffect,
	projectId: string,
): EventStoreEffect => ({
	...store,
	projectId,
	append: (event, explicitProjectId) => {
		const mismatch = boundProjectMismatch(projectId, explicitProjectId);
		return mismatch ? Effect.fail(mismatch) : store.append(event, projectId);
	},
	appendBatch: (events, explicitProjectId) => {
		const mismatch = boundProjectMismatch(projectId, explicitProjectId);
		return mismatch
			? Effect.fail(mismatch)
			: store.appendBatch(events, projectId);
	},
});
