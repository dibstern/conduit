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
import { Data, Effect, Schema } from "effect";
import { SessionHandoffDeliveredPayloadSchema } from "../../contracts/stored-event.js";
import * as Failure from "../../effect/failure-classification.js";
import { isRecord } from "../../utils.js";
import type { TurnResult } from "../types.js";
import { type RunnerSendAnswer, runnerFailure } from "./runner-protocol.js";
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

const sendKey = (
	driverKind: string,
	sessionId: string,
	commandId: string,
	attempt: number,
	fallback: boolean,
) =>
	createHash("sha256")
		.update(
			JSON.stringify([driverKind, sessionId, commandId, attempt, fallback]),
		)
		.digest("hex");

const isSendRecord = Schema.is(
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
				name: Schema.optionalKey(Schema.String),
				code: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
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
					cacheRead: Schema.optionalKey(Schema.Number),
					cacheWrite: Schema.optionalKey(Schema.Number),
					reasoning: Schema.optionalKey(Schema.Number),
					contextWindow: Schema.optionalKey(Schema.Number),
				}),
				durationMs: Schema.Number,
				error: Schema.optionalKey(
					Schema.Struct({
						code: Schema.String,
						message: Schema.String,
						retryable: Schema.optionalKey(Schema.Boolean),
						retryHandled: Schema.optionalKey(Schema.Boolean),
					}),
				),
				nativeResumeRejected: Schema.optionalKey(Schema.Boolean),
				providerStateUpdates: Schema.Array(
					Schema.Struct({ key: Schema.String, value: Schema.Unknown }),
				),
				handoff: Schema.optionalKey(SessionHandoffDeliveredPayloadSchema),
			}),
		),
	}),
);

/** Read legacy ownership before discovery can revoke a host, without replaying it. */
export function runnerSendCommandsForProcess(
	directory: string,
	sessionId: string,
	driverKind: string,
	pid: number,
): readonly Pick<SendRecord, "commandId" | "attempt">[] {
	const sends = join(directory, "sends", sessionId);
	let names: string[];
	try {
		names = readdirSync(sends);
	} catch {
		// No verified process identity can be recovered from an unreadable journal.
		return [];
	}
	const commands: Pick<SendRecord, "commandId" | "attempt">[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const record: unknown = JSON.parse(
				readFileSync(join(sends, name), "utf8"),
			);
			if (
				isSendRecord(record) &&
				record.runnerPid === pid &&
				name ===
					`${sendKey(driverKind, sessionId, record.commandId, record.attempt, record.nativeResumeFallback)}.json`
			)
				commands.push({ commandId: record.commandId, attempt: record.attempt });
		} catch {
			// A partial/unreadable key supplies no process identity.
		}
	}
	return commands;
}

class RunnerSendCleanupError extends Data.TaggedError(
	"RunnerSendCleanupError",
)<{
	readonly message: string;
}> {}

class RunnerSendJournalReadError extends Data.TaggedError(
	"RunnerSendJournalReadError",
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
	private readonly owningCalls = new Set<string>();
	constructor(
		directory: string,
		private readonly sessionId: string,
		private readonly driverKind: string,
		options: { readonly allowOpaqueFences?: true } = {},
	) {
		this.directory = join(directory, "sends", sessionId);
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		for (const name of readdirSync(this.directory)) {
			if (!name.endsWith(".json")) continue;
			const filename = join(this.directory, name);
			try {
				const record: unknown = JSON.parse(readFileSync(filename, "utf8"));
				if (
					!isSendRecord(record) ||
					filename !==
						this.filename(
							record.commandId,
							record.attempt,
							record.nativeResumeFallback,
						)
				)
					throw new RunnerSendJournalReadError({
						message: "Retained runner send record is invalid",
					});
				this.records.set(filename, record);
			} catch (cause) {
				if (isRecord(cause) && cause["code"] === "ENOENT") continue;
				// An unreadable key remains an opaque fence, as it does on main.
				if (
					!options.allowOpaqueFences ||
					(!(cause instanceof SyntaxError) &&
						!(cause instanceof RunnerSendJournalReadError))
				)
					throw new RunnerSendJournalReadError({
						message: runnerFailure("read retained runner send", cause).message,
					});
			}
			this.retained.add(filename);
		}
	}

	/** Opaque fences can answer only a same-key command, never a complete snapshot. */
	get canAnswerRetainedSends(): boolean {
		return [...this.retained].every((filename) => this.records.has(filename));
	}

	/** Disk evidence gives the outcome; only a call in this journal gives ownership. */
	get answers(): readonly RunnerSendAnswer[] {
		const answers = new Map<string, RunnerSendAnswer>();
		for (const filename of this.retained) {
			const record = this.records.get(filename);
			if (!record) continue;
			const key = {
				commandId: record.commandId,
				attempt: record.attempt,
				nativeResumeFallback: record.nativeResumeFallback,
			};
			const identity = JSON.stringify([record.commandId, record.attempt]);
			// The fallback supersedes its primary within the same outbox attempt.
			if (
				answers.get(identity)?.nativeResumeFallback &&
				!record.nativeResumeFallback
			)
				continue;
			answers.set(
				identity,
				record.completedAt !== undefined
					? {
							...key,
							status: "finished",
							...(record.result ? { result: record.result } : {}),
							...(record.failure ? { failure: record.failure } : {}),
						}
					: {
							...key,
							status: this.owningCalls.has(filename) ? "running" : "uncertain",
						},
			);
		}
		return [...answers.values()];
	}

	private filename(commandId: string, attempt: number, fallback: boolean) {
		const digest = sendKey(
			this.driverKind,
			this.sessionId,
			commandId,
			attempt,
			fallback,
		);
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
				const decoded: unknown = JSON.parse(readFileSync(filename, "utf8"));
				if (
					!isSendRecord(decoded) ||
					filename !==
						this.filename(
							decoded.commandId,
							decoded.attempt,
							decoded.nativeResumeFallback,
						)
				)
					throw new RunnerSendCleanupError({
						message: "Retained send record is invalid",
					});
				latest = decoded;
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
		return Effect.suspend(() => {
			let ownsCall = false;
			return Effect.gen({ self: this }, function* () {
				const existing = this.records.get(filename);
				if (!existing && this.retained.has(filename))
					return yield* Effect.fail(uncertain);
				if (existing) {
					if (existing.completedAt !== undefined && existing.failure)
						return yield* Effect.fail(existing.failure);
					if (existing.completedAt !== undefined) return existing.result;
					return yield* Effect.fail(uncertain);
				}
				if (fallback) {
					let original: SendRecord | undefined;
					// Requeue can skip unsent attempts. The latest recorded send alone
					// decides whether this fallback is allowed; a partial file is a fence.
					for (let previous = attempt; previous >= 0; previous--) {
						if (this.retained.has(this.filename(commandId, previous, true)))
							break;
						const primary = this.filename(commandId, previous, false);
						if (!this.retained.has(primary)) continue;
						original = this.records.get(primary);
						break;
					}
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
					// Exclusive create owns this fence even when the initial write fails.
					this.retained.add(filename);
					this.records.set(filename, record);
					try {
						writeFileSync(fd, JSON.stringify(record));
						fsyncSync(fd);
					} finally {
						closeSync(fd);
					}
					this.syncDirectory();
					this.owningCalls.add(filename);
					ownsCall = true;
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
									failure: runnerFailure(
										"send-turn",
										Failure.squashCause(exit.cause),
									),
								}),
					};
					this.write(filename, record);
				});
				return yield* exit;
			}).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						if (ownsCall) this.owningCalls.delete(filename);
					}),
				),
			);
		});
	}
}
