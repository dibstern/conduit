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
import type { SendToken } from "../run-ledger/run-ledger-model.js";
import type { TurnResult } from "../types.js";
import { type RunnerSendAnswer, runnerFailure } from "./runner-protocol.js";
import { discoverRunners, runnerDirectory } from "./runner-registry.js";
import type { SessionFailure } from "./session-runner.js";

/** One record per transmission, keyed by its Send Token (CONTRACT 4.9). */
interface SendRecord {
	readonly token: SendToken;
	readonly runnerPid: number;
	readonly startedAt: number;
	readonly providerRunId?: string;
	readonly completedAt?: number;
	readonly result?: TurnResult;
	readonly failure?: SessionFailure;
	readonly fresh?: true;
}

const sendKey = (driverKind: string, sessionId: string, token: SendToken) =>
	createHash("sha256")
		.update(JSON.stringify([driverKind, sessionId, token]))
		.digest("hex");

const isSendRecordShape = Schema.is(
	Schema.Struct({
		token: Schema.String,
		runnerPid: Schema.Number,
		startedAt: Schema.Number,
		providerRunId: Schema.optionalKey(Schema.String),
		completedAt: Schema.optionalKey(Schema.Number),
		fresh: Schema.optionalKey(Schema.Literal(true)),
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
// The token is opaque, so any string read back names one.
const isSendRecord = (record: unknown): record is SendRecord =>
	isSendRecordShape(record);

export type RunnerSendJournalRead =
	| { readonly _tag: "Absent" }
	| { readonly _tag: "Present"; readonly state: RunnerSendAnswer }
	| { readonly _tag: "Unreadable" };

/**
 * Absence proves non-delivery only after the caller confirms the host exited. An older
 * build's attempt-keyed record of the same command reads Unreadable, never Absent (4.9).
 */
export function readRunnerSendJournal(input: {
	readonly directory: string;
	readonly sessionId: string;
	readonly driverKind: string;
	readonly token: SendToken;
	readonly commandId: string;
}): RunnerSendJournalRead {
	const sends = join(input.directory, "sends", input.sessionId);
	try {
		const record: unknown = JSON.parse(
			readFileSync(
				join(
					sends,
					`${sendKey(input.driverKind, input.sessionId, input.token)}.json`,
				),
				"utf8",
			),
		);
		if (!isSendRecord(record) || record.token !== input.token)
			return { _tag: "Unreadable" };
		return {
			_tag: "Present",
			state: {
				token: record.token,
				...(record.fresh ? { fresh: true as const } : {}),
				...(record.completedAt === undefined
					? { status: "uncertain" as const }
					: {
							status: "finished" as const,
							...(record.result ? { result: record.result } : {}),
							...(record.failure ? { failure: record.failure } : {}),
						}),
			},
		};
	} catch (cause) {
		if (!isRecord(cause) || cause["code"] !== "ENOENT")
			return { _tag: "Unreadable" };
	}
	try {
		for (const name of readdirSync(sends)) {
			if (!name.endsWith(".json")) continue;
			const record: unknown = JSON.parse(
				readFileSync(join(sends, name), "utf8"),
			);
			if (isRecord(record) && record["commandId"] === input.commandId)
				return { _tag: "Unreadable" };
		}
	} catch (cause) {
		if (!isRecord(cause) || cause["code"] !== "ENOENT")
			return { _tag: "Unreadable" };
	}
	return { _tag: "Absent" };
}

/** Read legacy ownership before discovery can revoke a host, without replaying it. */
export function runnerSendCommandsForProcess(
	directory: string,
	sessionId: string,
	driverKind: string,
	pid: number,
): readonly SendToken[] {
	const sends = join(directory, "sends", sessionId);
	let names: string[];
	try {
		names = readdirSync(sends);
	} catch {
		// No verified process identity can be recovered from an unreadable journal.
		return [];
	}
	const tokens: SendToken[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const record: unknown = JSON.parse(
				readFileSync(join(sends, name), "utf8"),
			);
			if (
				isSendRecord(record) &&
				record.runnerPid === pid &&
				name === `${sendKey(driverKind, sessionId, record.token)}.json`
			)
				tokens.push(record.token);
		} catch {
			// A partial/unreadable key supplies no process identity.
		}
	}
	return tokens;
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
				// An older build's attempt-keyed record answers no token. The daemon
				// reads it as Unreadable for its command (4.9); it fences nothing here.
				if (isRecord(record) && !("token" in record) && "commandId" in record)
					continue;
				if (!isSendRecord(record) || filename !== this.filename(record.token))
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

	/** Disk evidence gives the outcome; only a call in this journal gives ownership. */
	get answers(): readonly RunnerSendAnswer[] {
		return [...this.retained].flatMap((filename): RunnerSendAnswer[] => {
			const record = this.records.get(filename);
			if (!record) return [];
			const fresh = record.fresh ? { fresh: true as const } : {};
			return [
				record.completedAt !== undefined
					? {
							token: record.token,
							...fresh,
							status: "finished",
							...(record.result ? { result: record.result } : {}),
							...(record.failure ? { failure: record.failure } : {}),
						}
					: {
							token: record.token,
							...fresh,
							status: this.owningCalls.has(filename) ? "running" : "uncertain",
						},
			];
		});
	}

	private filename(token: SendToken) {
		return join(
			this.directory,
			`${sendKey(this.driverKind, this.sessionId, token)}.json`,
		);
	}

	get tokens(): readonly SendToken[] {
		return [...this.retained].flatMap((filename) => {
			const record = this.records.get(filename);
			return record ? [record.token] : [];
		});
	}

	/** Only the daemon's terminal outbox receipt makes a disk fence disposable. */
	acknowledge(tokens: readonly SendToken[]): readonly SendRecord[] {
		const acknowledged = new Set(tokens);
		const removed: SendRecord[] = [];
		for (const filename of this.retained) {
			const record = this.records.get(filename);
			if (!record || !acknowledged.has(record.token)) continue;
			let latest: SendRecord;
			try {
				// A retiring host may have completed this record after our hello.
				const decoded: unknown = JSON.parse(readFileSync(filename, "utf8"));
				if (!isSendRecord(decoded) || filename !== this.filename(decoded.token))
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

	reportProviderRun(token: SendToken, providerRunId: string) {
		return Effect.try({
			try: () => {
				const filename = this.filename(token);
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

	/** `mode` is the send-turn frame's: a transmission's meaning is fixed when it goes out. */
	execute(
		token: SendToken,
		execute: Effect.Effect<TurnResult | undefined, SessionFailure>,
		mode: "resume" | "fresh" = "resume",
	): Effect.Effect<TurnResult | undefined, SessionFailure> {
		const filename = this.filename(token);
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
				// A fresh fallback is its own transmission (4.8): no marker gates it here.
				let record: SendRecord = {
					token,
					runnerPid: process.pid,
					startedAt: Date.now(),
					...(mode === "fresh" ? { fresh: true as const } : {}),
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
