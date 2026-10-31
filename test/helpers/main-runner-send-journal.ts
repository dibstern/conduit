// Main ecb3840d runner-send-journal.ts, retained-process subset.
// execute, keying, persistence and retained-command semantics are unchanged.
// Loading validates fixture records instead of casting decoded JSON.
import { createHash } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Cause, Effect, Schema } from "effect";
import { runnerFailure } from "../../src/lib/provider/runner/runner-protocol.js";
import type { SessionFailure } from "../../src/lib/provider/runner/session-runner.js";
import type { TurnResult } from "../../src/lib/provider/types.js";

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

export class MainRunnerSendJournal {
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
			const record: unknown = JSON.parse(readFileSync(filename, "utf8"));
			if (
				Schema.is(
					Schema.Struct({
						commandId: Schema.String,
						attempt: Schema.Number,
						runnerPid: Schema.Number,
						startedAt: Schema.Number,
						nativeResumeFallback: Schema.Boolean,
						providerRunId: Schema.optionalKey(Schema.String),
						completedAt: Schema.optionalKey(Schema.Number),
						failure: Schema.optionalKey(
							Schema.Struct({
								operation: Schema.String,
								message: Schema.String,
								code: Schema.optionalKey(
									Schema.Union([Schema.String, Schema.Number]),
								),
								retryable: Schema.optionalKey(Schema.Boolean),
							}),
						),
						result: Schema.optionalKey(
							Schema.Struct({
								status: Schema.Literals([
									"accepted",
									"indeterminate",
									"completed",
									"error",
									"interrupted",
									"cancelled",
									"joined",
									"steer-declined",
								]),
								cost: Schema.Number,
								tokens: Schema.Struct({
									input: Schema.Number,
									output: Schema.Number,
								}),
								durationMs: Schema.Number,
								providerStateUpdates: Schema.Array(
									Schema.Struct({ key: Schema.String, value: Schema.Unknown }),
								),
							}),
						),
					}),
				)(record)
			)
				this.records.set(filename, record);
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
		return Effect.gen({ self: this }, function* () {
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
