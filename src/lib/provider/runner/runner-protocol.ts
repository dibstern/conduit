import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { createInterface } from "node:readline";
import { Deferred, Effect } from "effect";
import { BUILD_ID } from "../../build-id.js";
import { attachmentFromDataUrl } from "../../persistence/attachment-store.js";
import { isRecord } from "../../utils.js";
import type { CursorBackendUrl } from "../cursor/cursor-credential.js";
import type { SendToken } from "../run-ledger/run-ledger-model.js";
import type { ProviderControlCommandStatus, TurnResult } from "../types.js";
import type { ProcessMember } from "./process-table.js";
import type { RunnerUpgradeState } from "./runner-upgrade.js";
import type {
	SessionCommand,
	SessionFailure,
	SessionOutput,
	SessionOutputReply,
	SessionTurn,
} from "./session-runner.js";

export interface ThreadReadInput {
	readonly cursor?: string | undefined;
	readonly textOffset?: number | undefined;
	readonly limit?: number | undefined;
}
export type ThreadReadResult =
	| {
			readonly items: readonly {
				readonly id: string;
				readonly role: string;
				readonly text: string;
				readonly textOffset: number;
				readonly interrupted: boolean;
			}[];
			readonly nextCursor?: string;
			readonly nextTextOffset?: number;
	  }
	| { readonly code: string; readonly message: string };

/** 8.7 Declared from a Codex tool call: its thread id is the marker a scan reads as CODEX_THREAD_ID. */
export interface ServerMarkInput {
	readonly port: number;
	readonly role: "serving" | "awaited";
}
/** Recorded, or refused with the reason the agent reads. */
export type ServerMarkResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string };

export interface RunnerWireCodec {
	readonly decode: (message: RunnerMessage) => RunnerMessage;
	readonly encode: (
		message: RunnerWireMessage,
		taggedConfigDir: boolean,
	) => string;
}

/**
 * 6: the host stamps `querySeq` on every frame and its hello (CONTRACT 6.1, 9), and keys
 * every send by its Send Token (4.9, 4.11).
 */
export const RUNNER_PROTOCOL_VERSION = 6;

export const runnerBuildId = (): string =>
	process.env["NODE_ENV"] === "test"
		? (process.env["CONDUIT_TEST_BUILD_ID"] ?? BUILD_ID)
		: BUILD_ID;

/** Cleanup from an old attempt must never release a newer attempt's sink. */
export const runnerSinkId = (
	commandId: string,
	attempt = 0,
	nativeResumeFallback = false,
): string =>
	`${commandId}:${attempt}${nativeResumeFallback ? ":native-resume-fallback" : ""}`;

/**
 * The one Send Token composer (CONTRACT 3.4, 4.11): a hold's `run.dispatched` names
 * a "hold" transmission, an outbox claim with no hold a "tx" one. Write-only, never parsed.
 */
export const sendToken = (
	minter: "hold" | "tx",
	commandId: string,
	transmission: number,
) => `${minter}:${commandId}:${transmission}` as SendToken;

/** A row's current transmission: its hold's, else its outbox claim's. */
export const currentSendToken = (row: {
	readonly command_id: string;
	readonly attempt_count: number;
	readonly held_transmission: number | null;
}) =>
	row.held_transmission === null
		? sendToken("tx", row.command_id, row.attempt_count)
		: sendToken("hold", row.command_id, row.held_transmission);

export type RunnerSendAnswer = {
	readonly token: SendToken;
	/** The transmission went out as a fresh fallback (4.8): its rejection is terminal. */
	readonly fresh?: true;
} & (
	| { readonly status: "running" }
	| { readonly status: "uncertain" }
	| {
			readonly status: "finished";
			readonly result?: TurnResult;
			readonly failure?: SessionFailure;
	  }
);

