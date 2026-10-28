import { type ChildProcess, spawn } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { Context, Data, Effect, Fiber, Result } from "effect";
import { createLogger } from "../../../logger.js";
import { ReadRequest } from "./read-request.js";

export interface SubprocessOptions {
	readonly cwd?: string;
	readonly timeoutMs: number;
	readonly key?: string;
	readonly priority?: "interactive" | "background";
	readonly env?: NodeJS.ProcessEnv;
	readonly maxBuffer?: number;
	readonly input?: string;
	readonly onStdout?: (chunk: Buffer) => void;
	readonly captureOutput?: boolean;
	readonly keepStdinOpen?: boolean;
	readonly killProcessGroup?: boolean;
	readonly killSignal?: NodeJS.Signals;
}

export interface SubprocessResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

export class SubprocessError extends Data.TaggedError("SubprocessError")<{
	readonly command: string;
	readonly reason: "spawn" | "timeout" | "output-limit" | "signal" | "closed";
	readonly stdout: string;
	readonly stderr: string;
	readonly code?: string;
	readonly signal?: NodeJS.Signals;
	readonly cause?: unknown;
}> {
	get message(): string {
		return `${this.command}: ${this.reason}${this.stderr ? `: ${this.stderr.trim()}` : ""}`;
	}
}

class ReadRequestSpawnError extends Data.TaggedError("ReadRequestSpawnError")<{
	readonly method: string;
}> {
	get message(): string {
		return `Subprocess requested during read RPC ${this.method}`;
	}
}

export interface SubprocessMetrics {
	readonly spawnCount: number;
	readonly wallTimeMs: number;
	/** Time on the calling thread inside Node's synchronous spawn call. */
	readonly spawnTimeMs: number;
	readonly active: number;
	readonly queued: number;
	readonly maxActive: number;
	readonly commands: Readonly<
		Record<
			string,
			{
				readonly spawnCount: number;
				readonly wallTimeMs: number;
				readonly spawnTimeMs: number;
			}
		>
	>;
}

/** Start events identify reads without retaining command arguments in metrics. */
export interface SubprocessDiagnostic extends SubprocessMetrics {
	readonly spawn?: {
		readonly command: string;
		readonly args: readonly string[];
		readonly cwd: string;
	};
}

/** Compatibility edge for the existing Promise-based git cache. */
export type SubprocessRunner = (
	command: string,
	args: readonly string[],
	options: SubprocessOptions,
	signal?: AbortSignal,
) => Promise<SubprocessResult>;

export interface SubprocessService {
	readonly run: (
		command: string,
		args: readonly string[],
		options: SubprocessOptions,
	) => Effect.Effect<SubprocessResult, SubprocessError>;
	readonly makeRunner: (read?: string) => SubprocessRunner;
	readonly metrics: Effect.Effect<SubprocessMetrics>;
	readonly shutdown: Effect.Effect<void>;
}

/** The default is cached by Effect and shared across independent runtimes. */
export class Subprocess extends Context.Reference<SubprocessService>(
	"Subprocess",
	{
		defaultValue: () => makeSubprocess(),
	},
) {}

/** Background owners can lend existing command services their scheduling priority. */
export class SubprocessPriority extends Context.Reference<
	"interactive" | "background"
>("SubprocessPriority", { defaultValue: () => "interactive" }) {}

/** Capture before the first await: Promise continuations have no current fiber. */
export const makeSubprocessRunner = (): SubprocessRunner => {
	const context = Fiber.getCurrent()?.context ?? Context.empty();
	return Context.get(context, Subprocess).makeRunner(
		Context.get(context, ReadRequest),
	);
};

type Completion = Result.Result<SubprocessResult, SubprocessError>;
type Waiter = (result: Completion) => void;
interface Job {
	readonly command: string;
	readonly args: readonly string[];
	readonly options: SubprocessOptions;
	readonly waiters: Set<Waiter>;
	priority: "interactive" | "background";
	stop?: () => void;
}

const metricsChannel = channel("conduit:subprocess-metrics");
const log = createLogger("subprocess");

// macOS answers EPERM for a group whose members are all zombies; those cannot write.
const groupExited = (error: unknown) => {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ESRCH" || code === "EPERM";
};

