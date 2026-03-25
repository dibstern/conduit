import { EventEmitter } from "node:events";
import { AsyncTracker } from "./async-tracker.js";
import type { Drainable, ServiceRegistry } from "./service-registry.js";

/**
 * Base class for daemon services that do background async work.
 * Provides tracked wrappers for fetch, setInterval, setTimeout,
 * and fire-and-forget promises. All work is cancellable via drain().
 *
 * Children use this.fetch(), this.repeating(), this.delayed(), this.tracked()
 * instead of raw APIs. Never call raw setInterval/setTimeout/fetch in a
 * TrackedService subclass.
 */
export abstract class TrackedService<
		Events extends Record<string, unknown[]> = Record<string, never[]>,
	>
	extends EventEmitter<Events>
	implements Drainable
{
	private readonly _tracker = new AsyncTracker();

	constructor(registry: ServiceRegistry) {
		super();
		registry.register(this as Drainable);
	}

	/** fetch() with automatic abort signal and promise tracking. Merges caller signal with tracker signal. */
	protected fetch(url: string, init?: RequestInit): Promise<Response> {
		const signal = init?.signal
			? AbortSignal.any([this._tracker.signal, init.signal])
			: this._tracker.signal;
		const p = fetch(url, { ...init, signal });
		try {
			return this._tracker.track(p);
		} catch {
			// track() throws if drained — suppress the dangling fetch rejection
			p.catch(() => {});
			throw new Error("Cannot fetch after drain");
		}
	}

	/** Tracked setInterval — cleared automatically on drain(). */
	protected repeating(
		fn: () => void,
		ms: number,
	): ReturnType<typeof setInterval> {
		return this._tracker.interval(fn, ms);
	}

	/** Tracked setTimeout — cleared automatically on drain(). */
	protected delayed(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
		return this._tracker.timeout(fn, ms);
	}

	/** Track a fire-and-forget promise for drain. */
	protected tracked<T>(promise: Promise<T>): Promise<T> {
		return this._tracker.track(promise);
	}

	/** Clear a specific tracked timer. */
	protected clearTrackedTimer(id: ReturnType<typeof setInterval>): void {
		this._tracker.clearTimer(id);
	}

	/** Exposes the tracker's AbortSignal for subclasses that call standalone functions. */
	protected get abortSignal(): AbortSignal {
		return this._tracker.signal;
	}

	/** Cancel all work and wait for in-flight operations to settle. */
	async drain(): Promise<void> {
		await this._tracker.drain();
	}
}
