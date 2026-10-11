// Decides which session owns each Claude SDK message (spec conduit-test-i7fy).
// Rule: the parent owns only the tool calls it issued itself. A message about
// any other tool call belongs to the session that issued that call, and is
// held until that session is known. Nothing defaults to the parent.
//
// Pure: no I/O, no clock. The caller carries out the decisions.

import { isRecord } from "../../utils.js";
import type { SDKMessage, SessionMessage } from "./types.js";

export type ClaudeMessageOwner =
	| { readonly kind: "parent" }
	// taskId: the task whose Child Session this is, so a task it starts can
	// name the task that started it.
	| {
			readonly kind: "child";
			readonly childSessionId: string;
			readonly taskId: string;
	  };
type ChildOwner = Extract<ClaudeMessageOwner, { kind: "child" }>;

export type ClaudeOwnershipInput =
	| {
			readonly kind: "sdk";
			readonly message: SDKMessage;
			readonly receivedAt?: number;
	  }
	| { readonly kind: "live-tasks"; readonly taskIds: readonly string[] }
	| {
			readonly kind: "transcript";
			readonly taskId: string;
			readonly messages: readonly SessionMessage[];
	  }
	// The stream ended or the Claude process restarted: held messages are
	// dropped, since their owners can no longer become known.
	| { readonly kind: "end" };

export type ClaudeOwnershipDecision =
	| {
			readonly kind: "route";
			readonly owner: ClaudeMessageOwner;
			readonly message: SDKMessage;
			readonly receivedAt?: number;
			// For task and tool progress messages: the tool call the message is
			// about, and the uuid of the SDK message that issued it.
			readonly tool?: {
				readonly toolUseId: string;
				readonly issuingMessageId?: string;
			};
	  }
	| {
			readonly kind: "route-transcript";
			readonly childSessionId: string;
			readonly messages: readonly SessionMessage[];
	  }
	| {
			readonly kind: "hold";
			readonly message: SDKMessage;
			// The tool use id or task id whose owner is not known yet.
			readonly awaiting: string;
	  }
	| {
			// Create the Child Session and set its id on the tool call that
			// started the task (in the issuer's session). Issued once per task.
			readonly kind: "open-child";
			readonly childSessionId: string;
			readonly taskId: string;
			readonly toolUseId: string;
			readonly issuer: ClaudeMessageOwner;
			readonly issuingMessageId?: string;
			readonly description?: string;
			readonly taskType?: string;
	  }
	| {
			readonly kind: "start-feed";
			readonly taskId: string;
			readonly childSessionId: string;
	  }
	| {
			readonly kind: "final-read";
			readonly taskId: string;
			readonly childSessionId: string;
	  }
	| {
			readonly kind: "drop";
			readonly message: SDKMessage;
			readonly reason: string;
	  };

export interface ClaudeMessageOwnership {
	// Decisions come back in the order to carry them out. A message that
	// makes an owner known is followed by the held messages it releases, in
	// arrival order.
	decide(input: ClaudeOwnershipInput): readonly ClaudeOwnershipDecision[];
	/** Launcher input has the issuer's lifetime, including after its call returns. */
	toolInputFor(
		toolUseId: string,
	): { readonly name: string; readonly input: unknown } | undefined;
	rememberToolInput(toolUseId: string, name: string, input: unknown): void;
}

// Issuers outlive their calls. Keep the launcher field, rather than retaining
// every tool's file contents and agent prompts for the whole session.
function launcherInput(
	name: string,
	input: unknown,
	previous?: { readonly name: string; readonly input: unknown },
) {
	const field =
		name === "Bash" || name === "Monitor"
			? "command"
			: name === "Agent" || name === "Task"
				? "subagent_type"
				: undefined;
	const value = field && isRecord(input) ? input[field] : undefined;
	return field && typeof value === "string" && value.trim()
		? { name, input: { [field]: value } }
		: (previous ?? { name, input: {} });
}

