import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { createInterface } from "node:readline";
import { Effect } from "effect";
import { BUILD_ID } from "../../build-id.js";
import { isRecord } from "../../utils.js";
import type { TurnResult } from "../types.js";
import type { RunnerUpgradeState } from "./runner-upgrade.js";
import type {
	SessionCommand,
	SessionFailure,
	SessionOutput,
	SessionOutputReply,
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
	readonly encode: (message: RunnerMessage, taggedConfigDir: boolean) => string;
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

export interface RunnerHello {
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
	readonly taggedConfigDir?: true;
	readonly bindings?: readonly {
		readonly sinkId: string;
		readonly sessionId: string;
		readonly commandId?: string;
	}[];
	readonly pendingOutputs?: readonly {
		readonly sequence: number;
		readonly output: SessionOutput;
	}[];
	readonly completedCommands?: readonly {
		readonly commandId: string;
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
		readonly subagentPollTimeoutMs?: number;
	};
}

type RunnerReply =
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
			readonly acknowledgedSequence: number;
			readonly preserveRole?: boolean;
	  };

export function runnerHelloFailure(
	hello: RunnerHello,
	peer: "server" | "runner",
	expectedDriverKind?: string,
): SessionFailure | undefined {
	if (hello.protocolVersion !== RUNNER_PROTOCOL_VERSION)
		return runnerFailure(
			"runner hello",
			`Runner protocol mismatch: ${peer} speaks version ${hello.protocolVersion}, expected ${RUNNER_PROTOCOL_VERSION} (peer build ${hello.buildId}, local build ${BUILD_ID})`,
		);
	if (
		expectedDriverKind !== undefined &&
		(hello.driverKind ?? "claude") !== expectedDriverKind
	)
		return runnerFailure(
			"runner hello",
			`Runner driver mismatch: ${peer} speaks ${hello.driverKind ?? "claude"}, expected ${expectedDriverKind}`,
		);
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

/** Bidirectional NDJSON, including replies for server-owned output operations. */
export class RunnerSocket {
	private readonly pending = new Map<
		string,
		{
			reply: (reply: RunnerReply) => void;
			retryOnIdle: boolean;
			accepted: boolean;
		}
	>();
	private failure: SessionFailure | undefined;
	private idleExiting = false;
	private peerTaggedConfigDir = false;
	/** Temporary old-runner adapter, installed by the hello compatibility decision. */
	legacyResult?: (
		commandId: string,
		attempt: number | undefined,
		result: TurnResult | undefined,
	) => Effect.Effect<void, SessionFailure>;

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
				const message = this.wire?.decode(decoded) ?? decoded;
				if (message.type === "hello")
					this.peerTaggedConfigDir = message.taggedConfigDir === true;
				if (message.type === "idle-exit") this.idleExiting = true;
				if (message.type === "command-accepted") {
					const pending = this.pending.get(`command:${message.commandId}`);
					if (pending) pending.accepted = true;
				}
				if (
					message.type === "command-reply" ||
					message.type === "output-reply" ||
					message.type === "upgrade-reply" ||
					message.type === "thread-read-reply"
				) {
					const key =
						message.type === "thread-read-reply"
							? `thread-read:${message.requestId}`
							: message.type === "upgrade-reply"
								? `upgrade:${message.requestId}`
								: message.type === "command-reply"
									? `command:${message.commandId}`
									: `output:${message.outputId}`;
					const reply = this.pending.get(key);
					if (reply) reply.reply(message);
					else onMessage(message);
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
					failure:
						this.idleExiting && pending.retryOnIdle && !pending.accepted
							? runnerIdleFailure()
							: this.failure,
				});
			this.pending.clear();
			onClose(this.failure);
		};
		lines.on("error", fail);
		socket.on("error", fail);
		socket.on("close", () => {
			lines.close();
			fail(new Error("Runner socket closed"));
		});
	}

	write(message: RunnerMessage): void {
		if (this.socket.destroyed) return;
		this.socket.write(
			this.wire?.encode(message, this.peerTaggedConfigDir) ??
				`${JSON.stringify(message)}\n`,
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
	): Effect.Effect<TurnResult | undefined, SessionFailure> {
		return this.requestEffect(`command:${commandId}`, {
			type: "command",
			commandId,
			command,
			...(attempt !== undefined ? { attempt } : {}),
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
	): Effect.Effect<A, SessionFailure> {
		return Effect.callback<A, SessionFailure>((resume) => {
			const retryOnIdle =
				message.type === "command" && message.command.type === "send-turn";
			if (this.idleExiting && retryOnIdle) {
				resume(Effect.fail(runnerIdleFailure()));
				return;
			}
			if (this.failure || this.socket.destroyed) {
				resume(
					Effect.fail(
						this.failure ?? runnerFailure("runner socket", "Socket is closed"),
					),
				);
				return;
			}
			this.pending.set(key, {
				retryOnIdle,
				accepted: false,
				reply: (reply) => {
					this.pending.delete(key);
					// Capture the output boundary when the failed reply arrives.
					const precedingOutputs =
						reply.failure && message.type === "command"
							? (this.beforeCommandFailure?.() ?? Effect.void)
							: Effect.void;
					if (
						this.legacyResult &&
						!reply.failure &&
						message.type === "command" &&
						message.command.type === "send-turn"
					) {
						resume(
							(this.beforeCommandFailure?.() ?? Effect.void).pipe(
								Effect.as(reply.result as A),
							),
						);
						return;
					}
					resume(
						reply.failure
							? precedingOutputs.pipe(
									Effect.andThen(Effect.fail(reply.failure)),
								)
							: Effect.succeed(reply.result as A),
					);
				},
			});
			try {
				this.write(message);
			} catch (cause) {
				this.pending.delete(key);
				resume(Effect.fail(runnerFailure("write runner frame", cause)));
			}
			return Effect.sync(() => {
				this.pending.delete(key);
			});
		});
	}

	destroy(): void {
		this.socket.destroy();
	}

	refuse(failure: SessionFailure): void {
		// Flush the reason before closing so the peer reports the refusal,
		// rather than an opaque socket-close error or a startup timeout.
		this.socket.end(`${JSON.stringify({ type: "refused", failure })}\n`);
	}
}