export interface RunnerHello {
	readonly reaper?: typeof ProcessMember.Encoded;
	readonly type: "hello";
	readonly driverKind?: string;
	readonly protocolVersion: number;
	readonly buildId: string;
	readonly runnerId?: string;
	readonly sessionId?: string;
	readonly pid?: number;
	readonly acknowledgedSequence?: number;
	readonly upgradeState?: RunnerUpgradeState;
	// Runners that predate stop-task acknowledge it without stopping anything,
	// and they also speak this protocol version, so the daemon needs the flag.
	readonly stopsTasks?: true;
	/** Every event produced by a send carries its conduit run identity. */
	readonly stampsRunIds?: true;
	/** The session controller survives an idle account/query rebind. */
	readonly rebindsAccount?: true;
	/** Resolving an interaction also settles its native answer waiter. */
	readonly settlesAnswers?: true;
	/** Login identity compares declared settings, never captured shell values. */
	readonly declaresLogin?: true;
	/** Cursor sends consume the daemon's admitted account credential envelope. */
	readonly scopedCursorCredentials?: true;
	/** A new hello cannot overtake unread commands from the previous socket. */
	readonly drainsConnections?: true;
	readonly sendAnswers?: readonly RunnerSendAnswer[];
	readonly cursorBackendUrl?: CursorBackendUrl;
	readonly taggedConfigDir?: true;
	/** Sends carry attachment refs beside their bytes; older runners take data URL strings. */
	readonly attachmentRefs?: true;
	readonly bindings?: readonly {
		readonly sinkId: string;
		readonly sessionId: string;
		readonly token?: SendToken;
		/** Absent on older runners; the daemon falls back to its turn records. */
		readonly released?: boolean;
	}[];
	readonly pendingOutputs?: readonly {
		readonly sequence: number;
		readonly output: SessionOutput;
	}[];
	readonly sendTokens?: readonly SendToken[];
	readonly config?: {
		readonly workspaceRoot: string;
		readonly extraFolders?: readonly string[];
		readonly daemonConfigDir?: string;
		/** Null records an unavailable daemon default; absent is legacy compatibility. */
		readonly claudeLaunchConfig?:
			| import("../claude/claude-sdk-env.js").ClaudeLaunchConfig
			| null;
		readonly autoSettleAfterDays?: number | null | undefined;
		readonly subagentPollTimeoutMs?: number;
	};
}

type RunnerReply =
	| {
			readonly type: "command-status-reply";
			readonly requestId: string;
			readonly result: Exclude<ProviderControlCommandStatus, "gone">;
			readonly failure?: SessionFailure;
	  }
	| {
			readonly type: "thread-read-reply";
			readonly requestId: string;
			readonly result: ThreadReadResult;
			readonly failure?: SessionFailure;
	  }
	| {
			readonly type: "server-mark-reply";
			readonly requestId: string;
			readonly result: ServerMarkResult;
			readonly failure?: SessionFailure;
	  }
	| {
			readonly type: "upgrade-reply";
			readonly requestId: string;
			readonly result: boolean;
			readonly failure?: SessionFailure;
	  }
	| {
			readonly type: "command-reply";
			readonly commandId: string;
			readonly result?: TurnResult;
			readonly failure?: SessionFailure;
	  }
	| {
			readonly type: "output-reply";
			readonly outputId: string;
			readonly sequence?: number | undefined;
			readonly result?: SessionOutputReply;
			readonly failure?: SessionFailure;
	  };

/**
 * querySeq: the host's count of query replacements (CONTRACT 6.1), stamped on every
 * frame it writes. Daemon frames carry none.
 */
export type RunnerMessage = { readonly querySeq?: number } & (
	| RunnerHello
	| {
			readonly type: "command-refused";
			readonly commandId: string;
			readonly reason: "exiting" | "retiring" | "interrupted";
	  }
	| {
			readonly type: "command-status";
			readonly requestId: string;
			readonly commandId: string;
	  }
	| {
			readonly type: "thread-read";
			readonly requestId: string;
			readonly input: ThreadReadInput;
	  }
	| {
			readonly type: "server-mark";
			readonly requestId: string;
			readonly input: ServerMarkInput;
	  }
	| { readonly type: "upgrade-state"; readonly state: RunnerUpgradeState }
	| {
			readonly type: "upgrade-retire";
			readonly requestId: string;
			readonly revision: number;
	  }
	| { readonly type: "upgrade-cancel" | "upgrade-activate" }
	| { readonly type: "idle-exit" | "idle-exit-ack" }
	| {
			readonly type: "settled-commands" | "settled-commands-ack";
			readonly tokens: readonly SendToken[];
	  }
	| {
			readonly type: "command-accepted";
			readonly commandId: string;
			readonly sinkId: string;
	  }
	| { readonly type: "refused"; readonly failure: SessionFailure }
	| RunnerReply
	| {
			readonly type: "command";
			/** The frame id; a send's is its Send Token. */
			readonly commandId: string;
			readonly command: SessionCommand;
	  }
	| {
			readonly type: "output";
			readonly outputId: string;
			readonly sequence?: number;
			readonly output: SessionOutput;
	  }
	| {
			readonly type: "replay";
			/** Legacy peers may send it; current runners ignore it. */
			readonly preserveRole?: boolean;
			readonly acknowledgedSequence: number;
	  }
);