/** The caller owns stop(); delivery of a kill signal is not a termination barrier. */
export const spawnOwnedSubprocess = (
	command: string,
	args: readonly string[],
	options: {
		readonly cwd?: string;
		readonly env?: NodeJS.ProcessEnv;
		readonly signal?: AbortSignal;
		readonly killProcessGroup?: boolean;
	},
) => {
	const ownsGroup =
		options.killProcessGroup !== false && process.platform !== "win32";
	const child = spawn(command, args, {
		...options,
		stdio: ["pipe", "pipe", "pipe"],
		detached: ownsGroup,
	});
	let closed = false;
	let groupGone = false;
	let stopping: Promise<void> | undefined;
	const signal = (value: NodeJS.Signals) => {
		if (!child.pid || groupGone || (!ownsGroup && closed)) return;
		try {
			if (ownsGroup) process.kill(-child.pid, value);
			else child.kill(value);
		} catch (error) {
			if (!groupExited(error)) throw error;
			groupGone = true;
		}
	};
	// As in the command owner, descendants must release inherited pipes before close.
	child.once("exit", () => {
		if (ownsGroup) {
			try {
				signal("SIGKILL");
			} catch {
				// stop() will report a failure to observe the group's termination.
			}
		}
	});
	child.once("close", () => {
		closed = true;
	});
	child.on("error", () => {
		// The caller handles spawn errors; close still owns the lifetime barrier.
	});
	child.stdin.on("error", () => {
		// Shutdown may race a final SDK write.
	});
	const stop = () =>
		(stopping ??= (async () => {
			child.stdin.end();
			child.stdout.resume();
			child.stderr.resume();
			if (!closed) signal("SIGTERM");
			const started = Date.now();
			let escalated = false;
			while (true) {
				let groupAlive = false;
				if (ownsGroup && child.pid && !groupGone) {
					try {
						process.kill(-child.pid, 0);
						groupAlive = true;
					} catch (error) {
						if (!groupExited(error)) throw error;
						groupGone = true;
					}
				}
				if (closed && !groupAlive) return;
				const elapsed = Date.now() - started;
				if (!escalated && elapsed >= 250) {
					signal("SIGKILL");
					escalated = true;
				}
				if (elapsed >= 5_250)
					throw new SubprocessError({
						command,
						reason: "timeout",
						stdout: "",
						stderr: `Subprocess ${child.pid} did not terminate after SIGKILL`,
					});
				await new Promise<void>((resolve) => setTimeout(resolve, 10));
			}
		})());
	return { child, stop };
};

