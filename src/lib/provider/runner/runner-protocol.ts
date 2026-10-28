import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { createInterface } from "node:readline";
import { Deferred, Effect } from "effect";
import { BUILD_ID } from "../../build-id.js";
import { attachmentFromDataUrl } from "../../persistence/attachment-store.js";
import { isRecord } from "../../utils.js";
import type { CursorBackendUrl } from "../cursor/cursor-credential.js";
import type { ProviderControlCommandStatus, TurnResult } from "../types.js";
import {
	legacyRunnerAnswerCompletions,
	legacyRunnerRetainedSends,
} from "./runner-legacy-recovery.js";
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

export interface RunnerWireCodec {
	readonly decode: (message: RunnerMessage) => RunnerMessage;
	readonly encode: (
		message: RunnerWireMessage,
		taggedConfigDir: boolean,
	) => string;
}

export const RUNNER_PROTOCOL_VERSION = 5;

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

export type RunnerSendAnswer = {
	readonly commandId: string;
	readonly attempt: number;
	readonly nativeResumeFallback: boolean;
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
	readonly reaper?: { readonly pid: number; readonly startTime: string };
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
	/** The journal accepts a fresh fallback after an earlier attempt's rejection. */
	readonly crossAttemptNativeResumeFallback?: true;
	/** The journal reports each retained send's outcome and process call ownership. */
	readonly sendJournalAnswers?: true;
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
		readonly commandId?: string;
		/** Absent on older runners; the sink identity supplies its legacy attempt. */
		readonly attempt?: number;
		/** Absent on older runners; the daemon falls back to its turn records. */
		readonly released?: boolean;
	}[];
	readonly pendingOutputs?: readonly {
		readonly sequence: number;
		readonly output: SessionOutput;
	}[];
	readonly completedCommands?: readonly {
		readonly commandId: string;
		/** Older runners did not report the attempt in completion receipts. */
		readonly attempt?: number;
		/** Identifies the send that replied, independently of daemon preparation. */
		readonly nativeResumeFallback?: boolean;
		readonly result?: TurnResult;
		readonly failure?: SessionFailure;
	}[];
	readonly sendCommands?: readonly {
		readonly commandId: string;
		readonly attempt: number;
	}[];
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
			readonly nativeResumeFallback?: boolean;
			readonly result:
				| Exclude<ProviderControlCommandStatus, "gone">
				| "unknown";
			readonly failure?: SessionFailure;
	  }
	| {
			readonly type: "thread-read-reply";
			readonly requestId: string;
			readonly result: ThreadReadResult;
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
			readonly attempt?: number;
			readonly nativeResumeFallback?: boolean;
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

export type RunnerMessage =
	| RunnerHello
	| {
			readonly type: "command-refused";
			readonly commandId: string;
			readonly attempt?: number;
			readonly nativeResumeFallback?: boolean;
			readonly reason: "exiting" | "retiring" | "interrupted";
	  }
	| {
			readonly type: "command-status";
			readonly requestId: string;
			readonly commandId: string;
			readonly attempt?: number;
			readonly nativeResumeFallback?: boolean;
	  }
	| {
			readonly type: "thread-read";
			readonly requestId: string;
			readonly input: ThreadReadInput;
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
			readonly commands: NonNullable<RunnerHello["sendCommands"]>;
	  }
	| {
			readonly type: "command-accepted";
			readonly commandId: string;
			readonly attempt?: number;
			readonly sinkId: string;
	  }
	| { readonly type: "refused"; readonly failure: SessionFailure }
	| RunnerReply
	| {
			readonly type: "command";
			readonly commandId: string;
			readonly command: SessionCommand;
			readonly attempt?: number;
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
	  };

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

export type RunnerDeliveryEvidence =
	| {
			readonly _tag: "Refused";
			readonly reason: "exiting" | "retiring" | "interrupted";
	  }
	| { readonly _tag: "NotSent" };

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
	private readonly pending = new Map<
		string,
		{
			reply: (reply: RunnerReply) => void;
			retryOnIdle: boolean;
			accepted: boolean;
			commandAttempt?: number;
			nativeResumeFallback?: boolean;
		}
	>();
	private failure: SessionFailure | undefined;
	private idleExiting = false;
	private peerTaggedConfigDir = false;
	private peerAttachmentRefs = false;
	private peerSettlesAnswers = false;
	scopedCursorCredentials = false;
	private peerDriverKind: string | undefined;
	private helloSends: RunnerHello["sendCommands"];
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
	get retainedSends(): RunnerHello["sendCommands"] {
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
					this.helloSends =
						message.sendJournalAnswers === true
							? (message.sendAnswers ?? [])
							: legacyRunnerRetainedSends(message);
					if (!this.peerSettlesAnswers && message.sendJournalAnswers !== true)
						for (const command of legacyRunnerAnswerCompletions(message))
							if (command.commandId.endsWith(":answer"))
								this.completedCommands.set(
									command.commandId,
									command.failure ? "failed" : "completed",
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
				if (message.type === "idle-exit") this.idleExiting = true;
				if (message.type === "command-accepted") {
					const pending = this.pending.get(`command:${message.commandId}`);
					if (
						pending &&
						(message.attempt === undefined ||
							message.attempt === pending.commandAttempt)
					)
						pending.accepted = true;
				}
				if (
					message.type === "command-reply" ||
					message.type === "output-reply" ||
					message.type === "upgrade-reply" ||
					message.type === "command-status-reply" ||
					message.type === "thread-read-reply"
				) {
					const key =
						message.type === "command-status-reply"
							? `command-status:${message.requestId}`
							: message.type === "thread-read-reply"
								? `thread-read:${message.requestId}`
								: message.type === "upgrade-reply"
									? `upgrade:${message.requestId}`
									: message.type === "command-reply"
										? `command:${message.commandId}`
										: `output:${message.outputId}`;
					const reply = this.pending.get(key);
					if (
						reply &&
						(message.type !== "command-reply" ||
							((message.attempt === undefined ||
								message.attempt === reply.commandAttempt) &&
								(message.nativeResumeFallback === undefined ||
									message.nativeResumeFallback === reply.nativeResumeFallback)))
					) {
						if (
							message.type === "command-status-reply" &&
							reply.nativeResumeFallback !== undefined &&
							message.nativeResumeFallback !== reply.nativeResumeFallback
						) {
							// An older peer cannot distinguish the primary from its fallback.
							message = { ...message, result: "unknown" };
						}
						// Only a legacy reply before acceptance proves non-delivery.
						if (
							message.type === "command-reply" &&
							reply.retryOnIdle &&
							!reply.accepted &&
							message.failure?.code === "runner_idle_exit"
						) {
							const failure: RunnerCommandFailure = {
								...message.failure,
								delivery: { _tag: "Refused", reason: "exiting" },
							};
							message = { ...message, failure };
						}
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
		let frame: RunnerWireMessage = message;
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

	commandEffect(
		commandId: string,
		command: SessionCommand,
		attempt?: number,
	): Effect.Effect<TurnResult | undefined, RunnerCommandFailure> {
		if (command.type === "send-turn" && command.input.runId)
			command = { ...command, runId: command.input.runId };
		if (
			this.peerDriverKind === "cursor" &&
			!this.scopedCursorCredentials &&
			(command.type === "pre-warm" ||
				(command.type === "send-turn" &&
					!this.retainedSends?.some(
						(send) =>
							send.commandId === commandId && send.attempt === (attempt ?? 0),
					)))
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
		return this.requestEffect(`command:${commandId}`, {
			type: "command",
			commandId,
			command,
			...(attempt !== undefined ? { attempt } : {}),
		});
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
		attempt?: number,
	): Effect.Effect<
		Exclude<ProviderControlCommandStatus, "gone">,
		SessionFailure
	>;
	commandStatusEffect(
		commandId: string,
		attempt: number | undefined,
		nativeResumeFallback: boolean | undefined,
	): Effect.Effect<
		Exclude<ProviderControlCommandStatus, "gone"> | "unknown",
		SessionFailure
	>;
	commandStatusEffect(
		commandId: string,
		attempt?: number,
		nativeResumeFallback?: boolean,
	): Effect.Effect<
		Exclude<ProviderControlCommandStatus, "gone"> | "unknown",
		SessionFailure
	> {
		const requestId = randomUUID();
		return this.requestEffect(`command-status:${requestId}`, {
			type: "command-status",
			requestId,
			commandId,
			...(attempt !== undefined ? { attempt } : {}),
			...(nativeResumeFallback !== undefined ? { nativeResumeFallback } : {}),
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

	private requestEffect<A>(
		key: string,
		message: RunnerMessage,
	): Effect.Effect<A, RunnerCommandFailure> {
		const connection = this;
		return Effect.gen(function* () {
			const result = yield* Deferred.make<A, RunnerCommandFailure>();
			const dispatch = Effect.try({
				try: () => {
					const retryOnIdle =
						message.type === "command" && message.command.type === "send-turn";
					if (connection.idleExiting && retryOnIdle) {
						const failure: RunnerCommandFailure = {
							...runnerIdleFailure(),
							delivery: { _tag: "NotSent" },
						};
						throw failure;
					}
					if (connection.failure || connection.socket.destroyed) {
						const failure: RunnerCommandFailure = {
							...(connection.failure ??
								runnerFailure("runner socket", "Socket is closed")),
							...(retryOnIdle
								? { delivery: { _tag: "NotSent" as const } }
								: {}),
						};
						throw failure;
					}
					connection.pending.set(key, {
						retryOnIdle,
						accepted: false,
						...(message.type === "command"
							? {
									commandAttempt: message.attempt ?? 0,
									nativeResumeFallback:
										message.command.type === "send-turn" &&
										message.command.input.nativeResumeFallback === true,
								}
							: {}),
						...(message.type === "command-status" &&
						message.nativeResumeFallback !== undefined
							? { nativeResumeFallback: message.nativeResumeFallback }
							: {}),
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
					});
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