/** Only the outbound wire accepts the pre-attachment-ref send shape. */
export type RunnerWireMessage =
	| Exclude<RunnerMessage, { type: "command" }>
	| (Omit<Extract<RunnerMessage, { type: "command" }>, "command"> & {
			readonly command:
				| Exclude<SessionCommand, { type: "send-turn" }>
				| (Omit<Extract<SessionCommand, { type: "send-turn" }>, "input"> & {
						readonly input: Omit<SessionTurn, "images"> & {
							readonly images?: SessionTurn["images"] | readonly string[];
						};
				  });
	  });

// Compatibility for runners started before attachment refs. Remove once none can still be alive.
function legacyAttachmentInput<T extends object>(
	input: T & { readonly images?: SessionTurn["images"] },
): Omit<T, "images"> & { readonly images?: readonly string[] } {
	const { images, ...launch } = input;
	return {
		...launch,
		...(images ? { images: images.map(({ dataUrl }) => dataUrl) } : {}),
	};
}

function hasLegacyImages(
	input: object,
): input is { readonly images: readonly string[] } {
	return (
		"images" in input &&
		Array.isArray(input.images) &&
		input.images.every((image: unknown) => typeof image === "string")
	);
}

function normalizeLegacyOutput(output: SessionOutput): SessionOutput {
	if (output.type !== "place-user-message" || !hasLegacyImages(output.input))
		return output;
	const images: readonly string[] = output.input.images;
	return {
		...output,
		input: {
			...output.input,
			images: images.map((image) => attachmentFromDataUrl(image).ref),
		},
	};
}

function normalizeLegacyUpgradeState(
	state: RunnerUpgradeState,
): RunnerUpgradeState {
	if (!state.snapshot || !hasLegacyImages(state.snapshot.input)) return state;
	const input = {
		...state.snapshot.input,
		images: state.snapshot.input.images.map((dataUrl) => ({
			ref: attachmentFromDataUrl(dataUrl).ref,
			dataUrl,
		})),
	};
	return {
		...state,
		snapshot: {
			...state.snapshot,
			input,
		},
	};
}

export function runnerHelloFailure(
	hello: RunnerHello,
	peer: "server" | "runner",
	expectedDriverKind?: string,
	expectedCursorBackendUrl?: CursorBackendUrl,
): SessionFailure | undefined {
	if (hello.protocolVersion !== RUNNER_PROTOCOL_VERSION)
		return {
			...runnerFailure(
				"runner hello",
				`Runner protocol mismatch: ${peer} speaks version ${hello.protocolVersion}, expected ${RUNNER_PROTOCOL_VERSION} (peer build ${hello.buildId}, local build ${BUILD_ID})`,
			),
			...(peer === "runner" ? { code: "runner_incompatible" } : {}),
		};
	if (peer === "runner" && hello.stampsRunIds !== true)
		return {
			...runnerFailure(
				"runner hello",
				`Runner predates run ownership (peer build ${hello.buildId}, local build ${BUILD_ID})`,
			),
			code: "runner_incompatible",
		};
	// Runner builds predating driverKind were all Claude.
	if (
		peer === "runner" &&
		expectedCursorBackendUrl !== undefined &&
		hello.cursorBackendUrl !== expectedCursorBackendUrl
	)
		return {
			...runnerFailure(
				"runner hello",
				`Cursor runner backend mismatch: runner uses ${hello.cursorBackendUrl ?? "an unreported backend"}, expected ${expectedCursorBackendUrl}`,
			),
			code: "runner_incompatible",
		};
	if (
		expectedDriverKind !== undefined &&
		(hello.driverKind ?? "claude") !== expectedDriverKind
	)
		return {
			...runnerFailure(
				"runner hello",
				`Runner driver mismatch: ${peer} speaks ${hello.driverKind ?? "claude"}, expected ${expectedDriverKind}`,
			),
			code: "runner_incompatible",
		};
	return undefined;
}

