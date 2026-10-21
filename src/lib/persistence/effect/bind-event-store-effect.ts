import type {
	EventStoreEffect,
	UnboundEventStoreEffect,
} from "./event-store-effect.js";

/** Bind only write provenance; append semantics stay in the daemon store. */
export const bindEventStoreEffect = (
	store: UnboundEventStoreEffect,
	projectId: string,
): EventStoreEffect => ({
	...store,
	projectId,
	append: (event) => store.append(event, projectId),
	appendBatch: (events) => store.appendBatch(events, projectId),
});
