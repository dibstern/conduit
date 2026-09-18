// The pre-status bridge owns one clock for the connection scope. Receiving
// authority retires activity synchronously, including between ticker ticks.
let pending = $state.raw<ReadonlyMap<string, number>>(new Map());
const statusReceived = new Set<string>();
let closeScope: (() => void) | undefined;

export const sessionActivityBridge = {
	get pending(): ReadonlyMap<string, number> {
		return pending;
	},
	mark(id: string): void {
		if (statusReceived.has(id)) return;
		pending = new Map(pending).set(id, Date.now());
		closeScope ??= $effect.root(() => {
			const ticker = setInterval(() => {
				const now = Date.now();
				const remaining = new Map(pending);
				for (const [sessionId, timestamp] of pending) {
					if (now - timestamp >= 10_000) remaining.delete(sessionId);
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
	retire(id: string): void {
		statusReceived.add(id);
		if (pending.has(id)) {
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
		statusReceived.clear();
	},
};
