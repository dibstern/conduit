// Decides which session owns each Claude SDK message (spec conduit-test-i7fy).
// Rule: the parent owns only the tool calls it issued itself. A message about
// any other tool call belongs to the session that issued that call, and is
// held until that session is known. Nothing defaults to the parent.
//
// Pure: no I/O, no clock. The caller carries out the decisions.

import type { SDKMessage } from "./types.js";

export type ClaudeMessageOwner =
	| { readonly kind: "parent" }
	| { readonly kind: "child"; readonly childSessionId: string };

export type ClaudeOwnershipInput =
	| { readonly kind: "sdk"; readonly message: SDKMessage }
	// The stream ended or the Claude process restarted: held messages are
	// dropped, since their owners can no longer become known.
	| { readonly kind: "end" };

export type ClaudeOwnershipDecision =
	| {
			readonly kind: "route";
			readonly owner: ClaudeMessageOwner;
			readonly message: SDKMessage;
			// For task and tool progress messages: the tool call the message is
			// about, and the uuid of the SDK message that issued it.
			readonly tool?: {
				readonly toolUseId: string;
				readonly issuingMessageId?: string;
			};
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
			readonly kind: "drop";
			readonly message: SDKMessage;
			readonly reason: string;
	  };

export interface ClaudeMessageOwnership {
	// Decisions come back in the order to carry them out. A message that
	// makes an owner known is followed by the held messages it releases, in
	// arrival order.
	decide(input: ClaudeOwnershipInput): readonly ClaudeOwnershipDecision[];
}

export function createClaudeMessageOwnership(deps: {
	// The Child Session id for a task; stable for the same task.
	readonly childSessionIdFor: (taskId: string, message: SDKMessage) => string;
}): ClaudeMessageOwnership {
	const parent: ClaudeMessageOwner = { kind: "parent" };
	const issuers = new Map<
		string,
		{ owner: ClaudeMessageOwner; issuingMessageId?: string }
	>();
	const agents = new Map<string, string>();
	const tasks = new Map<string, string>();
	const opened = new Set<string>();
	const held: { message: SDKMessage; awaiting: string }[] = [];

	return {
		decide(input) {
			if (input.kind === "end") {
				return held.splice(0).map(({ message, awaiting }) => ({
					kind: "drop",
					message,
					reason: `Claude stream ended while awaiting ownership of ${awaiting}`,
				}));
			}

			const decisions: ClaudeOwnershipDecision[] = [];
			const newlyKnown = new Set<string>();
			const hold = (message: SDKMessage, awaiting: string) => {
				decisions.push({ kind: "hold", message, awaiting });
				return awaiting;
			};
			const registerIssuer = (
				toolUseId: string,
				owner: ClaudeMessageOwner,
				issuingMessageId?: string,
			) => {
				const issuer = issuers.get(toolUseId);
				const uuid = issuingMessageId ?? issuer?.issuingMessageId;
				issuers.set(
					toolUseId,
					uuid === undefined ? { owner } : { owner, issuingMessageId: uuid },
				);
				if (issuer === undefined) newlyKnown.add(toolUseId);
			};
			const decideMessage = (message: SDKMessage): string | undefined => {
				let owner: ClaudeMessageOwner = parent;
				let toolUseId: string | undefined;

				switch (message.type) {
					case "assistant":
					case "user":
					case "stream_event": {
						const parentToolUseId = message.parent_tool_use_id ?? undefined;
						if (parentToolUseId !== undefined) {
							const childSessionId = agents.get(parentToolUseId);
							if (childSessionId === undefined) {
								return hold(message, parentToolUseId);
							}
							owner = { kind: "child", childSessionId };
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
					if (
						message.type === "system" &&
						message.subtype === "task_started" &&
						!opened.has(message.task_id)
					) {
						const childSessionId = deps.childSessionIdFor(
							message.task_id,
							message,
						);
						opened.add(message.task_id);
						tasks.set(message.task_id, toolUseId);
						agents.set(toolUseId, childSessionId);
						newlyKnown.add(message.task_id);
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
					}
					decisions.push({ kind: "route", owner: issuer.owner, message, tool });
					return;
				}

				decisions.push({ kind: "route", owner, message });
				if (message.type === "assistant") {
					for (const block of message.message.content) {
						if (block.type === "tool_use") {
							registerIssuer(block.id, owner, message.uuid);
						}
					}
				} else if (
					message.type === "stream_event" &&
					owner.kind === "parent" &&
					message.event.type === "content_block_start" &&
					message.event.content_block.type === "tool_use"
				) {
					registerIssuer(message.event.content_block.id, owner);
				}
				return;
			};

			const awaiting = decideMessage(input.message);
			if (awaiting !== undefined)
				held.push({ message: input.message, awaiting });
			const ready = new Set<(typeof held)[number]>();
			while (true) {
				for (const entry of held) {
					if (newlyKnown.has(entry.awaiting)) ready.add(entry);
				}
				newlyKnown.clear();
				const entry = held.find((pending) => ready.has(pending));
				if (entry === undefined) break;
				ready.delete(entry);
				const awaiting = decideMessage(entry.message);
				if (awaiting === undefined) held.splice(held.indexOf(entry), 1);
				else entry.awaiting = awaiting;
			}
			return decisions;
		},
	};
}
