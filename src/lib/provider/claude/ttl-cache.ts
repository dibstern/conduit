/**
 * Tiny TTL-bounded async cache with in-flight deduplication.
 *
 * Failed lookups are not cached, so the next call retries instead of pinning a
 * transient failure until the TTL expires.
 */
export class TTLCache<T> {
	private value: T | undefined;
	private expiresAt = 0;
	private inFlight: Promise<T> | undefined;

	constructor(
		private readonly ttlMs: number,
		private readonly lookup: () => Promise<T>,
	) {}

	async get(): Promise<T> {
		if (this.value !== undefined && Date.now() < this.expiresAt) {
			return this.value;
		}
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.lookup()
			.then((value) => {
				this.value = value;
				this.expiresAt = Date.now() + this.ttlMs;
				return value;
			})
			.finally(() => {
				this.inFlight = undefined;
			});
		return this.inFlight;
	}

	invalidate(): void {
		this.value = undefined;
		this.expiresAt = 0;
	}
}