export function runnerFailure(
	operation: string,
	cause: unknown,
): SessionFailure {
	return {
		operation:
			isRecord(cause) && typeof cause["operation"] === "string"
				? cause["operation"]
				: operation,
		message:
			isRecord(cause) && typeof cause["message"] === "string"
				? cause["message"]
				: String(cause),
		...(isRecord(cause) && typeof cause["name"] === "string"
			? { name: cause["name"] }
			: {}),
		...(isRecord(cause) &&
		(typeof cause["code"] === "string" || typeof cause["code"] === "number")
			? { code: cause["code"] }
			: {}),
		...(isRecord(cause) && typeof cause["retryable"] === "boolean"
			? { retryable: cause["retryable"] }
			: {}),
	};
}

export const runnerIdleFailure = (): SessionFailure => ({
	operation: "runner admission",
	message: "Runner is exiting after inactivity",
	code: "runner_idle_exit",
	retryable: true,
});

export type RunnerRefusalReason = "exiting" | "retiring" | "interrupted";

export type RunnerDeliveryEvidence =
	| { readonly _tag: "Refused"; readonly reason: RunnerRefusalReason }
	| { readonly _tag: "NotSent" };

/** The write gate, read with the frame's refusal reader in the write's synchronous step (4.4). */
export type RunnerWriteGate = (
	refusal: () => RunnerRefusalReason | undefined,
) => boolean;

/** The gate refused the write; it carries no delivery evidence (4.4). */
export const RUNNER_WRITE_GATE_CLOSED = "runner_write_gate_closed";

interface PendingReply {
	reply: (reply: RunnerReply) => void;
	accepted: boolean;
	/** The host's refusal of this frame, read before its reply resolves. */
	refused?: RunnerRefusalReason;
}

export interface RunnerCommandFailure extends SessionFailure {
	readonly delivery?: RunnerDeliveryEvidence;
	/** A real host reply, independent of whether it proves non-delivery. */
	readonly replied?: true;
}

export const runnerCommandReplied = (failure: SessionFailure): boolean =>
	"replied" in failure && failure.replied === true;

export function runnerDeliveryEvidence(
	failure: SessionFailure,
): RunnerDeliveryEvidence | undefined {
	if (!("delivery" in failure) || !isRecord(failure.delivery)) return undefined;
	const evidence = failure.delivery;
	if (evidence["_tag"] === "NotSent") return { _tag: "NotSent" };
	const reason = evidence["reason"];
	if (
		evidence["_tag"] === "Refused" &&
		(reason === "exiting" || reason === "retiring" || reason === "interrupted")
	)
		return { _tag: "Refused", reason };
	return undefined;
}

/** Bidirectional NDJSON, including replies for server-owned output operations. */
export class RunnerSocket {
	private readonly pending = new Map<string, PendingReply>();
	private failure: SessionFailure | undefined;
	/**
	 * The connection's first idle-exit or `retiring` refusal (4.6 host fact):
	 * a frame still pending and unaccepted when it was read is never accepted.
	 */
	private exitRead: "exiting" | "retiring" | undefined;
	private peerTaggedConfigDir = false;
	private peerAttachmentRefs = false;
	private peerSettlesAnswers = false;
	scopedCursorCredentials = false;
	/** The host's stamp; a frame stamped at production keeps its own (CONTRACT 6.1). */
	querySeq: (() => number) | undefined;
	private peerDriverKind: string | undefined;
	private helloSends: readonly SendToken[] | undefined;
	private readonly completedCommands = new Map<
		string,
		"completed" | "failed"
	>();
	private readonly readEnded = Deferred.makeUnsafe<void>();
	/** Resolves after the old NDJSON reader can produce no further frames. */
	readonly readToEndEffect = Deferred.await(this.readEnded);
	/** The daemon serializes command delivery with its serving-slot commit. */
	commandDispatch?:
		| ((
				write: Effect.Effect<void, SessionFailure>,
				message: RunnerMessage,
		  ) => Effect.Effect<void, SessionFailure>)
		| undefined;

