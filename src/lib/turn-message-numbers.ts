/** Reserve existing citations when numbering messages that never went to Jev. */
export function numberTurnMessages<
	T extends { surfacingOrdinal?: number | null },
>(messages: readonly T[]): (T & { surfacingOrdinal: number })[] {
	const used = new Set(
		messages.flatMap(({ surfacingOrdinal }) =>
			surfacingOrdinal == null ? [] : [surfacingOrdinal],
		),
	);
	let next = 1;
	return messages.map((message) => {
		while (used.has(next)) next++;
		const surfacingOrdinal = message.surfacingOrdinal ?? next;
		next = Math.max(next, surfacingOrdinal + 1);
		return { ...message, surfacingOrdinal };
	});
}
