import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { createInterface } from "node:readline";
import { Effect } from "effect";
import { BUILD_ID } from "../../build-id.js";
import { isRecord } from "../../utils.js";
import { ClaudeBoundaryError } from "../event-sink-errors.js";
import type { TurnResult } from "../types.js";
import type { ClaudeRunnerUpgradeState } from "./claude-runner-upgrade.js";
import type {
	ClaudeSessionCommand,
	ClaudeSessionFailure,
	ClaudeSessionOutput,
	ClaudeSessionOutputReply,
	ClaudeSessionTurn,
} from "./claude-session-runner.js";
import type { ClaudeThreadReadInput, ClaudeThreadReadResult } from "./types.js";

export const CLAUDE_RUNNER_PROTOCOL_VERSION = 5;

export const claudeRunnerBuildId = (): string =>
	process.env["NODE_ENV"] === "test"
		? (process.env["CONDUIT_TEST_BUILD_ID"] ?? BUILD_ID)
		: BUILD_ID;

/** Cleanup from an old attempt must never release a newer attempt's sink. */
export const claudeRunnerSinkId = (
	commandId: string,
	attempt = 0,
	nativeResumeFallback = false,
): string =>
	`${commandId}:${attempt}${nativeResumeFallback ? ":native-resume-fallback" : ""}`;

export interface ClaudeRunnerHello {
	readonly type: "hello";
	readonly protocolVersion: number;
	readonly buildId: string;
	readonly runnerId?: string;
	readonly sessionId?: string;
	readonly pid?: number;
	readonly acknowledgedSequence?: number;
	readonly upgradeState?: ClaudeRunnerUpgradeState;
	readonly bindings?: readonly {
		readonly sinkId: string;
		readonly sessionId: string;
		readonly commandId?: string;
	}[];
	readonly pendingOutputs?: readonly {
		readonly sequence: number;
		readonly output: ClaudeSessionOutput;
	}[];
	readonly completedCommands?: readonly {
		readonly commandId: string;
		readonly result?: TurnResult;
		readonly failure?: ClaudeSessionFailure;
	}[];
	readonly config?: {
		readonly workspaceRoot: string;
		readonly extraFolders?: readonly string[];
		readonly daemonConfigDir?: string;
		readonly materializeSubagents: boolean;
		readonly subagentPollTimeoutMs?: number;
	};
}

type ClaudeRunnerReply =
	| {
			readonly type: "thread-read-reply";
			readonly requestId: string;
			readonly result: ClaudeThreadReadResult;
			readonly failure?: ClaudeSessionFailure;
	  }
	| {
			readonly type: "upgrade-reply";
			readonly requestId: string;
			readonly result: boolean;
			readonly failure?: ClaudeSessionFailure;
	  }
	| {
			readonly type: "command-reply";
			readonly commandId: string;
			readonly result?: TurnResult;
			readonly failure?: ClaudeSessionFailure;
	  }
	| {
			readonly type: "output-reply";
			readonly outputId: string;
			readonly sequence?: number | undefined;
			readonly result?: ClaudeSessionOutputReply;
			readonly failure?: ClaudeSessionFailure;
	  };

export type ClaudeRunnerMessage =
	| ClaudeRunnerHello
	| {
			readonly type: "thread-read";
			readonly requestId: string;
			readonly input: ClaudeThreadReadInput;
	  }
	| { readonly type: "upgrade-state"; readonly state: ClaudeRunnerUpgradeState }
	| {
			readonly type: "upgrade-retire";
			readonly requestId: string;
			readonly revision: number;
	  }
	| { readonly type: "upgrade-cancel" | "upgrade-activate" }
	| { readonly type: "idle-exit" | "idle-exit-ack" }
	| {
			readonly type: "command-accepted";
			readonly commandId: string;
			readonly sinkId: string;
	  }
	| { readonly type: "refused"; readonly failure: ClaudeSessionFailure }
	| ClaudeRunnerReply
	| {
			readonly type: "command";
			readonly commandId: string;
			readonly command: ClaudeSessionCommand;
			readonly attempt?: number;
	  }
	| {
			readonly type: "output";
			readonly outputId: string;
			readonly sequence?: number;
			readonly output: ClaudeSessionOutput;
	  }
	| {
			readonly type: "replay";
			readonly acknowledgedSequence: number;
			readonly preserveRole?: boolean;
	  };

export function normalizeClaudeSessionTurn(
	input: Omit<ClaudeSessionTurn, "inputId"> & {
		readonly inputId?: string;
		readonly userMessageId?: string;
		readonly commandId?: string;
		readonly turnId?: string;
	},
): ClaudeSessionTurn {
	const { inputId, userMessageId, commandId, turnId, ...turn } = input;
	const id = inputId ?? userMessageId ?? commandId ?? turnId;
	if (id === undefined)
		throw new ClaudeBoundaryError({
			operation: "decodeRunnerTurn",
			cause: "Claude turn input id is required",
		});
	return { ...turn, inputId: id };
}

export function claudeRunnerHelloFailure(
	hello: ClaudeRunnerHello,
	peer: "server" | "runner",
): ClaudeSessionFailure | undefined {
	if (hello.protocolVersion !== CLAUDE_RUNNER_PROTOCOL_VERSION)
		return claudeRunnerFailure(
			"runner hello",
			`Claude runner protocol mismatch: ${peer} speaks version ${hello.protocolVersion}, expected ${CLAUDE_RUNNER_PROTOCOL_VERSION} (peer build ${hello.buildId}, local build ${BUILD_ID})`,
		);
	return undefined;
}

