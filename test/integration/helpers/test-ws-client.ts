// ─── Test WebSocket Client ───────────────────────────────────────────────────
// Connects to the relay's WebSocket endpoint and provides typed helpers for
// sending messages, waiting for specific response types, and inspecting
// everything received. Used by integration tests.

import WebSocket from "ws";

export interface ReceivedMessage {
	type: string;
	[key: string]: unknown;
}

export class TestWsClient {
	private ws: WebSocket;
	private received: ReceivedMessage[] = [];
	private waiters: Array<{
		predicate: (msg: ReceivedMessage) => boolean;
		resolve: (msg: ReceivedMessage) => void;
		reject: (err: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}> = [];
	private openPromise: Promise<void>;

	constructor(url: string) {
		this.ws = new WebSocket(url);

		this.openPromise = new Promise<void>((resolve, reject) => {
			this.ws.once("open", () => resolve());
			this.ws.once("error", (err) => reject(err));
		});

		this.ws.on("message", (data) => {
			try {
				const msg = JSON.parse(data.toString()) as ReceivedMessage;
				this.received.push(msg);

				// Check waiters
				for (let i = this.waiters.length - 1; i >= 0; i--) {
					// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
					const waiter = this.waiters[i]!;
					if (waiter.predicate(msg)) {
						clearTimeout(waiter.timer);
						waiter.resolve(msg);
						this.waiters.splice(i, 1);
					}
				}
			} catch {
				// Ignore non-JSON messages
			}
		});
	}

	/** Wait for the WebSocket connection to open */
	async waitForOpen(): Promise<void> {
		await this.openPromise;
	}

	/** Send a typed message to the relay */
	send(msg: Record<string, unknown>): void {
		this.ws.send(JSON.stringify(msg));
	}

	/** Wait for a message matching a type (and optional predicate) */
	waitFor(
		type: string,
		opts?: { timeout?: number; predicate?: (msg: ReceivedMessage) => boolean },
	): Promise<ReceivedMessage> {
		const timeout = opts?.timeout ?? 5000;

		// Check already-received messages first
		const existing = this.received.find(
			(m) => m.type === type && (!opts?.predicate || opts.predicate(m)),
		);
		if (existing) return Promise.resolve(existing);

		return new Promise<ReceivedMessage>((resolve, reject) => {
			const timer = setTimeout(() => {
				const idx = this.waiters.findIndex((w) => w.resolve === resolve);
				if (idx >= 0) this.waiters.splice(idx, 1);
				const types = this.received.map((m) => m.type).join(", ");
				reject(new Error(`Timeout waiting for "${type}" (got: [${types}])`));
			}, timeout);

			this.waiters.push({
				predicate: (m) =>
					m.type === type && (!opts?.predicate || opts.predicate(m)),
				resolve,
				reject,
				timer,
			});
		});
	}

	/** Wait for the initial connect handshake to settle (session_switched + status + lists) */
	async waitForInitialState(timeout = 5000): Promise<void> {
		await Promise.all([
			this.waitFor("session_switched", { timeout }),
			this.waitFor("status", { timeout }),
			this.waitFor("session_list", { timeout }),
		]);
		// Give agents/models a moment to arrive (they're async)
		await new Promise((r) => setTimeout(r, 100));
	}

	/**
	 * Wait for any of the given message types (first match wins).
	 * Useful when a response could start with different event types
	 * (e.g., "delta" or "thinking_delta" depending on model behavior).
	 */
	waitForAny(
		types: string[],
		opts?: { timeout?: number },
	): Promise<ReceivedMessage> {
		const timeout = opts?.timeout ?? 5000;

		// Check already-received messages first
		const existing = this.received.find((m) => types.includes(m.type));
		if (existing) return Promise.resolve(existing);

		return new Promise<ReceivedMessage>((resolve, reject) => {
			const timer = setTimeout(() => {
				const idx = this.waiters.findIndex((w) => w.resolve === resolve);
				if (idx >= 0) this.waiters.splice(idx, 1);
				const receivedTypes = this.received.map((m) => m.type).join(", ");
				reject(
					new Error(
						`Timeout waiting for any of [${types.join(", ")}] (got: [${receivedTypes}])`,
					),
				);
			}, timeout);

			this.waiters.push({
				predicate: (m) => types.includes(m.type),
				resolve,
				reject,
				timer,
			});
		});
	}

	/** Get all received messages */
	getReceived(): ReceivedMessage[] {
		return [...this.received];
	}

	/** Get all messages of a specific type */
	getReceivedOfType(type: string): ReceivedMessage[] {
		return this.received.filter((m) => m.type === type);
	}

	/** Clear received messages */
	clearReceived(): void {
		this.received = [];
	}

	/** Close the connection */
	async close(): Promise<void> {
		// Cancel all waiters
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error("Client closed"));
		}
		this.waiters = [];

		if (
			this.ws.readyState === WebSocket.OPEN ||
			this.ws.readyState === WebSocket.CONNECTING
		) {
			return new Promise<void>((resolve) => {
				this.ws.once("close", () => resolve());
				this.ws.close();
			});
		}
	}
}
