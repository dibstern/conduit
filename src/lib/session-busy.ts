/** Busy rows plus caller-owned activity, propagated through known ancestors. */
export function busySessionIds(
	rows: ReadonlyMap<
		string,
		{
			readonly status: string;
			readonly parentID?: string | undefined;
			readonly sideThread?: boolean | undefined;
			readonly backgroundTasks?:
				| readonly {
						readonly childSessionId?: string | undefined;
				  }[]
				| undefined;
		}
	>,
	activity: Iterable<string> = [],
): ReadonlySet<string> {
	const busy = new Set(activity);
	const propagating = new Set(busy);
	const backgroundChildren = new Set(
		[...rows.values()].flatMap(
			(row) =>
				row.backgroundTasks?.flatMap((task) =>
					task.childSessionId ? [task.childSessionId] : [],
				) ?? [],
		),
	);
	for (const [id, row] of rows) {
		if (row.status === "busy" || row.status === "retry") {
			busy.add(id);
			// Suppress this background source, not foreground work beneath it.
			if (!backgroundChildren.has(id)) propagating.add(id);
		}
	}
	// Set iteration visits newly added ancestors once, including cyclic lineage.
	for (const id of propagating) {
		const row = rows.get(id);
		if (row?.sideThread) continue;
		const parent = row?.parentID;
		if (parent && rows.has(parent)) {
			busy.add(parent);
			propagating.add(parent);
		}
	}
	return busy;
}
