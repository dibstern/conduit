// ─── State-Machine Model Test: SSE Reconnection & Backoff (Ticket 1.2) ──────
//
// Uses fc.commands() + fc.modelRun() to exercise arbitrary interleavings of:
//   - Connect (SSE stream opens)
//   - Disconnect (SSE stream drops)
//   - ReceiveEvent (SSE event received — updates lastEventAt)
//   - Reconnect (reconnection attempt — increments counter, sets connected)
//   - AdvanceTime (simulated clock advance)
//   - CheckStale (verify staleness detection matches model)
//   - CheckHealth (verify getHealth() shape matches model)
//   - BackoffBounds (verify backoff delay is within bounds and monotonic)
//
// Model:
//   connected: boolean
//   lastEventAt: number | null
//   reconnectCount: number
//   currentTime: number
//
// Invariants verified after each command:
//   - Health shape matches model state
//   - Stale detection: connected && lastEventAt != null && (now - lastEventAt > threshold)
//   - Reconnect count is monotonically non-decreasing

import fc from "fast-check";
import { describe, it } from "vitest";
import {
	type BackoffConfig,
	calculateBackoffDelay,
	createHealthTracker,
	type HealthTracker,
} from "../../../src/lib/relay/sse-backoff.js";

const SEED = 42;
const NUM_RUNS = 100;

// ─── Model ──────────────────────────────────────────────────────────────────

interface ModelState {
	connected: boolean;
	lastEventAt: number | null;
	reconnectCount: number;
	currentTime: number;
	staleThreshold: number;
}

interface RealState {
	tracker: HealthTracker;
	currentTime: number;
	staleThreshold: number;
	advanceTime: (ms: number) => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function modelIsStale(model: ModelState): boolean {
	if (!model.connected) return false;
	if (model.lastEventAt === null) return false;
	return model.currentTime - model.lastEventAt > model.staleThreshold;
}

// ─── Commands ───────────────────────────────────────────────────────────────

class ConnectCommand implements fc.Command<ModelState, RealState> {
	check(_model: Readonly<ModelState>): boolean {
		return true;
	}

	run(model: ModelState, real: RealState): void {
		model.connected = true;
		real.tracker.onConnected();

		const health = real.tracker.getHealth();
		if (health.connected !== model.connected) {
			throw new Error(
				`Connected mismatch after Connect: model=${model.connected}, real=${health.connected}`,
			);
		}
	}

	toString(): string {
		return "Connect()";
	}
}

class DisconnectCommand implements fc.Command<ModelState, RealState> {
	check(_model: Readonly<ModelState>): boolean {
		return true;
	}

	run(model: ModelState, real: RealState): void {
		model.connected = false;
		real.tracker.onDisconnected();

		const health = real.tracker.getHealth();
		if (health.connected !== false) {
			throw new Error(
				`Connected should be false after Disconnect, got ${health.connected}`,
			);
		}

		// Disconnected -> never stale
		if (real.tracker.isStale()) {
			throw new Error("isStale should be false when disconnected");
		}
	}

	toString(): string {
		return "Disconnect()";
	}
}

class ReceiveEventCommand implements fc.Command<ModelState, RealState> {
	check(_model: Readonly<ModelState>): boolean {
		return true;
	}

	run(model: ModelState, real: RealState): void {
		model.lastEventAt = model.currentTime;
		real.tracker.onEvent();

		const health = real.tracker.getHealth();
		if (health.lastEventAt !== model.lastEventAt) {
			throw new Error(
				`lastEventAt mismatch: model=${model.lastEventAt}, real=${health.lastEventAt}`,
			);
		}
	}

	toString(): string {
		return "ReceiveEvent()";
	}
}

class ReconnectCommand implements fc.Command<ModelState, RealState> {
	check(_model: Readonly<ModelState>): boolean {
		return true;
	}

	run(model: ModelState, real: RealState): void {
		model.reconnectCount++;
		model.connected = true;
		real.tracker.onReconnect();

		if (real.tracker.getReconnectCount() !== model.reconnectCount) {
			throw new Error(
				`Reconnect count: model=${model.reconnectCount}, real=${real.tracker.getReconnectCount()}`,
			);
		}

		const health = real.tracker.getHealth();
		if (health.connected !== true) {
			throw new Error("Should be connected after onReconnect");
		}
	}

	toString(): string {
		return "Reconnect()";
	}
}

class AdvanceTimeCommand implements fc.Command<ModelState, RealState> {
	constructor(readonly ms: number) {}

	check(_model: Readonly<ModelState>): boolean {
		return this.ms > 0;
	}

	run(model: ModelState, real: RealState): void {
		model.currentTime += this.ms;
		real.advanceTime(this.ms);

		// After advancing time, staleness should match model prediction
		const expectedStale = modelIsStale(model);
		const actualStale = real.tracker.isStale();

		if (expectedStale !== actualStale) {
			throw new Error(
				`Stale mismatch after advance(${this.ms}ms): ` +
					`model=${expectedStale}, real=${actualStale} ` +
					`(connected=${model.connected}, lastEventAt=${model.lastEventAt}, ` +
					`now=${model.currentTime}, threshold=${model.staleThreshold})`,
			);
		}
	}

	toString(): string {
		return `AdvanceTime(+${this.ms}ms)`;
	}
}

class CheckStaleCommand implements fc.Command<ModelState, RealState> {
	check(_model: Readonly<ModelState>): boolean {
		return true;
	}

