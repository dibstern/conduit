import {
	type SessionCreatedPayload,
	STORED_EVENT_HOLDING_FIELDS,
} from "./stored-event.js";

export {
	holdingSessionRefs,
	SessionRef,
	storedEventFields,
} from "./session-ref-schema.js";

const sessionCreatedHoldingPaths = STORED_EVENT_HOLDING_FIELDS.filter(
	([type]) => type === "session.created",
).map(([, path]) => path.slice(2).split("."));

/** Defined lineage holds (parent, Source) in contract order, without deduplication. */
export function sessionCreatedLineage(
	data: SessionCreatedPayload,
	holdingPaths: readonly (readonly string[])[] = sessionCreatedHoldingPaths,
): string[] {
	const refs: string[] = [];
	for (const path of holdingPaths) {
		const value = path.reduce<unknown>(
			(value, key) =>
				typeof value === "object" && value !== null
					? Reflect.get(value, key)
					: undefined,
			data,
		);
		if (typeof value === "string") refs.push(value);
	}
	return refs;
}
