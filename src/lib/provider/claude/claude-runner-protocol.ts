import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { createInterface } from "node:readline";
import { Effect } from "effect";
import { isRecord } from "../../utils.js";
import type { TurnResult } from "../types.js";
import type {
	ClaudeSessionCommand,
	ClaudeSessionFailure,
	ClaudeSessionOutput,
	ClaudeSessionOutputReply,
} from "./claude-session-runner.js";

export const CLAUDE_RUNNER_PROTOCOL_VERSION = 2;

export interface ClaudeRunnerHello {
	readonly type: "hello";
	readonly protocolVersion: number;
	readonly buildId: string;
	readonly config?: {
		readonly workspaceRoot: string;
		readonly materializeSubagents: boolean;
		readonly subagentPollTimeoutMs?: number;
	};
}

type ClaudeRunnerReply =
	| {
			readonly type: "command-reply";
			readonly commandId: string;
			readonly result?: TurnResult;
			readonly failure?: ClaudeSessionFailure;
	  }
	| {
			readonly type: "output-reply";
			readonly outputId: string;
			readonly result?: ClaudeSessionOutputReply;
			readonly failure?: ClaudeSessionFailure;
	  };

export type ClaudeRunnerMessage =
	| ClaudeRunnerHello
	| ClaudeRunnerReply
	| {
			readonly type: "command";
			readonly commandId: string;
			readonly command: ClaudeSessionCommand;
	  }
	| {
			readonly type: "output";
			readonly outputId: string;
			readonly output: ClaudeSessionOutput;
	  };

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

/** Bidirectional NDJSON, including replies for server-owned output operations. */
export class ClaudeRunnerSocket {
	private readonly pending = new Map<
		string,
		(reply: ClaudeRunnerReply) => void
	>();
	private failure: ClaudeSessionFailure | undefined;

	constructor(
		private readonly socket: Socket,
		onMessage: (message: ClaudeRunnerMessage) => void,
		onClose: (failure: ClaudeSessionFailure) => void,
	) {
		const lines = createInterface({ input: socket, crlfDelay: Infinity });
		lines.on("line", (line) => {
			try {
				const message = JSON.parse(line) as ClaudeRunnerMessage;
				if (
					message.type === "command-reply" ||
					message.type === "output-reply"
				) {
					const key =
						message.type === "command-reply"
							? `command:${message.commandId}`
							: `output:${message.outputId}`;
					this.pending.get(key)?.(message);
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
			for (const reply of this.pending.values())
				reply({ type: "command-reply", commandId: "", failure: this.failure });
			this.pending.clear();
			onClose(this.failure);
		};
		socket.on("error", fail);
		socket.on("close", () => {
			lines.close();
			fail(new Error("Claude runner socket closed"));
		});
	}

	write(message: ClaudeRunnerMessage): void {
		if (!this.socket.destroyed)
			this.socket.write(`${JSON.stringify(message)}\n`);
	}

	commandEffect(
		commandId: string,
		command: ClaudeSessionCommand,
	): Effect.Effect<TurnResult | undefined, ClaudeSessionFailure> {
		return this.requestEffect(`command:${commandId}`, {
			type: "command",
			commandId,
			command,
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

	private requestEffect<A>(
		key: string,
		message: ClaudeRunnerMessage,
	): Effect.Effect<A, ClaudeSessionFailure> {
		return Effect.async<A, ClaudeSessionFailure>((resume) => {
			if (this.failure || this.socket.destroyed) {
				resume(
					Effect.fail(
						this.failure ??
							claudeRunnerFailure("runner socket", "Socket is closed"),
					),
				);
				return;
			}
			this.pending.set(key, (reply) => {
				this.pending.delete(key);
				resume(
					reply.failure
						? Effect.fail(reply.failure)
						: Effect.succeed(reply.result as A),
				);
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
}
