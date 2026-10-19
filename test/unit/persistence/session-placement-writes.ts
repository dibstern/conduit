// Restrict assignments to UPDATEs of sessions, so messages.parent_id and
// containment reads cannot be mistaken for placement writes.
export const placementWrites = (source: string, column: string) =>
	[
		...source.matchAll(
			/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+sessions\s*\(([^)]*)\)|UPDATE\s+sessions\s+SET\b([^;`]*)/gi,
		),
	].filter((match) =>
		match[1] !== undefined
			? new RegExp(`\\b${column}\\b`, "i").test(match[1])
			: new RegExp(`\\b${column}\\s*=(?!=)`, "i").test(
					(match[2] ?? "").split(/\bWHERE\b/i)[0] ?? "",
				),
	);