export function createClaudeMessageOwnership(deps: {
	// The Child Session id for a task; stable for the same task.
	readonly childSessionIdFor: (taskId: string, message: SDKMessage) => string;
}): ClaudeMessageOwnership {
	const parent: ClaudeMessageOwner = { kind: "parent" };
	const issuers = new Map<
		string,
		{
			owner: ClaudeMessageOwner;
			issuingMessageId?: string;
			toolInput?: { readonly name: string; readonly input: unknown };
		}
	>();
	const agents = new Map<string, ChildOwner>();
	const tasks = new Map<string, string>();
	const feeds = new Map<string, string>();
	const finishedTasks = new Set<string>();
	const listedTasks = new Set<string>();
	let liveTasks = new Set<string>();
	let ended = false;
	const held: {
		message: SDKMessage;
		awaiting: string;
		receivedAt?: number;
	}[] = [];

	return {
		toolInputFor(toolUseId) {
			return issuers.get(toolUseId)?.toolInput;
		},
		rememberToolInput(toolUseId, name, input) {
			const issuer = issuers.get(toolUseId);
			if (issuer)
				issuers.set(toolUseId, {
					...issuer,
					toolInput: launcherInput(name, input, issuer.toolInput),
				});
		},
		decide(input) {
			const decisions: ClaudeOwnershipDecision[] = [];
			const finalRead = (taskId: string) => {
				const childSessionId = feeds.get(taskId);
				if (childSessionId === undefined) return;
				feeds.delete(taskId);
				decisions.push({ kind: "final-read", taskId, childSessionId });
			};
			if (input.kind === "end") {
				ended = true;
				for (const taskId of feeds.keys()) finalRead(taskId);
				decisions.push(
					...held.splice(0).map(
						({ message, awaiting }): ClaudeOwnershipDecision => ({
							kind: "drop",
							message,
							reason: `Claude stream ended while awaiting ownership of ${awaiting}`,
						}),
					),
				);
				return decisions;
			}
			if (input.kind === "live-tasks") {
				liveTasks = new Set(input.taskIds);
				for (const taskId of input.taskIds) listedTasks.add(taskId);
				return decisions;
			}
			if (ended && input.kind === "sdk") {
				return [
					{
						kind: "drop",
						message: input.message,
						reason: "Claude stream ended",
					},
				];
			}

			const newlyKnown = new Set<string>();
			const hold = (message: SDKMessage, awaiting: string) => {
				decisions.push({ kind: "hold", message, awaiting });
				return awaiting;
			};
			const registerIssuer = (
				toolUseId: string,
				owner: ClaudeMessageOwner,
				issuingMessageId?: string,
				toolInput?: { readonly name: string; readonly input: unknown },
			) => {
				const issuer = issuers.get(toolUseId);
				const uuid = issuingMessageId ?? issuer?.issuingMessageId;
				const launcher =
					toolInput &&
					launcherInput(toolInput.name, toolInput.input, issuer?.toolInput);
				issuers.set(toolUseId, {
					...issuer,
					owner,
					...(uuid === undefined ? {} : { issuingMessageId: uuid }),
					...(launcher ? { toolInput: launcher } : {}),
				});
				if (issuer === undefined) newlyKnown.add(toolUseId);
			};
			const decideMessage = (
				message: SDKMessage,
				receivedAt?: number,
			): string | undefined => {
				let owner: ClaudeMessageOwner = parent;
				let toolUseId: string | undefined;
				const finishesTask =
					message.type === "system" &&
					(message.subtype === "task_notification" ||
						(message.subtype === "task_updated" &&
							(message.patch.status === "completed" ||
								message.patch.status === "failed" ||
								message.patch.status === "killed")));
				if (finishesTask) finishedTasks.add(message.task_id);

				switch (message.type) {
					case "assistant":
					case "user":
					case "stream_event": {
						const parentToolUseId = message.parent_tool_use_id ?? undefined;
						if (parentToolUseId !== undefined) {
							const child = agents.get(parentToolUseId);
							if (child === undefined) {
								return hold(message, parentToolUseId);
							}
							owner = child;
						}
						break;
					}
					case "system":
						switch (message.subtype) {
							case "task_updated":
								toolUseId = tasks.get(message.task_id);
								if (toolUseId === undefined) {
									return hold(message, message.task_id);
								}
								break;
							case "task_started":
							case "task_progress":
							case "task_notification":
								toolUseId = message.tool_use_id ?? tasks.get(message.task_id);
								if (toolUseId === undefined) {
									decisions.push({
										kind: "drop",
										message,
										reason: `Task ${message.task_id} has no known tool call`,
									});
									return;
								}
								break;
						}
						break;
					case "tool_progress":
						toolUseId = message.parent_tool_use_id ?? message.tool_use_id;
						break;
				}

				if (toolUseId !== undefined) {
					const issuer = issuers.get(toolUseId);
					if (issuer === undefined) return hold(message, toolUseId);
					const tool = {
						toolUseId,
						...(issuer.issuingMessageId === undefined
							? {}
							: { issuingMessageId: issuer.issuingMessageId }),
					};
					const firstStart =
						message.type === "system" &&
						message.subtype === "task_started" &&
						!tasks.has(message.task_id);
					if (firstStart) {
						tasks.set(message.task_id, toolUseId);
						newlyKnown.add(message.task_id);
					}
					// Background shells get no Child Session: their output is not a
					// transcript (conduit-test-i7fy.9). Unknown task types may be
					// agents, so they keep one.
					if (firstStart && message.task_type !== "local_bash") {
						const childSessionId = deps.childSessionIdFor(
							message.task_id,
							message,
						);
						agents.set(toolUseId, {
							kind: "child",
							childSessionId,
							taskId: message.task_id,
						});
						newlyKnown.add(toolUseId);
						decisions.push({
							kind: "open-child",
							childSessionId,
							taskId: message.task_id,
							...tool,
							issuer: issuer.owner,
							description: message.description,
							...(message.task_type === undefined
								? {}
								: { taskType: message.task_type }),
						});
						feeds.set(message.task_id, childSessionId);
						decisions.push({
							kind: "start-feed",
							taskId: message.task_id,
							childSessionId,
						});
					}
					decisions.push({
						kind: "route",
						owner: issuer.owner,
						message,
						tool,
						...(receivedAt === undefined ? {} : { receivedAt }),
					});
					if (
						message.type === "system" &&
						"task_id" in message &&
						finishedTasks.has(message.task_id)
					) {
						finalRead(message.task_id);
					}
					return;
				}

				decisions.push({
					kind: "route",
					owner,
					message,
					...(receivedAt === undefined ? {} : { receivedAt }),
				});
				if (message.type === "result" && owner.kind === "parent") {
					for (const taskId of feeds.keys()) {
						if (listedTasks.has(taskId) && !liveTasks.has(taskId))
							finalRead(taskId);
					}
				}
				if (message.type === "assistant") {
					for (const block of message.message.content) {
						if (block.type === "tool_use") {
							registerIssuer(block.id, owner, message.uuid, block);
						}
					}
				} else if (
					message.type === "stream_event" &&
					owner.kind === "parent" &&
					message.event.type === "content_block_start" &&
					message.event.content_block.type === "tool_use"
				) {
					registerIssuer(
						message.event.content_block.id,
						owner,
						undefined,
						message.event.content_block,
					);
				}
				return;
			};

			if (input.kind === "transcript") {
				const toolUseId = tasks.get(input.taskId);
				const owner =
					toolUseId === undefined ? undefined : agents.get(toolUseId);
				if (owner === undefined) return decisions;
				const { childSessionId } = owner;
				// Stage the entire issuer batch before releasing lifecycle messages
				// below. One staging pass avoids cloning the cursor for every message.
				decisions.push({
					kind: "route-transcript",
					childSessionId,
					messages: input.messages,
				});
				for (const message of input.messages) {
					if (
						message.type !== "assistant" ||
						!isRecord(message.message) ||
						!Array.isArray(message.message["content"])
					)
						continue;
					for (const block of message.message["content"]) {
						if (
							isRecord(block) &&
							block["type"] === "tool_use" &&
							typeof block["id"] === "string"
						)
							registerIssuer(
								block["id"],
								owner,
								message.uuid,
								typeof block["name"] === "string"
									? { name: block["name"], input: block["input"] }
									: undefined,
							);
					}
				}
			} else {
				const awaiting = decideMessage(input.message, input.receivedAt);
				if (awaiting !== undefined)
					held.push({
						message: input.message,
						awaiting,
						...(input.receivedAt === undefined
							? {}
							: { receivedAt: input.receivedAt }),
					});
			}
			const ready = new Set<(typeof held)[number]>();
			while (true) {
				for (const entry of held) {
					if (newlyKnown.has(entry.awaiting)) ready.add(entry);
				}
				newlyKnown.clear();
				const entry = held.find((pending) => ready.has(pending));
				if (entry === undefined) break;
				ready.delete(entry);
				const awaiting = decideMessage(entry.message, entry.receivedAt);
				if (awaiting === undefined) held.splice(held.indexOf(entry), 1);
				else entry.awaiting = awaiting;
			}
			return decisions;
		},
	};
}
