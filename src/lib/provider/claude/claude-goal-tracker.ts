import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionGoalChangedPayload } from "../../contracts/stored-event.js";
import { isRecord } from "../../utils.js";
import type { SDKMessage } from "./types.js";

export interface ClaudeGoalStatus {
	readonly met: boolean;
	readonly sentinel?: boolean;
	readonly failed?: boolean;
	readonly condition?: string;
	readonly reason?: string;
}

export type ReadClaudeGoalStatus = (input: {
	readonly workspaceRoot: string;
	readonly sdkSessionId: string;
	readonly configDir?: string;
}) => Promise<ClaudeGoalStatus | undefined>;

/** The goal evaluator writes attachments to the transcript, but does not
 *  forward them to the SDK. Only inspect its bounded tail at turn end. */
export const readClaudeGoalStatus: ReadClaudeGoalStatus = async (input) => {
	const cwd = await realpath(input.workspaceRoot);
	const configDir =
		input.configDir ??
		process.env["CLAUDE_CONFIG_DIR"] ??
		join(homedir(), ".claude");
	const file = await open(
		join(
			configDir,
			"projects",
			cwd.replace(/[^a-zA-Z0-9]/g, "-"),
			`${input.sdkSessionId}.jsonl`,
		),
		"r",
	);
	try {
		const { size } = await file.stat();
		const start = Math.max(0, size - 64 * 1024);
		const tail = Buffer.alloc(size - start);
		const { bytesRead } = await file.read(tail, 0, tail.length, start);
		const lines = tail.subarray(0, bytesRead).toString("utf8").split("\n");
		for (let index = lines.length - 1; index >= 0; index--) {
			const line = lines[index];
			if (!line?.trim()) continue;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
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
			};
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

	observe(
		message: SDKMessage,
		cumulativeTokens: number,
	): SessionGoalChangedPayload | undefined {
		if (message.type === "active_goal") {
			const value = message.value;
			return this.update(
				{
					sessionId: this.sessionId,
					goal: value
						? {
								condition: value.condition,
								iterations: value.iterations,
								setAt: value.set_at,
								tokensAtStart: value.tokens_at_start,
								...(value.last_reason !== undefined
									? { lastReason: value.last_reason }
									: {}),
							}
						: null,
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
			return this.update(
				{
					sessionId: this.sessionId,
					goal: null,
					ended: "cleared",
					...(this.goal ? { endedGoal: this.goal } : {}),
					endedAt: Date.now(),
				},
				message.uuid,
			);
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
						...(reason !== undefined ? { lastReason: reason } : {}),
					},
				},
				message.uuid,
			);
		}
		return undefined;
	}

	settle(status: ClaudeGoalStatus): SessionGoalChangedPayload | undefined {
		if (
			!this.goal ||
			(status.condition !== undefined &&
				status.condition !== this.goal.condition)
		) {
			return undefined;
		}
		if (status.failed) return this.pause(status.reason ?? "Goal check failed");
		if (status.sentinel || !status.met) return undefined;
		return this.update({
			sessionId: this.sessionId,
			goal: null,
			ended: "met",
			endedGoal: {
				...this.goal,
				iterations: this.goal.iterations + 1,
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
		if (
			sameGoal &&
			current.ended === next.ended &&
			current.pausedReason === next.pausedReason
		) {
			return undefined;
		}
		this.state = next;
		return next;
	}
}