export const makeSubprocess = (
	options: { readonly concurrency?: number } = {},
): SubprocessService => {
	const concurrency = options.concurrency ?? 4;
	if (!Number.isInteger(concurrency) || concurrency < 1)
		throw new RangeError("Subprocess concurrency must be a positive integer");
	const queue: Job[] = [];
	const running = new Set<Job>();
	const inFlight = new Map<string, Job>();
	const commands = new Map<
		string,
		{ spawnCount: number; wallTimeMs: number; spawnTimeMs: number }
	>();
	let closed = false;
	let spawnCount = 0;
	let wallTimeMs = 0;
	let spawnTimeMs = 0;
	let maxActive = 0;
	let lastReadWarning = Number.NEGATIVE_INFINITY;
	const snapshot = (): SubprocessMetrics => ({
		spawnCount,
		wallTimeMs,
		spawnTimeMs,
		active: running.size,
		queued: queue.length,
		maxActive,
		commands: Object.fromEntries(
			[...commands].map(([command, value]) => [command, { ...value }]),
		),
	});
	const publish = (spawn?: SubprocessDiagnostic["spawn"]) => {
		if (metricsChannel.hasSubscribers)
			metricsChannel.publish({ ...snapshot(), ...(spawn && { spawn }) });
	};
	const error = (
		job: Job,
		reason: SubprocessError["reason"],
		stdout = "",
		stderr = "",
		cause?: unknown,
		signal?: NodeJS.Signals,
	) =>
		new SubprocessError({
			command: job.command,
			reason,
			stdout,
			stderr,
			...(signal !== undefined && { signal }),
			...(cause !== undefined && { cause }),
			...(typeof cause === "object" &&
				cause !== null &&
				"code" in cause &&
				typeof cause.code === "string" && { code: cause.code }),
		});
	const forget = (job: Job) => {
		if (job.options.key !== undefined && inFlight.get(job.options.key) === job)
			inFlight.delete(job.options.key);
	};
	const start = (job: Job) => {
		running.add(job);
		maxActive = Math.max(maxActive, running.size);
		const metric = commands.get(job.command) ?? {
			spawnCount: 0,
			wallTimeMs: 0,
			spawnTimeMs: 0,
		};
		commands.set(job.command, metric);
		spawnCount++;
		metric.spawnCount++;
		const startedAt = performance.now();
		const ownsGroup =
			job.options.killProcessGroup !== false && process.platform !== "win32";
		let child: ChildProcess | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let failure: SubprocessError["reason"] | undefined;
		let finished = false;
		let groupStopped = false;
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		const killGroup = (signal: NodeJS.Signals = "SIGKILL") => {
			if (groupStopped || !child?.pid) return;
			if (signal === "SIGKILL") groupStopped = true;
			try {
				if (ownsGroup) process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch {
				// The process or its owned group has already exited.
			}
		};
		const finish = (
			exitCode: number | null,
			cause?: unknown,
			signal?: NodeJS.Signals,
		) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			if (ownsGroup) killGroup();
			child?.stdin?.destroy();
			const elapsed = performance.now() - startedAt;
			wallTimeMs += elapsed;
			metric.wallTimeMs += elapsed;
			running.delete(job);
			forget(job);
			const out = Buffer.concat(stdout).toString("utf8");
			const err = Buffer.concat(stderr).toString("utf8");
			const result: Completion =
				failure || cause !== undefined || exitCode === null
					? Result.fail(
							error(
								job,
								failure ?? (cause !== undefined ? "spawn" : "signal"),
								out,
								err,
								cause,
								signal,
							),
						)
					: Result.succeed({ stdout: out, stderr: err, exitCode });
			for (const waiter of job.waiters) waiter(result);
			job.waiters.clear();
			publish();
			pump();
		};
		job.stop = () => {
			failure ??= "closed";
			killGroup();
		};
		const collect = (pipe: "stdout" | "stderr", chunk: Buffer) => {
			if (finished) return;
			if (pipe === "stdout") job.options.onStdout?.(chunk);
			if (job.options.captureOutput === false) return;
			const limit = job.options.maxBuffer ?? 1_048_576;
			const size = pipe === "stdout" ? stdoutBytes : stderrBytes;
			const accepted = chunk.subarray(0, Math.max(0, limit - size));
			if (pipe === "stdout") {
				stdout.push(accepted);
				stdoutBytes += chunk.length;
			} else {
				stderr.push(accepted);
				stderrBytes += chunk.length;
			}
			if (size + chunk.length > limit) {
				failure ??= "output-limit";
				killGroup();
			}
		};
		let spawnFailure: unknown;
		const spawnStartedAt = performance.now();
		try {
			child = spawn(job.command, job.args, {
				...(job.options.cwd !== undefined && { cwd: job.options.cwd }),
				...(job.options.env !== undefined && { env: job.options.env }),
				stdio: ["pipe", "pipe", "pipe"],
				detached: ownsGroup,
			});
		} catch (cause) {
			spawnFailure = cause;
		} finally {
			const elapsed = performance.now() - spawnStartedAt;
			spawnTimeMs += elapsed;
			metric.spawnTimeMs += elapsed;
		}
		publish({
			command: job.command,
			args: [...job.args],
			cwd: job.options.cwd ?? process.cwd(),
		});
		if (!child) {
			finish(null, spawnFailure);
			return;
		}
		child.stdout?.on("data", (chunk: Buffer) => collect("stdout", chunk));
		child.stderr?.on("data", (chunk: Buffer) => collect("stderr", chunk));
		child.once("error", (cause) => {
			spawnFailure = cause;
		});
		// Descendants can keep pipes open after the parent exits. Kill the group
		// before waiting for close, which owns releasing the concurrency slot.
		if (ownsGroup) child.once("exit", () => killGroup());
		child.once("close", (code, signal) =>
			finish(code, spawnFailure, signal ?? undefined),
		);
		child.stdin?.on("error", () => {
			/* A command may exit without reading its input. */
		});
		if (!job.options.keepStdinOpen) child.stdin?.end(job.options.input);
		timer = setTimeout(() => {
			failure ??= "timeout";
			killGroup(job.options.killSignal ?? "SIGTERM");
			timer = setTimeout(() => killGroup(), 250);
			timer.unref();
		}, job.options.timeoutMs);
		timer.unref();
	};
	const pump = () => {
		while (!closed && running.size < concurrency && queue.length > 0) {
			const index = queue.findIndex((job) => job.priority === "interactive");
			const job = queue.splice(index < 0 ? 0 : index, 1)[0];
			if (job) start(job);
		}
	};
	const enqueue = (
		command: string,
		args: readonly string[],
		runOptions: SubprocessOptions,
		waiter: Waiter,
	) => {
		const pending =
			runOptions.key === undefined ? undefined : inFlight.get(runOptions.key);
		const job: Job = pending ?? {
			command,
			args,
			options: runOptions,
			priority: runOptions.priority ?? "interactive",
			waiters: new Set(),
		};
		if (closed) {
			waiter(Result.fail(error(job, "closed")));
			return () => {};
		}
		job.waiters.add(waiter);
		if (runOptions.priority !== "background") job.priority = "interactive";
		if (!pending) {
			if (runOptions.key !== undefined) inFlight.set(runOptions.key, job);
			queue.push(job);
		}
		pump();
		return () => {
			job.waiters.delete(waiter);
			if (job.waiters.size !== 0) return;
			// Remove the key now so a new caller cannot attach to a killed child.
			forget(job);
			const queuedIndex = queue.indexOf(job);
			if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
			else job.stop?.();
		};
	};
	const guardRead = (read: string | undefined) => {
		if (read !== undefined && process.env["CONDUIT_STRICT_READ_SPAWN"] === "1")
			throw new ReadRequestSpawnError({ method: read });
	};
	const warnRead = (read: string | undefined, command: string) => {
		if (read === undefined || performance.now() - lastReadWarning < 60_000)
			return;
		lastReadWarning = performance.now();
		log.warn("Subprocess requested during read RPC", {
			method: read,
			command,
		});
	};
	const shutdown = Effect.promise(async () => {
		closed = true;
		for (const job of queue.splice(0)) {
			forget(job);
			for (const waiter of job.waiters)
				waiter(Result.fail(error(job, "closed")));
			job.waiters.clear();
		}
		await Promise.all(
			[...running].map(
				(job) =>
					new Promise<void>((resolve) => {
						job.waiters.add(() => resolve());
						job.stop?.();
					}),
			),
		);
	});
	return {
		run: (command, args, runOptions) =>
			Effect.gen(function* () {
				const read = yield* ReadRequest;
				const priority = runOptions.priority ?? (yield* SubprocessPriority);
				guardRead(read);
				warnRead(read, command);
				return yield* Effect.callback<SubprocessResult, SubprocessError>(
					(resume) => {
						const cancel = enqueue(
							command,
							args,
							{ ...runOptions, priority },
							(result) =>
								resume(
									Result.isSuccess(result)
										? Effect.succeed(result.success)
										: Effect.fail(result.failure),
								),
						);
						return Effect.sync(cancel);
					},
				);
			}),
		makeRunner: (read) => (command, args, runOptions, signal) =>
			new Promise((resolve, reject) => {
				guardRead(read);
				if (signal?.aborted) {
					reject(signal.reason);
					return;
				}
				warnRead(read, command);
				const cancel = enqueue(command, args, runOptions, (result) => {
					signal?.removeEventListener("abort", abort);
					if (Result.isSuccess(result)) resolve(result.success);
					else reject(result.failure);
				});
				function abort() {
					cancel();
					reject(signal?.reason);
				}
				signal?.addEventListener("abort", abort, { once: true });
			}),
		metrics: Effect.sync(snapshot),
		shutdown,
	};
};
