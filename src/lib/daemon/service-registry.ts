/** Minimal interface for drainable services, avoiding generic variance issues. */
export interface Drainable {
	drain(): Promise<void>;
}

/**
 * Collects TrackedService instances. One drainAll() call cleans up everything.
 */
export class ServiceRegistry {
	private readonly services = new Set<Drainable>();

	/** Number of registered services. Exposed for testing. */
	get size(): number {
		return this.services.size;
	}

	/** Register a service. Called automatically by TrackedService constructor. */
	register(service: Drainable): void {
		this.services.add(service);
	}

	/** Drain all registered services and clear the registry. */
	async drainAll(): Promise<void> {
		await Promise.allSettled([...this.services].map((s) => s.drain()));
		this.services.clear();
	}
}
