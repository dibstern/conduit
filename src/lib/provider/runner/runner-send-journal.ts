import { createHash } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Cause, Data, Effect } from "effect";
import { isRecord } from "../../utils.js";
import type { TurnResult } from "../types.js";
import { runnerFailure } from "./runner-protocol.js";
import { discoverRunners, runnerDirectory } from "./runner-registry.js";
import type { SessionFailure } from "./session-runner.js";

interface SendRecord {
	readonly commandId: string;
	readonly attempt: number;
	readonly runnerPid: number;
	readonly startedAt: number;
	readonly nativeResumeFallback: boolean;
	readonly providerRunId?: string;
	readonly completedAt?: number;
	readonly result?: TurnResult;
	readonly failure?: SessionFailure;
}

class RunnerSendCleanupError extends Data.TaggedError(
	"RunnerSendCleanupError",
)<{
	readonly message: string;
}> {}

export function removeRunnerSessionSends(
	workspaceRoot: string,
	configDir: string,
	sessionId: string,
): void {
	if (
		discoverRunners(workspaceRoot, configDir).some(
			(entry) => entry.sessionId === sessionId,
		)
	)
		throw new RunnerSendCleanupError({
			message: "Session runner is still alive",
		});
	rmSync(join(runnerDirectory(workspaceRoot, configDir), "sends", sessionId), {
		recursive: true,
		force: true,
	});
}

/** A retained journal fences a replay even after the owning runner has died. */
export class RunnerSendJournal {
	private readonly directory: string;
	private readonly records = new Map<string, SendRecord>();
	private readonly retained = new Set<string>();
	constructor(
		directory: string,
		private readonly sessionId: string,
		private readonly driverKind: string,
	) {
		this.directory = join(directory, "sends", sessionId);
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		for (const name of readdirSync(this.directory)) {
			if (!name.endsWith(".json")) continue;
			const filename = join(this.directory, name);
			try {
				this.records.set(
					filename,
					JSON.parse(readFileSync(filename, "utf8")) as SendRecord,
				);
			} catch (cause) {
				if (isRecord(cause) && cause["code"] === "ENOENT") continue;
				// A crash between exclusive create and fsync still fences this key.
				// Other commands can proceed, and deletion removes the partial file.
				if (!(cause instanceof SyntaxError)) throw cause;
			}
			this.retained.add(filename);
		}
	}

	private filename(commandId: string, attempt: number, fallback: boolean) {
		const digest = createHash("sha256")
			.update(
				JSON.stringify([
					this.driverKind,
					this.sessionId,
					commandId,
					attempt,
					fallback,
				]),
			)
			.digest("hex");
		return join(this.directory, `${digest}.json`);
	}

	get commands(): readonly Pick<SendRecord, "commandId" | "attempt">[] {
		const commands = new Map<string, number>();
		for (const filename of this.retained) {
			const record = this.records.get(filename);
			if (record)
				commands.set(
					record.commandId,
					Math.max(commands.get(record.commandId) ?? 0, record.attempt),
				);
		}
		return [...commands].map(([commandId, attempt]) => ({
			commandId,
			attempt,
		}));
	}

	/** Only the daemon's terminal outbox receipt makes a disk fence disposable. */
	acknowledge(
		commands: readonly Pick<SendRecord, "commandId" | "attempt">[],
	): readonly SendRecord[] {
		const acknowledged = new Map(
			commands.map(({ commandId, attempt }) => [commandId, attempt]),
		);
		const removed: SendRecord[] = [];
		for (const filename of this.retained) {
			const record = this.records.get(filename);
			if (
				!record ||
				record.attempt > (acknowledged.get(record.commandId) ?? -1)
			)
				continue;
			let latest: SendRecord;
			try {
				// A retiring host may have completed this record after our hello.
				latest = JSON.parse(readFileSync(filename, "utf8")) as SendRecord;
			} catch (cause) {
				if (!isRecord(cause) || cause["code"] !== "ENOENT") throw cause;
				this.retained.delete(filename);
				continue;
			}
			rmSync(filename, { force: true });
			this.retained.delete(filename);
			this.records.set(filename, latest);
			removed.push(latest);
		}
		if (removed.length) this.syncDirectory();
		// Keep the live host's fence just like its completed command Deferreds.
		return removed;
	}

	private syncDirectory() {
		const fd = openSync(this.directory, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}

	private write(filename: string, record: SendRecord) {
		const temporary = `${filename}.${process.pid}.tmp`;
		const fd = openSync(temporary, "w", 0o600);
		try {
			writeFileSync(fd, JSON.stringify(record));
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, filename);
		this.syncDirectory();
		this.records.set(filename, record);
		this.retained.add(filename);
	}

	reportProviderRun(
		commandId: string,
		attempt: number,
		fallback: boolean,
		providerRunId: string,
	) {
		return Effect.try({
			try: () => {
				const filename = this.filename(commandId, attempt, fallback);
				const record = this.records.get(filename);
				if (
					record &&
					this.retained.has(filename) &&
					record.providerRunId !== providerRunId
				)
					this.write(filename, { ...record, providerRunId });
			},
			catch: (cause): SessionFailure => ({
				...runnerFailure("persist provider run", cause),
				retryable: false,
			}),
		});
	}

	execute(
		commandId: string,
		attempt: number,
		fallback: boolean,
		execute: Effect.Effect<TurnResult | undefined, SessionFailure>,
	): Effect.Effect<TurnResult | undefined, SessionFailure> {
		const filename = this.filename(commandId, attempt, fallback);
		const uncertain: SessionFailure = {
			operation: "recover runner send",
			message:
				"The runner stopped after this message may have been sent. Retry the message explicitly.",
			code: "runner_send_uncertain",
			retryable: false,
		};
		const persist = (run: () => void) =>
			Effect.try({
				try: run,
				catch: (cause): SessionFailure => ({
					...runnerFailure("persist runner send", cause),
					retryable: false,
				}),
			});
		return Effect.gen(this, function* () {
			const existing = this.records.get(filename);
			if (!existing && this.retained.has(filename))
				return yield* Effect.fail(uncertain);
			if (existing) {
				if (existing.completedAt && existing.failure)
					return yield* Effect.fail(existing.failure);
				if (existing.completedAt && existing.result) return existing.result;
				return yield* Effect.fail(uncertain);
			}
			if (fallback) {
				const original = this.records.get(
					this.filename(commandId, attempt, false),
				);
				// Only a completed rejection before a provider turn permits fallback.
				if (
					!original?.completedAt ||
					!original.result?.nativeResumeRejected ||
					original.providerRunId
				)
					return yield* Effect.fail(uncertain);
			}
			let record: SendRecord = {
				commandId,
				attempt,
				runnerPid: process.pid,
				startedAt: Date.now(),
				nativeResumeFallback: fallback,
			};
			yield* persist(() => {
				const fd = openSync(filename, "wx", 0o600);
				try {
					writeFileSync(fd, JSON.stringify(record));
					fsyncSync(fd);
				} finally {
					closeSync(fd);
				}
				this.syncDirectory();
				this.records.set(filename, record);
				this.retained.add(filename);
			});
			const exit = yield* Effect.exit(execute);
			yield* persist(() => {
				record = {
					...(this.records.get(filename) ?? record),
					completedAt: Date.now(),
					...(exit._tag === "Success"
						? exit.value
							? { result: exit.value }
							: {}
						: {
								failure: runnerFailure("send-turn", Cause.squash(exit.cause)),
							}),
				};
				this.write(filename, record);
			});
			return yield* exit;
		});
	}
}
