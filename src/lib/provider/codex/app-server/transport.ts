import { spawn } from "node:child_process";
import {
	Cause,
	Data,
	Deferred,
	Effect,
	Queue,
	Semaphore,
	Stream,
} from "effect";

export interface AppServerExit {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stderrTail: string;
}

export class AppServerExited extends Data.TaggedError(
	"AppServerExited",
)<AppServerExit> {
	override get message(): string {
		return `Codex app-server exited (code ${this.code}, signal ${this.signal})${this.stderrTail ? `: ${this.stderrTail}` : ""}`;
	}
}

export class AppServerLineTooLong extends Data.TaggedError(
	"AppServerLineTooLong",
)<{
	readonly maxBytes: number;
}> {}

export class AppServerIoError extends Data.TaggedError("AppServerIoError")<{
	readonly operation: string;
	readonly cause: unknown;
}> {}

export type AppServerTransportError =
	| AppServerExited
	| AppServerLineTooLong
	| AppServerIoError;

export interface AppServerTransport {
	readonly send: (
		message: unknown,
	) => Effect.Effect<void, AppServerTransportError>;
	readonly messages: Stream.Stream<unknown, AppServerTransportError>;
	readonly exit: Effect.Effect<AppServerExit>;
	readonly close: Effect.Effect<void>;
}

export interface SpawnAppServerOptions {
	readonly binary?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly cwd?: string;
}

const MAX_LINE_BYTES = 128 * 1024 * 1024;
const STDERR_TAIL_BYTES = 64 * 1024;

