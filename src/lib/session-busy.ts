/** Busy rows plus caller-owned activity, propagated through known ancestors. */
export function busySessionIds(
	rows: ReadonlyMap<
		string,
		{
			readonly status: string;
			readonly parentID?: string | undefined;
			readonly sideThread?: boolean | undefined;
		}
	>,
	activity: Iterable<string> = [],
): ReadonlySet<string> {
	const busy = new Set(activity);
	for (const [id, row] of rows) {
		if (row.status === "busy" || row.status === "retry") busy.add(id);
	}
	// Set iteration visits newly added ancestors once, including cyclic lineage.
	for (const id of busy) {
		const row = rows.get(id);
		if (row?.sideThread) continue;
		const parent = row?.parentID;
		if (parent && rows.has(parent)) busy.add(parent);
	}
	return busy;
}