	/** The original hello journal, unaffected by acknowledgements or new sends. */
	get retainedSends(): readonly SendToken[] | undefined {
		return this.helloSends;
	}

	constructor(
		private readonly socket: Socket,
		onMessage: (message: RunnerMessage) => void,
		onClose: (failure: SessionFailure) => void,
		private readonly beforeCommandFailure?: () => Effect.Effect<void>,
		private readonly wire?: RunnerWireCodec,
	) {
		const lines = createInterface({ input: socket, crlfDelay: Infinity });
		lines.on("line", (line) => {
			try {
				const decoded = JSON.parse(line) as RunnerMessage;
				let message = this.wire?.decode(decoded) ?? decoded;
				if (message.type === "command-refused") {
					const failure: RunnerCommandFailure = {
						operation: "runner admission",
						message: `Runner refused the command: ${message.reason}`,
						code: "runner_command_refused",
						delivery: { _tag: "Refused", reason: message.reason },
					};
					if (message.reason === "retiring") this.exitRead ??= "retiring";
					message = { ...message, type: "command-reply", failure };
				}
				if (message.type === "command-reply" && message.failure) {
					const failure: RunnerCommandFailure = {
						...message.failure,
						replied: true,
					};
					message = { ...message, failure };
				}
				if (message.type === "hello") {
					this.peerTaggedConfigDir = message.taggedConfigDir === true;
					this.peerAttachmentRefs = message.attachmentRefs === true;
					this.peerSettlesAnswers = message.settlesAnswers === true;
					this.scopedCursorCredentials =
						message.scopedCursorCredentials === true;
					this.peerDriverKind = message.driverKind;
					this.helloSends = (message.sendAnswers ?? []).map(
						(answer) => answer.token,
					);
				}
				if (!this.peerAttachmentRefs) {
					if (message.type === "output")
						message = {
							...message,
							output: normalizeLegacyOutput(message.output),
						};
					else if (message.type === "upgrade-state")
						message = {
							...message,
							state: normalizeLegacyUpgradeState(message.state),
						};
					else if (message.type === "hello")
						message = {
							...message,
							...(message.upgradeState
								? {
										upgradeState: normalizeLegacyUpgradeState(
											message.upgradeState,
										),
									}
								: {}),
							...(message.pendingOutputs
								? {
										pendingOutputs: message.pendingOutputs.map((pending) => ({
											...pending,
											output: normalizeLegacyOutput(pending.output),
										})),
									}
								: {}),
						};
				}
				if (
					message.type === "command-reply" &&
					!this.peerSettlesAnswers &&
					message.commandId.endsWith(":answer")
				)
					this.completedCommands.set(
						message.commandId,
						message.failure ? "failed" : "completed",
					);
				if (message.type === "idle-exit") this.exitRead ??= "exiting";
				if (message.type === "command-accepted") {
					const pending = this.pending.get(`command:${message.commandId}`);
					if (pending) pending.accepted = true;
				}
				if (
					message.type === "command-reply" ||
					message.type === "output-reply" ||
					message.type === "upgrade-reply" ||
					message.type === "command-status-reply" ||
					message.type === "thread-read-reply" ||
					message.type === "server-mark-reply"
				) {
					const key =
						message.type === "command-status-reply"
							? `command-status:${message.requestId}`
							: message.type === "thread-read-reply"
								? `thread-read:${message.requestId}`
								: message.type === "server-mark-reply"
									? `server-mark:${message.requestId}`
									: message.type === "upgrade-reply"
										? `upgrade:${message.requestId}`
										: message.type === "command-reply"
											? `command:${message.commandId}`
											: `output:${message.outputId}`;
					const reply = this.pending.get(key);
					if (reply) {
						const refusal =
							message.type === "command-reply" && message.failure
								? runnerDeliveryEvidence(message.failure)
								: undefined;
						if (refusal?._tag === "Refused") reply.refused = refusal.reason;
						reply.reply(message);
					} else onMessage(message);
				} else onMessage(message);
			} catch (cause) {
				socket.destroy(
					new Error(runnerFailure("decode runner frame", cause).message),
				);
			}
		});
		const fail = (cause: unknown) => {
			if (this.failure) return;
			this.failure = runnerFailure("runner socket", cause);
			for (const pending of this.pending.values())
				pending.reply({
					type: "command-reply",
					commandId: "",
					failure: this.failure,
				});
			this.pending.clear();
			onClose(this.failure);
		};
		lines.on("error", fail);
		socket.on("error", fail);
		socket.on("close", () => {
			lines.close();
			fail(new Error("Runner socket closed"));
			// The reader and disconnect bookkeeping finish before a successor
			// connection can answer status from this host's command journal.
			Deferred.doneUnsafe(this.readEnded, Effect.void);
		});
	}

