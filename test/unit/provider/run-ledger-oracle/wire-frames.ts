/**
 * A trace as each provider's wire (CONTRACT.md 3592, the 32.2.17 row; A.19 option c at 5769-5770):
 * browser commands, main's provider calls the trace says happen, the frames that answer them, and
 * main's own writes, which are compared, never sent. Main's translators then make the events.
 *
 * How it could fail, written before the code:
 * 1. Silent drop: a fact maps to nothing, so a replay passes on a shorter trace. Every fact gets
 *    exactly one step, and a fact with no wire is an `unwired` step naming why.
 * 2. Wrong owner: a frame lands on another send's call. Frames name their token, and a token
 *    resolves to the input main sends (run_requested for OpenCode, run_dispatched for Claude).
 * 3. Invented ids: frames carry ids main never minted, so main's translator drops them. The
 *    OpenCode message id and session id are placeholders the replay fills from main's call.
 * 4. Reply in the wrong place: an effect_outcome is the reply to main's call, not a frame after
 *    it. The call step carries the token's first outcome; the outcome's own step only marks it.
 */
import type { SDKMessage } from "../../../../src/lib/provider/claude/types.js";
import type {
	Evidence,
	LedgerCommand,
	MainRunEvent,
} from "../../../../src/lib/provider/run-ledger/run-ledger-model.js";
import type { SSEEvent } from "../../../../src/lib/relay/opencode-events.js";
import {
	makeErrorResult,
	makeSuccessResult,
} from "../../../helpers/mock-sdk.js";
import { makeSSEEvent } from "../../../helpers/sse-factories.js";
import type { Trace } from "./traces.js";

export type WireProvider = "claude" | "opencode";

/** The RPCs a trace's admits and controls become, as the browser sends them. */
export type BrowserCommand =
	| {
			readonly rpc: "input.submit";
			readonly inputId: string;
			readonly text: string;
			readonly delivery: "queue" | "steer";
	  }
	| { readonly rpc: "input.sendNow"; readonly inputId: string }
	| { readonly rpc: "CancelSession"; readonly commandId: string }
	| { readonly rpc: "ReloadProviderSession"; readonly commandId: string }
	| {
			readonly rpc: "AnswerQuestion" | "RespondPermission";
			readonly commandId: string;
			readonly interactionId: string;
	  }
	| { readonly rpc: "StopBackgroundTask"; readonly taskId: string };

/** A provider call main makes that a trace answers. */
export type Call =
	| {
			readonly kind: "send";
			readonly inputId: string;
			readonly transmission: number;
	  }
	| { readonly kind: "stop" }
	| { readonly kind: "answer"; readonly interactionId: string };

/** The reply to a call: returned, refused with a status, or lost after it left. */
export type CallReply =
	| { readonly tag: "ok" }
	| { readonly tag: "refused"; readonly status: number; readonly code: string }
	| { readonly tag: "lost" };

/** Claude's wire: SDK messages, plus the stream's own acts the SDK has no message for. */
export type ClaudeFrame =
	| SDKMessage
	| {
			readonly tag: "ask";
			readonly toolUseID: string;
			readonly toolName: string;
			readonly input: Record<string, unknown>;
	  }
	/** The native side resolved the ask itself: the callback's signal aborts. */
	| { readonly tag: "withdraw"; readonly toolUseID: string }
	/** The SDK iterator throws. */
	| { readonly tag: "fail"; readonly code: string }
	/** The SDK iterator returns. */
	| { readonly tag: "end" };

export type Frames =
	| { readonly provider: "claude"; readonly frames: readonly ClaudeFrame[] }
	| { readonly provider: "opencode"; readonly frames: readonly SSEEvent[] };