export const spawnAppServerTransport = (options: SpawnAppServerOptions = {}) =>
	Effect.acquireRelease(
		Effect.gen(function* () {
			const messages = yield* Queue.unbounded<
				unknown,
				AppServerTransportError
			>();
			const exited = yield* Deferred.make<AppServerExit>();
			const pipesClosed = yield* Deferred.make<void>();
			const closed = yield* Deferred.make<void>();
			const writes = yield* Semaphore.make(1);
			const child = yield* Effect.try({
				try: () =>
					spawn(
						options.binary ??
							options.env?.["CONDUIT_CODEX_BINARY"] ??
							process.env["CONDUIT_CODEX_BINARY"] ??
							"codex",
						["app-server", "--listen", "stdio://"],
						{
							...(options.cwd === undefined ? {} : { cwd: options.cwd }),
							env: options.env ?? process.env,
							stdio: ["pipe", "pipe", "pipe"],
						},
					),
				catch: (cause) => new AppServerIoError({ operation: "spawn", cause }),
			});
			let stderr = Buffer.alloc(0);
			let hasExited = false;
			let closing = false;
			let fatal: AppServerTransportError | undefined;
			let code: number | null = null;
			let signal: NodeJS.Signals | null = null;
			let drainTimer: ReturnType<typeof setTimeout> | undefined;
			const exitDetails = (): AppServerExit => ({
				code,
				signal,
				stderrTail: stderr.toString("utf8"),
			});
			const kill = (signal: NodeJS.Signals) => {
				try {
					child.kill(signal);
				} catch {
					// The process may have exited between the check and the signal.
				}
			};
			const fail = (error: AppServerTransportError) => {
				if (fatal) return;
				fatal = error;
				Queue.failCauseUnsafe(messages, Cause.fail(error));
				kill("SIGKILL");
			};
			const finishMessages = () => {
				clearTimeout(drainTimer);
				Deferred.doneUnsafe(pipesClosed, Effect.void);
				Queue.failCauseUnsafe(
					messages,
					Cause.fail(new AppServerExited(exitDetails())),
				);
			};
			const closePipes = () => {
				child.stdin.destroy();
				child.stdout.destroy();
				child.stderr.destroy();
				finishMessages();
			};
			child.stderr.on("data", (chunk: Buffer) => {
				stderr = Buffer.concat([stderr, chunk]).subarray(-STDERR_TAIL_BYTES);
			});
			const decoder = new TextDecoder();
			let fragments: string[] = [];
			let lineBytes = 0;
			const append = (bytes: Buffer) => {
				lineBytes += bytes.byteLength;
				if (lineBytes > MAX_LINE_BYTES) {
					fragments = [];
					fail(new AppServerLineTooLong({ maxBytes: MAX_LINE_BYTES }));
					return;
				}
				fragments.push(decoder.decode(bytes, { stream: true }));
			};
			const emitLine = () => {
				const line = (fragments.join("") + decoder.decode()).replace(/\r$/, "");
				const bytes = lineBytes;
				fragments = [];
				lineBytes = 0;
				if (line.trim().length === 0) return;
				try {
					const message: unknown = JSON.parse(line);
					Queue.offerUnsafe(messages, message);
				} catch {
					console.warn("codex.decode_failed", { method: "unknown", bytes });
				}
			};
			child.stdout.on("data", (chunk: Buffer) => {
				let start = 0;
				while (start < chunk.length && !fatal) {
					const newline = chunk.indexOf(10, start);
					append(chunk.subarray(start, newline < 0 ? chunk.length : newline));
					if (fatal || newline < 0) break;
					emitLine();
					start = newline + 1;
				}
			});
			child.stdout.on("end", () => {
				if (!fatal && lineBytes > 0) emitLine();
			});
			child.stdout.on("error", (cause) =>
				fail(new AppServerIoError({ operation: "read stdout", cause })),
			);
			child.stderr.on("error", (cause) =>
				fail(new AppServerIoError({ operation: "read stderr", cause })),
			);
			// Keep an error listener even when no write is waiting (notably on EPIPE).
			child.stdin.on("error", () => {});
			child.on("exit", (exitCode, exitSignal) => {
				hasExited = true;
				code = exitCode;
				signal = exitSignal;
				Deferred.doneUnsafe(exited, Effect.succeed(exitDetails()));
				// Drain final output, but do not wait forever for inherited pipe FDs.
				drainTimer = setTimeout(closePipes, 2000);
			});
			child.once("close", (exitCode, exitSignal) => {
				hasExited = true;
				code = exitCode;
				signal = exitSignal;
				const details = exitDetails();
				Deferred.doneUnsafe(exited, Effect.succeed(details));
				finishMessages();
			});
			child.on("error", (cause) =>
				fail(new AppServerIoError({ operation: "child process", cause })),
			);
			const send: AppServerTransport["send"] = (message) =>
				writes.withPermits(1)(
					Effect.gen(function* () {
						if (
							hasExited ||
							closing ||
							child.stdin.destroyed ||
							child.stdin.writableEnded
						)
							return yield* Effect.fail(new AppServerExited(exitDetails()));
						const line = yield* Effect.try({
							try: () => {
								const json = JSON.stringify(message);
								if (json === undefined)
									throw new TypeError("Not a JSON message");
								return `${json}\n`;
							},
							catch: (cause) =>
								new AppServerIoError({ operation: "encode message", cause }),
						});
						return yield* Effect.callback<void, AppServerTransportError>(
							(resume) => {
								if (
									hasExited ||
									closing ||
									child.stdin.destroyed ||
									child.stdin.writableEnded
								) {
									resume(Effect.fail(new AppServerExited(exitDetails())));
									return;
								}
								if (fatal) {
									resume(Effect.fail(fatal));
									return;
								}
								let done = false;
								let flushed = false;
								let drained = false;
								let backpressured = true;
								const cleanup = () => {
									child.stdin.off("error", onError);
									child.stdin.off("drain", onDrain);
									child.off("exit", onExit);
									child.off("close", onExit);
								};
								const finish = (
									effect: Effect.Effect<void, AppServerTransportError>,
								) => {
									if (done) return;
									done = true;
									cleanup();
									resume(effect);
								};
								const onError = (cause: NodeJS.ErrnoException) =>
									finish(
										Effect.fail(
											cause.code === "EPIPE" || hasExited
												? new AppServerExited(exitDetails())
												: new AppServerIoError({
														operation: "write stdin",
														cause,
													}),
										),
									);
								const complete = () => {
									if (flushed && (!backpressured || drained))
										finish(Effect.void);
								};
								const onDrain = () => {
									drained = true;
									complete();
								};
								const onExit = () =>
									finish(Effect.fail(new AppServerExited(exitDetails())));
								child.stdin.once("error", onError);
								child.stdin.once("drain", onDrain);
								child.once("exit", onExit);
								child.once("close", onExit);
								try {
									backpressured = !child.stdin.write(line, (error) => {
										if (error) onError(error);
										else {
											flushed = true;
											complete();
										}
									});
									complete();
								} catch (cause) {
									onError(
										cause instanceof Error ? cause : new Error(String(cause)),
									);
								}
								return Effect.sync(cleanup);
							},
						);
					}),
				);
			const close = Effect.uninterruptible(
				Effect.gen(function* () {
					if (closing) return yield* Deferred.await(closed);
					closing = true;
					try {
						child.stdin.end();
					} catch {
						// A broken stdin is already closed.
					}
					if (!hasExited)
						yield* Deferred.await(exited).pipe(
							Effect.timeoutOption("2 seconds"),
						);
					if (!hasExited) {
						kill("SIGTERM");
						yield* Deferred.await(exited).pipe(
							Effect.timeoutOption("2 seconds"),
						);
					}
					if (!hasExited) kill("SIGKILL");
					yield* Deferred.await(exited);
					yield* Deferred.await(pipesClosed);
				}),
			).pipe(Effect.ensuring(Deferred.succeed(closed, undefined)));
			yield* Effect.callback<void, AppServerIoError>((resume) => {
				const onSpawn = () => {
					cleanup();
					resume(Effect.void);
				};
				const onError = (cause: Error) => {
					cleanup();
					resume(
						Effect.fail(new AppServerIoError({ operation: "spawn", cause })),
					);
				};
				const cleanup = () => {
					child.off("spawn", onSpawn);
					child.off("error", onError);
				};
				child.once("spawn", onSpawn);
				child.once("error", onError);
				return Effect.sync(cleanup);
			});
			return {
				send,
				messages: Stream.fromQueue(messages),
				exit: Deferred.await(exited).pipe(Effect.map(exitDetails)),
				close,
			} satisfies AppServerTransport;
		}),
		(transport) => transport.close,
	);