	write(message: RunnerMessage): void {
		if (this.socket.destroyed) return;
		let frame: RunnerWireMessage =
			this.querySeq && message.querySeq === undefined
				? { ...message, querySeq: this.querySeq() }
				: message;
		if (!this.peerAttachmentRefs && message.type === "command") {
			const command = message.command;
			if (command.type === "send-turn")
				frame = {
					...message,
					command: { ...command, input: legacyAttachmentInput(command.input) },
				};
			else if (command.type === "pre-warm")
				frame = {
					...message,
					command: {
						...command,
						input: legacyAttachmentInput(command.input),
						...(command.settingsSnapshot
							? {
									settingsSnapshot: {
										...command.settingsSnapshot,
										input: legacyAttachmentInput(
											command.settingsSnapshot.input,
										),
									},
								}
							: {}),
					},
				};
		}
		this.socket.write(
			this.wire?.encode(frame, this.peerTaggedConfigDir) ??
				`${JSON.stringify(frame)}\n`,
		);
	}

	get closed(): boolean {
		return this.failure !== undefined || this.socket.destroyed;
	}

	retireEffect(revision: number): Effect.Effect<boolean, SessionFailure> {
		const requestId = randomUUID();
		return this.requestEffect(`upgrade:${requestId}`, {
			type: "upgrade-retire",
			requestId,
			revision,
		});
	}

	/** A send's `commandId` is its Send Token, unique per transmission (4.11). */
	commandEffect(
		commandId: string,
		command: SessionCommand,
		canWrite?: RunnerWriteGate,
	): Effect.Effect<TurnResult | undefined, RunnerCommandFailure> {
		if (command.type === "send-turn")
			command = {
				...command,
				...(command.input.runId ? { runId: command.input.runId } : {}),
				mode: command.input.nativeResumeFallback ? "fresh" : "resume",
			};
		if (
			this.peerDriverKind === "cursor" &&
			!this.scopedCursorCredentials &&
			(command.type === "pre-warm" ||
				(command.type === "send-turn" &&
					!this.retainedSends?.some((token) => token === commandId)))
		)
			return Effect.fail({
				...runnerFailure(
					command.type,
					"Cursor runner predates scoped credentials",
				),
				code: "runner_incompatible",
			});
		if (
			this.peerDriverKind === "cursor" &&
			(command.type === "send-turn" || command.type === "pre-warm")
		) {
			const inputEnvironment = {
				shellEnv: {},
				...(command.input.account
					? { account: { ...command.input.account, env: {} } }
					: {}),
			};
			command =
				command.type === "send-turn"
					? {
							...command,
							shellEnv: {},
							input: { ...command.input, ...inputEnvironment },
						}
					: {
							...command,
							shellEnv: {},
							input: { ...command.input, ...inputEnvironment },
						};
		}
		return this.requestEffect(
			`command:${commandId}`,
			{
				type: "command",
				commandId,
				command,
			},
			canWrite,
		);
	}

	/** Legacy answer settlement is synchronous and safe to retry if not retained. */
	observedCommandStatus(
		commandId: string,
	): Exclude<ProviderControlCommandStatus, "gone"> {
		return (
			this.completedCommands.get(commandId) ??
			(this.pending.has(`command:${commandId}`) ? "running" : "not_received")
		);
	}