/** One fact's wire, before its time and index. */
export type WireBody =
	/** The first process_started: the stack itself. */
	| { readonly kind: "start" }
	| {
			readonly kind: "browser";
			readonly command: BrowserCommand;
			/** A stop's or an answer's reply, from its control's first effect_outcome. */
			readonly reply: CallReply;
	  }
	/** Main makes this call here; the token's frames answer it. */
	| {
			readonly kind: "call";
			readonly token: string;
			readonly call: Call;
			readonly reply: CallReply;
	  }
	/** Frames for a token's call, or for the session (token null). */
	| ({ readonly kind: "frames"; readonly token: string | null } & Frames)
	/** An effect_outcome: already the reply of its call step. */
	| { readonly kind: "replied"; readonly token: string }
	/** Main's own write, compared by 32.2.17.2, never sent. */
	| { readonly kind: "main"; readonly event: MainRunEvent }
	| { readonly kind: "unwired"; readonly what: string; readonly why: string };

export type WireStep = {
	readonly at: number;
	readonly fact: number;
} & WireBody;

/** OpenCode ids main mints; the replay fills them from main's call (failure 3). */
export const placeholder = {
	session: "$session",
	message: "$message",
} as const;

/** Claude's native session id: the replay provider's own. */
export const nativeClaudeSession = "replay-native-session";

/**
 * Gap P5: main at R2 runs Claude in a runner process; the replay runs main's in-process session
 * runner, so a runner's own facts have no wire here (CONTRACT.md 3592 names main's real stack).
 */
const runnerHeld =
	"runner-held: the in-process Claude runner has no runner socket (gap P5)";

const outcomeReply = (
	outcome: Extract<Evidence, { kind: "effect_outcome" }>["outcome"],
): CallReply =>
	outcome.tag === "succeeded"
		? { tag: "ok" }
		: outcome.tag === "delivery_unknown"
			? { tag: "lost" }
			: outcome.tag === "retryable"
				? { tag: "refused", status: 429, code: outcome.code ?? "throttled" }
				: outcome.tag === "permanent"
					? { tag: "refused", status: 400, code: outcome.code }
					: // not_sent: the host never called, so main's call is refused before it leaves.
						{ tag: "refused", status: 503, code: "not_sent" };

const assistant = (id: string, text?: string): SDKMessage => ({
	type: "assistant",
	uuid: "00000000-0000-0000-0000-000000000001",
	session_id: nativeClaudeSession,
	parent_tool_use_id: null,
	message: {
		id,
		type: "message",
		role: "assistant",
		content:
			text === undefined ? [] : [{ type: "text", text, citations: null }],
		model: "claude-sonnet-4",
		stop_reason: null,
		stop_sequence: null,
		stop_details: null,
		container: null,
		context_management: null,
		diagnostics: null,
		usage: {
			input_tokens: 0,
			output_tokens: 0,
			cache_creation: null,
			cache_creation_input_tokens: null,
			cache_read_input_tokens: null,
			fallback_credit: null,
			inference_geo: null,
			iterations: null,
			output_tokens_details: null,
			server_tool_use: null,
			service_tier: null,
			speed: null,
		},
	},
});

const claudeResult = (
	evidence: Extract<Evidence, { kind: "result" }>,
	inputId: string | undefined,
): SDKMessage => {
	const owner = {
		session_id: nativeClaudeSession,
		...(inputId === undefined ? {} : { user_message_uuid: inputId }),
	};
	return evidence.outcome === "completed"
		? makeSuccessResult(owner)
		: makeErrorResult({
				...owner,
				errors: [
					evidence.outcome === "interrupted"
						? "interrupted"
						: (evidence.error?.code ?? "error"),
				],
			});
};

/**
 * Claude frames for one fact (nearest reading, gap P6: the contract names no frame per evidence
 * kind). started is the turn's first assistant frame; input_accepted is the CLI starting the
 * input's command, the receipt main and the ledger read as intake (run-ledger-decider.ts 1655).
 */
