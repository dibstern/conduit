// Arrival order is shared by activity and rows on this connection. Wall time
// is used only for expiry, never to compare client activity with server rows.
let sequence = 0;
let pending = $state.raw<
	ReadonlyMap<string, { sequence: number; observedAt: number }>
>(new Map());
const authority = new Map<string, number>();
const removed = new Set<string>();
let closeScope: (() => void) | undefined;

export const sessionActivityBridge = {
	get pending() {
		return pending;
	},
	observe(): number {
		return ++sequence;
	},
	mark(id: string): void {
		const observedSequence = sessionActivityBridge.observe();
		if (removed.has(id) || (authority.get(id) ?? 0) >= observedSequence) return;
		pending = new Map(pending).set(id, {
			sequence: observedSequence,
			observedAt: Date.now(),
		});
		closeScope ??= $effect.root(() => {
			const ticker = setInterval(() => {
				const now = Date.now();
				const remaining = new Map(pending);
				for (const [sessionId, observation] of pending) {
					if (now - observation.observedAt >= 10_000)
						remaining.delete(sessionId);
				}
				if (remaining.size !== pending.size) pending = remaining;
				if (pending.size === 0) {
					closeScope?.();
					closeScope = undefined;
				}
			}, 100);
			return () => clearInterval(ticker);
		});
	},
	retire(
		id: string,
		receivedSequence: number,
		kind: "row" | "omission" | "remove",
	): void {
		// Only an explicit removal blocks future activity. A received row
		// restores that id; snapshot omission merely retires pending activity.
		if (kind === "remove") removed.add(id);
		if (kind === "row") removed.delete(id);
		authority.set(id, receivedSequence);
		const observation = pending.get(id);
		if (observation !== undefined && receivedSequence > observation.sequence) {
			const remaining = new Map(pending);
			remaining.delete(id);
			pending = remaining;
		}
		if (pending.size === 0) {
			closeScope?.();
			closeScope = undefined;
		}
	},
	/** Release the shared ticker and observations on connection/project close. */
	clear(): void {
		closeScope?.();
		closeScope = undefined;
		pending = new Map();
		authority.clear();
		removed.clear();
		sequence = 0;
	},
};
