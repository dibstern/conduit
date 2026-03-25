import type { PermissionBridge } from "../bridges/permission-bridge.js";
import type { ServiceRegistry } from "../daemon/service-registry.js";
import { TrackedService } from "../daemon/tracked-service.js";
import type { RateLimiter } from "../server/rate-limiter.js";

/**
 * Wraps per-relay periodic timers (permission timeout check, rate limiter cleanup)
 * in a TrackedService for lifecycle management.
 */
export class RelayTimers extends TrackedService {
	constructor(
		registry: ServiceRegistry,
		private permissionBridge: PermissionBridge,
		private rateLimiter: RateLimiter,
		private onPermissionTimeout: (id: string) => void,
	) {
		super(registry);
	}

	start(): void {
		this.repeating(() => {
			const timedOut = this.permissionBridge.checkTimeouts();
			for (const id of timedOut) {
				this.onPermissionTimeout(id);
			}
		}, 30_000);

		this.repeating(() => {
			this.rateLimiter.cleanup();
		}, 60_000);
	}
}
