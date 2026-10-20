import { randomUUID } from "node:crypto";
import { isRecord } from "../../utils.js";
import { ClaudeResumeRefused } from "../event-sink-errors.js";
import {
	type ClaudeGoalStatus,
	type ReadClaudeGoalStatus,
	readClaudeGoalStatus,
} from "./claude-goal-tracker.js";
import type {
	ClaudePreWarmSessionInput,
	Query,
	SDKMessage,
	SDKUserMessage,
} from "./types.js";

/** The SDK input and output gate for an inherited goal, outside turn admission. */
export function makeClaudeForkQuery(
	createQuery: (prompt: AsyncIterable<SDKUserMessage>) => Query,
	prompt: AsyncIterable<SDKUserMessage>,
	input: ClaudePreWarmSessionInput,
	readGoalStatus: ReadClaudeGoalStatus = readClaudeGoalStatus,
	onNativeSessionId?: (nativeSessionId: string) => void,
): Query {
	let query: Query;
	let releaseDecision!: (clear: boolean) => void;
	const decision = new Promise<boolean>((resolve) => {
		releaseDecision = resolve;
	});
	let releaseInput!: (admit: boolean) => void;
	const admitted = new Promise<boolean>((resolve) => {
		releaseInput = resolve;
	});
	async function* inputs(): AsyncGenerator<SDKUserMessage> {
		if (await decision) {
			yield {
				type: "user",
				message: { role: "user", content: "/goal clear" },
				parent_tool_use_id: null,
				session_id: input.sessionId,
				uuid: randomUUID(),
			};
		}
		if (!(await admitted)) return;
		yield* prompt;
	}
	query = createQuery(inputs());
	const iterator = query[Symbol.asyncIterator]();
	const observe = (message: SDKMessage): void => {
		if ("session_id" in message && typeof message.session_id === "string")
			onNativeSessionId?.(message.session_id);
	};
	const ready = (async () => {
		await query.initializationResult();
		let status: ClaudeGoalStatus | undefined;
		try {
			status = await readGoalStatus({
				workspaceRoot: input.workspaceRoot,
				sdkSessionId: input.sessionId,
				configDir: input.configDir,
			});
		} catch {
			throw new ClaudeResumeRefused({
				reason: "fork_transcript_unavailable",
				message:
					"Claude fork transcript was unavailable before its first input",
			});
		}
		const clear = status !== undefined && !status.met;
		releaseDecision(clear);
		if (clear) {
			let recognised = false;
			let unsupported = false;
			while (true) {
				const next = await iterator.next();
				if (next.done)
					throw new ClaudeResumeRefused({
						reason: "goal_clear_unsupported",
						message: "Claude ended before confirming its hidden goal clear",
					});
				const message = next.value;
				observe(message);
				if (message.type === "assistant") {
					const command =
						"local_command_run" in message
							? message.local_command_run
							: undefined;
					const source =
						"local_command_source" in message
							? message.local_command_source
							: undefined;
					const localClear =
						message.message.model === "<synthetic>" &&
						isRecord(command) &&
						command["command"] === "goal" &&
						command["args"] === "clear" &&
						typeof source === "string" &&
						/^<local-command-stdout>(?:Goal cleared: [\s\S]+|No goal set)\s*<\/local-command-stdout>$/.test(
							source,
						);
					recognised ||= localClear;
					unsupported ||= !localClear;
				}
				if (message.type !== "result") continue;
				if (
					message.subtype !== "success" &&
					message.errors.some((error) =>
						error.includes("Resume rejected by --resume-drops-turn:"),
					)
				)
					throw new ClaudeResumeRefused({
						reason: "resume_drops_turn",
						message: message.errors.join("\n"),
					});
				if (
					!recognised ||
					unsupported ||
					message.subtype !== "success" ||
					message.num_turns !== 0
				)
					throw new ClaudeResumeRefused({
						reason: "goal_clear_unsupported",
						message: "Claude did not recognise its hidden /goal clear command",
					});
				break;
			}
		}
		releaseInput(true);
	})();
	// SDK input and readiness can be observed in either order.
	void ready.catch(() => {
		releaseDecision(false);
		releaseInput(false);
	});
	const messages = (async function* () {
		await ready;
		while (true) {
			const next = await iterator.next();
			if (next.done) return;
			observe(next.value);
			yield next.value;
		}
	})();
	return new Proxy(query, {
		get(target, key) {
			if (key === "close")
				return () => {
					releaseDecision(false);
					releaseInput(false);
					return target.close();
				};
			if (key === Symbol.asyncIterator) return () => messages;
			if (key === "initializationResult")
				return async () => {
					await ready;
					return target.initializationResult();
				};
			const value: unknown = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