	run(model: ModelState, real: RealState): void {
		const expected = modelIsStale(model);
		const actual = real.tracker.isStale();

		if (expected !== actual) {
			throw new Error(
				`isStale mismatch: model=${expected}, real=${actual} ` +
					`(connected=${model.connected}, lastEventAt=${model.lastEventAt}, ` +
					`now=${model.currentTime}, threshold=${model.staleThreshold})`,
			);
		}
	}

	toString(): string {
		return "CheckStale()";
	}
}

class CheckHealthCommand implements fc.Command<ModelState, RealState> {
	check(_model: Readonly<ModelState>): boolean {
		return true;
	}

	run(model: ModelState, real: RealState): void {
		const health = real.tracker.getHealth();

		if (typeof health.connected !== "boolean") {
			throw new Error(
				`health.connected is not boolean: ${typeof health.connected}`,
			);
		}
		if (health.connected !== model.connected) {
			throw new Error(
				`health.connected: model=${model.connected}, real=${health.connected}`,
			);
		}
		if (health.lastEventAt !== model.lastEventAt) {
			throw new Error(
				`health.lastEventAt: model=${model.lastEventAt}, real=${health.lastEventAt}`,
			);
		}
		if (health.reconnectCount !== model.reconnectCount) {
			throw new Error(
				`health.reconnectCount: model=${model.reconnectCount}, real=${health.reconnectCount}`,
			);
		}
		if (typeof health.stale !== "boolean") {
			throw new Error(`health.stale is not boolean: ${typeof health.stale}`);
		}

		const expectedStale = modelIsStale(model);
		if (health.stale !== expectedStale) {
			throw new Error(
				`health.stale: expected=${expectedStale}, got=${health.stale}`,
			);
		}
	}

	toString(): string {
		return "CheckHealth()";
	}
}

class BackoffBoundsCommand implements fc.Command<ModelState, RealState> {
	constructor(
		readonly attempt: number,
		readonly config: BackoffConfig,
	) {}

	check(_model: Readonly<ModelState>): boolean {
		return true;
	}

	run(_model: ModelState, _real: RealState): void {
		const delay = calculateBackoffDelay(this.attempt, this.config);

		if (delay < this.config.baseDelay) {
			throw new Error(
				`Backoff delay ${delay} below baseDelay ${this.config.baseDelay} ` +
					`(attempt=${this.attempt})`,
			);
		}

		if (delay > this.config.maxDelay) {
			throw new Error(
				`Backoff delay ${delay} above maxDelay ${this.config.maxDelay} ` +
					`(attempt=${this.attempt})`,
			);
		}

		// Monotonicity: delay(n) <= delay(n+1)
		if (this.attempt >= 0) {
			const nextDelay = calculateBackoffDelay(this.attempt + 1, this.config);
			if (nextDelay < delay) {
				throw new Error(
					`Backoff not monotonic: delay(${this.attempt})=${delay}, ` +
						`delay(${this.attempt + 1})=${nextDelay}`,
				);
			}
		}
	}

	toString(): string {
		return `BackoffBounds(attempt=${this.attempt}, base=${this.config.baseDelay}, max=${this.config.maxDelay})`;
	}
}

// ─── Arbitraries ────────────────────────────────────────────────────────────

const arbBackoffConfig: fc.Arbitrary<BackoffConfig> = fc
	.record({
		baseDelay: fc.integer({ min: 100, max: 5_000 }),
		maxDelay: fc.integer({ min: 100, max: 60_000 }),
		multiplier: fc.constantFrom(1.5, 2, 3),
	})
	.map((c) => ({
		...c,
		maxDelay: Math.max(c.maxDelay, c.baseDelay),
	}));

const allCommands = fc.commands(
	[
		// Connection lifecycle
		fc.constant(new ConnectCommand()),
		fc.constant(new DisconnectCommand()),
		fc.constant(new ReceiveEventCommand()),
		fc.constant(new ReconnectCommand()),

		// Time manipulation
		fc
			.integer({ min: 1, max: 120_000 })
			.map((ms) => new AdvanceTimeCommand(ms)),

		// State verification
		fc.constant(new CheckStaleCommand()),
		fc.constant(new CheckHealthCommand()),

		// Backoff bounds
		fc
			.tuple(fc.integer({ min: -5, max: 30 }), arbBackoffConfig)
			.map(([attempt, config]) => new BackoffBoundsCommand(attempt, config)),
	],
	{ maxCommands: 50 },
);

// ─── Test ───────────────────────────────────────────────────────────────────

describe("Ticket 1.2 — SSE Backoff & Health Tracker State Machine PBT", () => {
	it("property: arbitrary command sequences maintain model/real health tracker consistency", () => {
		fc.assert(
			fc.property(allCommands, (cmds) => {
				const THRESHOLD = 30_000;
				let currentTime = 1_000_000;

				const model: ModelState = {
					connected: false,
					lastEventAt: null,
					reconnectCount: 0,
					currentTime,
					staleThreshold: THRESHOLD,
				};

				const real: RealState = {
					tracker: createHealthTracker({
						staleThreshold: THRESHOLD,
						now: () => currentTime,
					}),
					currentTime,
					staleThreshold: THRESHOLD,
					advanceTime(ms: number) {
						currentTime += ms;
						real.currentTime = currentTime;
					},
				};

				fc.modelRun(() => ({ model, real }), cmds);
			}),
			{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
		);
	});
});
