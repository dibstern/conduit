import type { PermissionBridge } from "../bridges/permission-bridge.js";
import type { RateLimiter } from "../server/rate-limiter.js";

/**
 * Wraps per-relay periodic timers (permission timeout check, rate limiter cleanup).
 * Not currently instantiated in src/ — test-only/dormant.
 */
export class RelayTimers {
	private readonly timers = new Set<ReturnType<typeof setInterval>>();

	constructor(
		private permissionBridge: PermissionBridge,
		private rateLimiter: RateLimiter,
		private onPermissionTimeout: (id: string) => void,
	) {}

	start(): void {
		this.timers.add(
			setInterval(() => {
				const timedOut = this.permissionBridge.checkTimeouts();
				for (const entry of timedOut) {
					this.onPermissionTimeout(entry.id);
				}
			}, 30_000),
		);

		this.timers.add(
			setInterval(() => {
				this.rateLimiter.cleanup();
			}, 60_000),
		);
	}

	async drain(): Promise<void> {
		for (const id of this.timers) {
			clearInterval(id);
		}
		this.timers.clear();
	}
}