export function claudeRunnerFailure(
	operation: string,
	cause: unknown,
): ClaudeSessionFailure {
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

export const claudeRunnerIdleFailure = (): ClaudeSessionFailure => ({
	operation: "runner admission",
	message: "Claude runner is exiting after inactivity",
	code: "runner_idle_exit",
	retryable: true,
});

/** Bidirectional NDJSON, including replies for server-owned output operations. */
export class ClaudeRunnerSocket {
	private readonly pending = new Map<
		string,
		{
			reply: (reply: ClaudeRunnerReply) => void;
			retryOnIdle: boolean;
			accepted: boolean;
		}
	>();
	private failure: ClaudeSessionFailure | undefined;
	private idleExiting = false;

	constructor(
		private readonly socket: Socket,
		onMessage: (message: ClaudeRunnerMessage) => void,
		onClose: (failure: ClaudeSessionFailure) => void,
		private readonly beforeCommandFailure?: () => Effect.Effect<void>,
	) {
		const lines = createInterface({ input: socket, crlfDelay: Infinity });
		lines.on("line", (line) => {
			try {
				const decoded = JSON.parse(line) as ClaudeRunnerMessage;
				const message =
					decoded.type === "command" && decoded.command.type === "send-turn"
						? {
								...decoded,
								command: {
									...decoded.command,
									input: normalizeClaudeSessionTurn(decoded.command.input),
								},
							}
						: decoded;
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
					new Error(claudeRunnerFailure("decode runner frame", cause).message),
				);
			}
		});
		const fail = (cause: unknown) => {
			if (this.failure) return;
			this.failure = claudeRunnerFailure("runner socket", cause);
			for (const pending of this.pending.values())
				pending.reply({
					type: "command-reply",
					commandId: "",
					failure:
						this.idleExiting && pending.retryOnIdle && !pending.accepted
							? claudeRunnerIdleFailure()
							: this.failure,
				});
			this.pending.clear();
			onClose(this.failure);
		};
		lines.on("error", fail);
		socket.on("error", fail);
		socket.on("close", () => {
			lines.close();
			fail(new Error("Claude runner socket closed"));
		});
	}

	write(message: ClaudeRunnerMessage): void {
		if (this.socket.destroyed) return;
		// Runners can outlive the daemon. Older builds read these aliases for
		// turn correlation (a continuation's turn is its cut-off message) and
		// report commandId in their attachment bindings.
		const frame =
			message.type === "command" && message.command.type === "send-turn"
				? {
						...message,
						command: {
							...message.command,
							input: {
								...message.command.input,
								turnId: message.command.input.inputId,
								userMessageId:
									message.command.input.continuation?.cutOffMessageId ??
									message.command.input.inputId,
								commandId: message.commandId,
							},
						},
					}
				: message;
		this.socket.write(`${JSON.stringify(frame)}\n`);
	}

	get closed(): boolean {
		return this.failure !== undefined || this.socket.destroyed;
	}

	retireEffect(revision: number): Effect.Effect<boolean, ClaudeSessionFailure> {
		const requestId = randomUUID();
		return this.requestEffect(`upgrade:${requestId}`, {
			type: "upgrade-retire",
			requestId,
			revision,
		});
	}

	commandEffect(
		commandId: string,
		command: ClaudeSessionCommand,
		attempt?: number,
	): Effect.Effect<TurnResult | undefined, ClaudeSessionFailure> {
		return this.requestEffect(`command:${commandId}`, {
			type: "command",
			commandId,
			command,
			...(attempt !== undefined ? { attempt } : {}),
		});
	}

	outputEffect(
		output: ClaudeSessionOutput,
	): Effect.Effect<ClaudeSessionOutputReply, ClaudeSessionFailure> {
		const outputId = randomUUID();
		return this.requestEffect(`output:${outputId}`, {
			type: "output",
			outputId,
			output,
		});
	}

	threadReadEffect(
		input: ClaudeThreadReadInput,
	): Effect.Effect<ClaudeThreadReadResult, ClaudeSessionFailure> {
		const requestId = randomUUID();
		return this.requestEffect(`thread-read:${requestId}`, {
			type: "thread-read",
			requestId,
			input,
		});
	}

	private requestEffect<A>(
		key: string,
		message: ClaudeRunnerMessage,
	): Effect.Effect<A, ClaudeSessionFailure> {
		return Effect.async<A, ClaudeSessionFailure>((resume) => {
			const retryOnIdle =
				message.type === "command" && message.command.type === "send-turn";
			if (this.idleExiting && retryOnIdle) {
				resume(Effect.fail(claudeRunnerIdleFailure()));
				return;
			}
			if (this.failure || this.socket.destroyed) {
				resume(
					Effect.fail(
						this.failure ??
							claudeRunnerFailure("runner socket", "Socket is closed"),
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
					resume(
						reply.failure
							? precedingOutputs.pipe(
									Effect.zipRight(Effect.fail(reply.failure)),
								)
							: Effect.succeed(reply.result as A),
					);
				},
			});
			try {
				this.write(message);
			} catch (cause) {
				this.pending.delete(key);
				resume(Effect.fail(claudeRunnerFailure("write runner frame", cause)));
			}
			return Effect.sync(() => {
				this.pending.delete(key);
			});
		});
	}

	destroy(): void {
		this.socket.destroy();
	}

	refuse(failure: ClaudeSessionFailure): void {
		// Flush the reason before closing so the peer reports the refusal,
		// rather than an opaque socket-close error or a startup timeout.
		this.socket.end(`${JSON.stringify({ type: "refused", failure })}\n`);
	}
}
