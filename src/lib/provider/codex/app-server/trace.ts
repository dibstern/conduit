import {
	closeSync,
	fchmodSync,
	mkdirSync,
	openSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	type Cause,
	Effect,
	Exit,
	Fiber,
	Queue,
	type Scope,
	Stream,
} from "effect";
import type {
	AppServerTransport,
	AppServerTransportError,
} from "./transport.js";

export interface AppServerTraceHeader {
	readonly scenario: string;
	readonly codexVersion: string;
	readonly recordedAt: string;
}

export interface AppServerTraceMessageRow {
	readonly dir: "out" | "in";
	readonly at: number;
	readonly message: unknown;
}

export interface AppServerTraceExitRow {
	readonly dir: "exit";
	readonly at: number;
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

export type AppServerTraceRow =
	| AppServerTraceMessageRow
	| AppServerTraceExitRow;

/** Capture diagnostics must never affect the transport's result. */
export function captureAppServerTransport(
	transport: AppServerTransport,
	path: string,
	metadata: Pick<AppServerTraceHeader, "scenario" | "codexVersion">,
): Effect.Effect<AppServerTransport, never, Scope.Scope> {
	return Effect.gen(function* () {
		const started = Date.now();
		let descriptor: number | undefined;
		const finishFile = () => {
			if (descriptor === undefined) return;
			const current = descriptor;
			descriptor = undefined;
			try {
				closeSync(current);
			} catch {
				// A failed capture must not affect transport cleanup.
			}
		};
		const record = (value: AppServerTraceHeader | AppServerTraceRow) => {
			if (descriptor === undefined) return;
			try {
				writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
			} catch {
				finishFile();
			}
		};
		yield* Effect.sync(() => {
			try {
				mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
				descriptor = openSync(path, "w", 0o600);
				fchmodSync(descriptor, 0o600);
				record({ ...metadata, recordedAt: new Date().toISOString() });
			} catch {
				finishFile();
			}
		});
		const queue = yield* Queue.unbounded<
			unknown,
			AppServerTransportError | Cause.Done
		>();
		const pump = yield* Effect.forkScoped(
			Effect.gen(function* () {
				const outcome = yield* Effect.exit(
					Stream.runForEach(transport.messages, (message) =>
						Effect.gen(function* () {
							record({ dir: "in", at: Date.now() - started, message });
							yield* Queue.offer(queue, message);
						}),
					),
				);
				const exit = yield* transport.exit;
				record({
					dir: "exit",
					at: Date.now() - started,
					code: exit.code,
					signal: exit.signal,
				});
				finishFile();
				if (Exit.isFailure(outcome)) {
					yield* Queue.failCause(queue, outcome.cause);
				} else {
					yield* Queue.end(queue);
				}
			}),
		);
		const close = Effect.gen(function* () {
			yield* transport.close;
			yield* Fiber.await(pump);
			finishFile();
		});
		yield* Effect.addFinalizer(() => close);
		return {
			send: (message) =>
				Effect.gen(function* () {
					record({ dir: "out", at: Date.now() - started, message });
					yield* transport.send(message);
				}),
			messages: Stream.fromQueue(queue),
			exit: transport.exit,
			close,
		};
	});
}