function claudeFrames(
	evidence: Evidence,
	inputId: string | undefined,
	turn: string,
): readonly ClaudeFrame[] | string {
	switch (evidence.kind) {
		case "started":
		case "turn_started":
			return [assistant(`${turn}-assistant`)];
		case "input_accepted":
			return inputId === undefined
				? "an acceptance with no input"
				: [
						{
							type: "command_lifecycle",
							state: "started",
							command_uuid: inputId,
							uuid: inputId,
							session_id: nativeClaudeSession,
						},
					];
		case "command_lifecycle":
			return [
				{
					type: "command_lifecycle",
					state: evidence.state,
					command_uuid: evidence.commandId,
					uuid: evidence.commandId,
					session_id: nativeClaudeSession,
				},
			];
		case "activity":
			return [assistant(`${turn}-assistant`, "working")];
		case "result":
			return [claudeResult(evidence, inputId)];
		case "turn_ended":
		case "command_result":
			return [makeSuccessResult({ session_id: nativeClaudeSession })];
		case "query_ended":
			return [{ tag: "end" }];
		case "interaction_requested":
			return [
				{
					tag: "ask",
					toolUseID: evidence.interactionId,
					...(evidence.interactionKind === "question"
						? {
								toolName: "AskUserQuestion",
								input: {
									questions: [
										{
											question: "Continue?",
											header: "Replay",
											options: [{ label: "yes" }, { label: "no" }],
											multiSelect: false,
										},
									],
								},
							}
						: { toolName: "Bash", input: { command: "true" } }),
				},
			];
		case "interaction_resolved":
			return [{ tag: "withdraw", toolUseID: evidence.interactionId }];
		case "runner_reply":
			return evidence.outcome.tag === "failed"
				? [{ tag: "fail", code: evidence.outcome.code }]
				: runnerHeld;
		case "tasks_snapshot":
			return [
				{
					type: "system",
					subtype: "background_tasks_changed",
					uuid: "00000000-0000-0000-0000-000000000003",
					session_id: nativeClaudeSession,
					tasks: evidence.tasks.map((task) => ({
						task_id: task.key.taskId,
						task_type: task.taskType,
						...(task.subagentType === undefined
							? {}
							: { subagent_type: task.subagentType }),
						description: task.description,
						ambient: task.ambient,
					})),
				},
			];
		case "task_event":
			return [
				evidence.event === "started" || evidence.event === "notification"
					? {
							type: "system",
							subtype: "task_started",
							uuid: "00000000-0000-0000-0000-000000000004",
							session_id: nativeClaudeSession,
							task_id: evidence.key.taskId,
							description: "replayed task",
						}
					: {
							type: "system",
							subtype: "task_notification",
							uuid: "00000000-0000-0000-0000-000000000005",
							session_id: nativeClaudeSession,
							task_id: evidence.key.taskId,
							status: evidence.event === "killed" ? "stopped" : evidence.event,
							output_file: "",
							summary: "replayed task",
						},
			];
		case "run_dispatched":
		case "run_released":
		case "delivery_indeterminate":
		case "journal_answer":
		case "effect_outcome":
			return runnerHeld;
		case "input_declined":
			return "Claude has no decline frame: a refused input is a runner reply (gap P6)";
		case "probe_result":
			return "a probe reads the native session and main records no finding (orchestration-side-effect-reactor.ts 1542)";
		case "accounting":
			return "accounting has no turn effect on main's read surface";
	}
}

