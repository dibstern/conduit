import type { PermissionBridge } from "../bridges/permission-bridge.js";

/**
 * Wraps per-relay periodic timers (permission timeout check).
 * Rate limiter cleanup is handled by the Effect RateLimiterLive scoped fiber.
 * Not currently instantiated in src/ — test-only/dormant.
 */
export class RelayTimers {
	private readonly timers = new Set<ReturnType<typeof setInterval>>();

	constructor(
		private permissionBridge: PermissionBridge,
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
	}

	async drain(): Promise<void> {
		for (const id of this.timers) {
			clearInterval(id);
		}
		this.timers.clear();
	}
}