	commandStatusEffect(
		commandId: string,
	): Effect.Effect<
		Exclude<ProviderControlCommandStatus, "gone">,
		SessionFailure
	> {
		const requestId = randomUUID();
		return this.requestEffect(`command-status:${requestId}`, {
			type: "command-status",
			requestId,
			commandId,
		});
	}

	outputEffect(
		output: SessionOutput,
	): Effect.Effect<SessionOutputReply, SessionFailure> {
		const outputId = randomUUID();
		return this.requestEffect(`output:${outputId}`, {
			type: "output",
			outputId,
			output,
		});
	}

	threadReadEffect(
		input: ThreadReadInput,
	): Effect.Effect<ThreadReadResult, SessionFailure> {
		const requestId = randomUUID();
		return this.requestEffect(`thread-read:${requestId}`, {
			type: "thread-read",
			requestId,
			input,
		});
	}

	serverMarkEffect(
		input: ServerMarkInput,
	): Effect.Effect<ServerMarkResult, SessionFailure> {
		const requestId = randomUUID();
		return this.requestEffect(`server-mark:${requestId}`, {
			type: "server-mark",
			requestId,
			input,
		});
	}

	private requestEffect<A>(
		key: string,
		message: RunnerMessage,
		canWrite?: RunnerWriteGate,
	): Effect.Effect<A, RunnerCommandFailure> {
		const connection = this;
		return Effect.gen(function* () {
			const result = yield* Deferred.make<A, RunnerCommandFailure>();
			const dispatch = Effect.try({
				try: () => {
					const entry: PendingReply = {
						accepted: false,
						reply: (reply) => {
							connection.pending.delete(key);
							// Capture the output boundary when the failed reply arrives.
							const precedingOutputs =
								reply.failure && message.type === "command"
									? (connection.beforeCommandFailure?.() ?? Effect.void)
									: Effect.void;
							Deferred.doneUnsafe(
								result,
								reply.failure
									? precedingOutputs.pipe(
											Effect.andThen(Effect.fail(reply.failure)),
										)
									: Effect.succeed(reply.result as A),
							);
						},
					};
					// The gate is read in this synchronous step, with the write (4.4).
					if (
						canWrite &&
						!canWrite(
							() =>
								entry.refused ??
								(connection.pending.get(key) === entry && !entry.accepted
									? connection.exitRead
									: undefined),
						)
					) {
						// No delivery evidence: the stop commit or coverage owns the release.
						const failure: RunnerCommandFailure = {
							...runnerFailure(
								"write runner frame",
								"The write gate is closed",
							),
							code: RUNNER_WRITE_GATE_CLOSED,
						};
						throw failure;
					}
					if (connection.failure || connection.socket.destroyed) {
						const failure: RunnerCommandFailure = {
							...(connection.failure ??
								runnerFailure("runner socket", "Socket is closed")),
							...(message.type === "command" &&
							message.command.type === "send-turn"
								? { delivery: { _tag: "NotSent" as const } }
								: {}),
						};
						throw failure;
					}
					connection.pending.set(key, entry);
					connection.write(message);
				},
				catch: (cause) =>
					isRecord(cause) && typeof cause["operation"] === "string"
						? (cause as unknown as SessionFailure)
						: runnerFailure("write runner frame", cause),
			});
			yield* connection.commandDispatch &&
			(message.type === "command" || message.type === "command-status")
				? connection.commandDispatch(dispatch, message)
				: dispatch;
			return yield* Deferred.await(result);
		}).pipe(Effect.ensuring(Effect.sync(() => connection.pending.delete(key))));
	}

	destroy(failure?: SessionFailure): void {
		this.socket.destroy(
			failure ? Object.assign(new Error(failure.message), failure) : undefined,
		);
	}

	refuse(failure: SessionFailure): void {
		// Flush the reason before closing so the peer reports the refusal,
		// rather than an opaque socket-close error or a startup timeout.
		this.socket.end(`${JSON.stringify({ type: "refused", failure })}\n`);
	}
}