/** OpenCode SSE frames for one fact (nearest reading, gap P6). */
function openCodeFrames(
	evidence: Evidence,
	assistantOpen: boolean,
): readonly SSEEvent[] | string {
	const sessionID = placeholder.session;
	const assistantId = `${placeholder.message}-assistant`;
	const openAssistant = assistantOpen
		? []
		: [
				makeSSEEvent("message.updated", {
					sessionID,
					info: {
						id: assistantId,
						parentID: placeholder.message,
						role: "assistant",
						time: { created: 1 },
					},
				}),
			];
	switch (evidence.kind) {
		case "started":
			return [
				makeSSEEvent("session.status", {
					sessionID,
					status: { type: "busy" },
				}),
			];
		case "input_accepted":
			return [
				makeSSEEvent("message.updated", {
					sessionID,
					info: { id: placeholder.message, role: "user", time: { created: 1 } },
				}),
				makeSSEEvent("message.part.updated", {
					sessionID,
					part: {
						id: `${placeholder.message}-text`,
						messageID: placeholder.message,
						type: "text",
						text: "replayed input",
					},
				}),
			];
		case "activity":
			return [
				...openAssistant,
				makeSSEEvent("message.part.updated", {
					sessionID,
					part: {
						id: `${assistantId}-tool`,
						messageID: assistantId,
						sessionID,
						type: "tool",
						callID: `${assistantId}-call`,
						tool: "bash",
						state: { status: "running", input: {}, time: { start: 1 } },
					},
				}),
			];
		case "result":
			return evidence.outcome === "completed"
				? [
						...openAssistant,
						makeSSEEvent("message.updated", {
							sessionID,
							info: {
								id: assistantId,
								parentID: placeholder.message,
								role: "assistant",
								time: { created: 1, completed: 2 },
							},
						}),
					]
				: [
						makeSSEEvent("session.error", {
							sessionID,
							error: {
								name:
									evidence.outcome === "interrupted"
										? "MessageAbortedError"
										: (evidence.error?.code ?? "UnknownError"),
								data: { message: "replayed" },
							},
						}),
					];
		case "query_ended":
			return [
				makeSSEEvent("session.status", {
					sessionID,
					status: { type: "idle" },
				}),
			];
		case "interaction_requested":
			return [
				evidence.interactionKind === "question"
					? makeSSEEvent("question.asked", {
							id: evidence.interactionId,
							sessionID,
							questions: [{ question: "Continue?", options: [] }],
						})
					: makeSSEEvent("permission.asked", {
							id: evidence.interactionId,
							sessionID,
							permission: "bash",
						}),
			];
		case "interaction_resolved":
			return [
				makeSSEEvent("question.replied", {
					sessionID,
					requestID: evidence.interactionId,
					answers: [],
				}),
			];
		case "input_declined":
		case "tasks_snapshot":
		case "task_event":
		case "turn_started":
		case "turn_ended":
		case "command_lifecycle":
		case "command_result":
		case "run_dispatched":
		case "run_released":
		case "delivery_indeterminate":
		case "runner_reply":
		case "journal_answer":
			return `OpenCode has no ${evidence.kind} frame`;
		case "effect_outcome":
			return "an outcome with no call to reply to";
		case "probe_result":
			return "a probe reads the native session and main records no finding (orchestration-side-effect-reactor.ts 1542)";
		case "accounting":
			return "accounting has no turn effect on main's read surface";
	}
}

