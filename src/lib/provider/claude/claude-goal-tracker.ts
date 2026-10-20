import { open, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { SessionGoalChangedPayload } from "../../contracts/stored-event.js";
import { isRecord } from "../../utils.js";
import { ClaudeRuntimeError } from "../event-sink-errors.js";
import type { ClaudeConfigDir } from "./claude-sdk-env.js";
import type { SDKMessage } from "./types.js";

export interface ClaudeGoalStatus {
	readonly met: boolean;
	readonly sentinel?: boolean;
	readonly failed?: boolean;
	readonly condition?: string;
	readonly reason?: string;
	readonly judgeModel?: string;
}

export type ReadClaudeGoalStatus = (input: {
	readonly workspaceRoot: string;
	readonly sdkSessionId: string;
	readonly configDir: ClaudeConfigDir;
}) => Promise<ClaudeGoalStatus | undefined>;

export function isGoalClearRecord(entry: unknown): boolean {
	if (!isRecord(entry)) return false;
	if (entry["type"] === "system" && entry["subtype"] === "local_command") {
		const command = entry["commandRun"];
		return (
			isRecord(command) &&
			command["command"] === "goal" &&
			command["args"] === "clear"
		);
	}
	if (entry["type"] === "assistant" && isRecord(entry["message"])) {
		const command = entry["local_command_run"];
		return (
			(isRecord(command) &&
				command["command"] === "goal" &&
				command["args"] === "clear") ||
			(entry["message"]["model"] === "<synthetic>" &&
				typeof entry["message"]["content"] === "string" &&
				entry["message"]["content"].startsWith("Goal cleared: "))
		);
	}
	if (entry["type"] !== "user" || !isRecord(entry["message"])) return false;
	const content = entry["message"]["content"];
	return (
		typeof content === "string" &&
		/<command-name>\s*\/goal\s*<\/command-name>/.test(content) &&
		/<command-args>\s*clear\s*<\/command-args>/.test(content)
	);
}

/** The goal evaluator writes attachments to the transcript, but does not
 *  forward them to the SDK. Search backwards in bounded reads because a goal
 *  can remain active across arbitrarily many later transcript records. */
export const readClaudeGoalStatus: ReadClaudeGoalStatus = async (input) => {
	if (
		typeof input.configDir?.path !== "string" ||
		input.configDir.path.trim().length === 0
	)
		throw new ClaudeRuntimeError({
			message: "Claude config directory must be non-empty",
		});
	const cwd = await realpath(input.workspaceRoot);
	const file = await open(
		join(
			input.configDir.path,
			"projects",
			cwd.replace(/[^a-zA-Z0-9]/g, "-"),
			`${input.sdkSessionId}.jsonl`,
		),
		"r",
	);
	try {
		const { size } = await file.stat();
		let end = size;
		let remainder: Buffer = Buffer.alloc(0);
		while (end > 0) {
			const start = Math.max(0, end - 64 * 1024);
			const chunk = Buffer.alloc(end - start);
			const { bytesRead } = await file.read(chunk, 0, chunk.length, start);
			const data = Buffer.concat([chunk.subarray(0, bytesRead), remainder]);
			const firstLine = start === 0 ? 0 : data.indexOf(10) + 1;
			// Keep an incomplete first line as bytes, including split UTF-8 chars.
			remainder =
				firstLine === 0 && start > 0 ? data : data.subarray(0, firstLine);
			end = start;
			if (firstLine === 0 && start > 0) continue;
			const lines = data.subarray(firstLine).toString("utf8").split("\n");
			for (let index = lines.length - 1; index >= 0; index--) {
				const line = lines[index];
				if (!line?.trim()) continue;
				let entry: unknown;
				try {
					entry = JSON.parse(line);
				} catch {
					continue;
				}
				if (isGoalClearRecord(entry)) return { met: true, sentinel: true };
				if (!isRecord(entry) || !isRecord(entry["attachment"])) continue;
				const attachment = entry["attachment"];
				if (attachment["type"] !== "goal_status") continue;
				if (typeof attachment["met"] !== "boolean") return undefined;
				return {
					met: attachment["met"],
					...(typeof attachment["sentinel"] === "boolean"
						? { sentinel: attachment["sentinel"] }
						: {}),
					...(typeof attachment["failed"] === "boolean"
						? { failed: attachment["failed"] }
						: {}),
					...(typeof attachment["condition"] === "string"
						? { condition: attachment["condition"] }
						: {}),
					...(typeof attachment["reason"] === "string"
						? { reason: attachment["reason"] }
						: {}),
					...(typeof attachment["judgeModel"] === "string" &&
					attachment["judgeModel"].trim()
						? { judgeModel: attachment["judgeModel"].trim() }
						: {}),
				};
			}
		}
		return undefined;
	} finally {
		await file.close();
	}
};

export class ClaudeGoalTracker {
	private state: SessionGoalChangedPayload;
	private readonly observedFacts = new Set<string>();

	constructor(
		private readonly sessionId: string,
		initialState?: SessionGoalChangedPayload,
	) {
		this.state = initialState
			? { ...initialState, sessionId }
			: { sessionId, goal: null };
	}

	get goal(): SessionGoalChangedPayload["goal"] {
		return this.state.goal;
	}

	/** active_goal can clear before the terminal goal_status attachment. */
	get unsettledGoal(): SessionGoalChangedPayload["goal"] {
		return (
			this.goal ??
			(this.state.ended === undefined ? (this.state.endedGoal ?? null) : null)
		);
	}

	observe(
		message: SDKMessage,
		cumulativeTokens: number,
	): SessionGoalChangedPayload | undefined {
		if (isGoalClearRecord(message)) return this.clear(message.uuid);
		if (message.type === "active_goal") {
			const value = message.value;
			const previous = this.unsettledGoal;
			const judgeModel =
				value && "judge_model" in value && typeof value.judge_model === "string"
					? value.judge_model.trim() || undefined
					: previous?.condition === value?.condition &&
							previous?.setAt === value?.set_at
						? previous?.judgeModel
						: undefined;
			return this.update(
				{
					sessionId: this.sessionId,
					goal: value
						? {
								condition: value.condition,
								iterations: value.iterations,
								setAt: value.set_at,
								tokensAtStart: value.tokens_at_start,
								...(judgeModel ? { judgeModel } : {}),
								...(value.last_reason !== undefined
									? { lastReason: value.last_reason }
									: {}),
							}
						: null,
					...(!value && previous ? { endedGoal: previous } : {}),
				},
				message.uuid,
			);
		}
		if (message.type !== "assistant" && message.type !== "user") return;
		if (message.parent_tool_use_id) return;
		const content = message.message.content;
		const text =
			typeof content === "string"
				? content
				: content
						.flatMap((block) => (block.type === "text" ? [block.text] : []))
						.join("\n");
		if (message.type === "user") {
			if (!message.isSynthetic || !this.goal) return;
			const prefix = `Stop hook feedback:\n[${this.goal.condition}]: `;
			if (!text.startsWith(prefix)) return;
			return this.update(
				{
					sessionId: this.sessionId,
					goal: {
						...this.goal,
						iterations: this.goal.iterations + 1,
						lastReason: text.slice(prefix.length),
					},
				},
				message.uuid,
			);
		}
		if (message.message.model !== "<synthetic>") return;
		if (text.startsWith("Goal set: ")) {
			return this.update(
				{
					sessionId: this.sessionId,
					goal: {
						condition: text.slice("Goal set: ".length),
						iterations: 0,
						setAt: Date.now(),
						tokensAtStart: cumulativeTokens,
					},
				},
				message.uuid,
			);
		}
		if (
			text.startsWith("Goal cleared: ") ||
			(text === "No goal set" && this.goal)
		) {
			return this.clear(message.uuid);
		}
		const status =
			/^Goal active: ([\s\S]+) \((\d+) turns\)(?:\n([\s\S]*))?$/.exec(text);
		if (status?.[1] && status[2]) {
			const previous =
				this.goal?.condition === status[1] ? this.goal : undefined;
			const reason = status[3]?.startsWith("Last check: ")
				? status[3].slice("Last check: ".length)
				: undefined;
			return this.update(
				{
					sessionId: this.sessionId,
					goal: {
						condition: status[1],
						iterations: Number(status[2]),
						setAt: previous?.setAt ?? Date.now(),
						tokensAtStart: previous?.tokensAtStart ?? cumulativeTokens,
						...(previous?.judgeModel
							? { judgeModel: previous.judgeModel }
							: {}),
						...(reason !== undefined ? { lastReason: reason } : {}),
					},
				},
				message.uuid,
			);
		}
		return undefined;
	}

	settle(status: ClaudeGoalStatus): SessionGoalChangedPayload | undefined {
		const current = this.unsettledGoal;
		if (
			!current ||
			(status.condition !== undefined && status.condition !== current.condition)
		) {
			return undefined;
		}
		if (status.sentinel) return status.met ? this.clear() : undefined;
		const goal = {
			...current,
			...(status.judgeModel ? { judgeModel: status.judgeModel } : {}),
		};
		if (status.failed)
			return this.update({
				sessionId: this.sessionId,
				goal,
				pausedReason: status.reason ?? "Goal check failed",
			});
		if (!status.met)
			return status.judgeModel
				? this.update({ sessionId: this.sessionId, goal })
				: undefined;
		return this.update({
			sessionId: this.sessionId,
			goal: null,
			ended: "met",
			endedGoal: {
				...goal,
				iterations: goal.iterations + 1,
				...(status.reason !== undefined ? { lastReason: status.reason } : {}),
			},
			endedAt: Date.now(),
		});
	}

	pause(reason: string): SessionGoalChangedPayload | undefined {
		if (!this.goal) return undefined;
		return this.update({
			sessionId: this.sessionId,
			goal: this.goal,
			pausedReason: reason,
		});
	}

	/** A successful turn means the goal is running again, even when Claude
	 *  writes no new goal fact (e.g. it only waits on background work). */
	resume(): SessionGoalChangedPayload | undefined {
		if (!this.goal || this.state.pausedReason === undefined) return undefined;
		return this.update({ sessionId: this.sessionId, goal: this.goal });
	}

	private clear(messageId?: string): SessionGoalChangedPayload | undefined {
		const goal = this.unsettledGoal;
		return this.update(
			{
				sessionId: this.sessionId,
				goal: null,
				ended: "cleared",
				...(goal ? { endedGoal: goal } : {}),
				endedAt: Date.now(),
			},
			messageId,
		);
	}

	private update(
		next: SessionGoalChangedPayload,
		messageId?: string,
	): SessionGoalChangedPayload | undefined {
		if (messageId !== undefined) {
			if (this.observedFacts.has(messageId)) return undefined;
			this.observedFacts.add(messageId);
		}
		const current = this.state;
		const goal = current.goal;
		const sameGoal =
			goal === next.goal ||
			(goal !== null &&
				next.goal !== null &&
				goal.condition === next.goal.condition &&
				goal.iterations === next.goal.iterations &&
				goal.setAt === next.goal.setAt &&
				goal.tokensAtStart === next.goal.tokensAtStart &&
				goal.lastReason === next.goal.lastReason);
		const sameJudge = goal?.judgeModel === next.goal?.judgeModel;
		if (
			sameGoal &&
			sameJudge &&
			current.ended === next.ended &&
			current.pausedReason === next.pausedReason
		) {
			return undefined;
		}
		this.state = next;
		return next;
	}
}
