/** Busy rows plus caller-owned activity, propagated through known ancestors. */
export function busySessionIds(
	rows: ReadonlyMap<
		string,
		{ readonly status: string; readonly parentID?: string | undefined }
	>,
	activity: Iterable<string> = [],
): ReadonlySet<string> {
	const busy = new Set(activity);
	for (const [id, row] of rows) {
		if (row.status === "busy" || row.status === "retry") busy.add(id);
	}
	// Set iteration visits newly added ancestors once, including cyclic lineage.
	for (const id of busy) {
		const parent = rows.get(id)?.parentID;
		if (parent && rows.has(parent)) busy.add(parent);
	}
	return busy;
}