/** The trace as provider's wire, one step per fact (failure 1). */
export function wireSteps(trace: Trace, provider: WireProvider): WireStep[] {
	const inputOfRun = new Map<string, string>();
	const runOfToken = new Map<string, string>();
	const sent = new Map<string, number>();
	const interactionKinds = new Map<string, "permission" | "question">();
	const openAssistants = new Set<string>();
	const firstOutcome = (token: string): CallReply => {
		for (const { command } of trace.steps)
			if (
				command.verb === "observe" &&
				command.observation.tag === "Answer" &&
				command.observation.token === token &&
				command.observation.kind === "effect_outcome"
			)
				return outcomeReply(command.observation.outcome);
		return { tag: "ok" };
	};
	let started = false;
	const step = (command: LedgerCommand): WireBody => {
		switch (command.verb) {
			case "admit":
				return {
					kind: "browser",
					command: {
						rpc: "input.submit",
						inputId: command.inputId,
						text: `${command.inputId} replayed input`,
						delivery: command.delivery,
					},
					reply: { tag: "ok" },
				};
			case "control": {
				const control = command.control;
				switch (control.kind) {
					case "stop":
						return {
							kind: "browser",
							command: { rpc: "CancelSession", commandId: control.commandId },
							reply: firstOutcome(`${control.commandId}:1`),
						};
					case "end":
						return {
							kind: "browser",
							command: {
								rpc: "ReloadProviderSession",
								commandId: control.commandId,
							},
							reply: firstOutcome(`${control.commandId}:1`),
						};
					case "run_now":
						return {
							kind: "browser",
							command: { rpc: "input.sendNow", inputId: control.inputId },
							reply: firstOutcome(`${control.commandId}:1`),
						};
					case "answer":
						return {
							kind: "browser",
							command: {
								rpc:
									interactionKinds.get(control.interactionId) === "permission"
										? "RespondPermission"
										: "AnswerQuestion",
								commandId: control.commandId,
								interactionId: control.interactionId,
							},
							reply: firstOutcome(`${control.commandId}:1`),
						};
					case "native_command":
						return {
							kind: "browser",
							command: {
								rpc: "input.submit",
								inputId: control.commandId,
								text: control.text,
								delivery: "queue",
							},
							reply: { tag: "ok" },
						};
					case "stop_tasks":
						return control.tasks === "all" || control.tasks.length !== 1
							? {
									kind: "unwired",
									what: "stop_tasks",
									why: "the browser stops one task per StopBackgroundTask",
								}
							: {
									kind: "browser",
									command: {
										rpc: "StopBackgroundTask",
										taskId: control.tasks[0]?.taskId ?? "",
									},
									reply: { tag: "ok" },
								};
				}
				// confirm_escalation.
				return {
					kind: "unwired",
					what: control.kind,
					why: "main has no escalation command",
				};
			}
			case "settle": {
				const settlement = command.settlement;
				if (settlement.kind === "process_started" && !started) {
					started = true;
					return { kind: "start" };
				}
				return {
					kind: "unwired",
					what: settlement.kind,
					why:
						settlement.kind === "alarm_fired"
							? "main's deadlines run on its own timers, not at the trace's time (gap P5)"
							: settlement.kind === "session_ended"
								? "no producer at 1ba91324 or 6c9ff950 (run-ledger-model.ts Settlement)"
								: provider === "claude"
									? runnerHeld
									: "the replay's OpenCode server is one process that is never lost (gap P5)",
				};
			}
			case "observe": {
				const observation = command.observation;
				if (observation.tag === "Main") {
					if (observation.kind === "run_requested")
						inputOfRun.set(observation.runId, observation.inputId);
					if (observation.kind !== "run_requested" || !observation.direct)
						return { kind: "main", event: observation };
					// 3.4: a direct run.requested is the transmission, its token the runId.
					const transmission = (sent.get(observation.runId) ?? 0) + 1;
					sent.set(observation.runId, transmission);
					return {
						kind: "call",
						token: observation.runId,
						call: {
							kind: "send",
							inputId: observation.inputId,
							transmission,
						},
						reply: firstOutcome(observation.runId),
					};
				}
				const token = observation.tag === "Answer" ? observation.token : null;
				if (observation.kind === "interaction_requested")
					interactionKinds.set(
						observation.interactionId,
						observation.interactionKind,
					);
				if (observation.kind === "run_dispatched" && token !== null) {
					runOfToken.set(token, observation.runId);
					return {
						kind: "call",
						token,
						call: {
							kind: "send",
							inputId: inputOfRun.get(observation.runId) ?? observation.runId,
							transmission: observation.transmission,
						},
						reply: { tag: "ok" },
					};
				}
				if (observation.kind === "effect_outcome" && token !== null)
					return { kind: "replied", token };
				const runId =
					token === null ? undefined : (runOfToken.get(token) ?? token);
				const inputId = runId === undefined ? undefined : inputOfRun.get(runId);
				const turn =
					observation.tag === "Answer"
						? observation.token
						: `${observation.label}-wake`;
				if (provider === "claude") {
					const frames = claudeFrames(observation, inputId, turn);
					return typeof frames === "string"
						? { kind: "unwired", what: observation.kind, why: frames }
						: { kind: "frames", token, provider, frames };
				}
				const frames = openCodeFrames(observation, openAssistants.has(turn));
				if (
					typeof frames !== "string" &&
					(observation.kind === "activity" || observation.kind === "result")
				)
					openAssistants.add(turn);
				return typeof frames === "string"
					? { kind: "unwired", what: observation.kind, why: frames }
					: { kind: "frames", token, provider, frames };
			}
		}
	};
	return trace.steps.map(
		({ command, now }, fact): WireStep => ({ at: now, fact, ...step(command) }),
	);
}
