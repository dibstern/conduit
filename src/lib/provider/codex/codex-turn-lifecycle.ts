import type { ProviderRuntimeEvent } from "../../contracts/providers/provider-runtime-event.js";
import type { SessionGoalChangedPayload } from "../../contracts/stored-event.js";
import { isRecord } from "../../utils.js";
import type { TurnError, TurnErrorCode, TurnTokens } from "../types.js";
import type { KnownNotification } from "./app-server/protocol.js";
import {
	type CodexItemState,
	codexRuntimeEvent,
	mapCodexItem,
	recordCodexTurnRefs,
	settleCodexItems,
} from "./codex-item-mapper.js";

export interface CodexTurnState {
	readonly acceptedTurnId?: string | undefined;
	readonly executingTurnId?: string | undefined;
	readonly settled: boolean;
	readonly startedAt: number;
	readonly items: CodexItemState;
	readonly goalState: SessionGoalChangedPayload;
	readonly goalActive: boolean;
	readonly successorDeadline?: number | undefined;
	readonly goalActivationPending?: boolean;
	readonly interruptRequested?: boolean;
	readonly manualCompaction?: boolean;
	readonly compactions?: readonly {
		readonly id: string;
		readonly completed: boolean;
	}[];
}

// Tests shorten the successor deadline in the detached runner process.
export const CODEX_GOAL_SUCCESSOR_TIMEOUT_MS =
	process.env["NODE_ENV"] === "test"
		? Number(
				process.env["CONDUIT_TEST_CODEX_GOAL_SUCCESSOR_TIMEOUT_MS"] ?? 30_000,
			)
		: 30_000;

export function parseCodexGoalCommand(text: string) {
	const match = /^[/$]goal(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (!match) return undefined;
	const argument = (match[1] ?? "").trim();
	if (!argument || argument === "edit") return { type: "show" } as const;
	if (argument === "pause" || argument === "clear" || argument === "resume")
		return { type: argument };
	return { type: "set", objective: argument } as const;
}

export interface CodexTurnUpdate {
	readonly state: CodexTurnState;
	readonly events: readonly ProviderRuntimeEvent[];
	readonly diagnostic?: {
		readonly event: "codex.turn_ignored";
		readonly turnId: string;
		readonly expectedTurnId?: string | undefined;
	};
	readonly outcome?: {
		readonly status: "completed" | "interrupted" | "error";
		readonly tokens: TurnTokens;
		readonly error?: TurnError;
	};
}

export function createCodexTurnState(input: {
	readonly sessionId: string;
	readonly runId?: string | undefined;
	readonly turnId: string;
	readonly messageId: string;
	readonly providerId: string;
	readonly threadId: string;
	readonly now: number;
	readonly tokenUsageBaseline?: CodexItemState["tokenUsageBaseline"];
	readonly goalState?: SessionGoalChangedPayload;
}): CodexTurnState {
	return {
		settled: false,
		startedAt: input.now,
		goalState: input.goalState ?? { sessionId: input.sessionId, goal: null },
		goalActive:
			!!input.goalState?.goal && input.goalState.pausedReason === undefined,
		items: {
			...input,
			sequence: 0,
			parts: [],
			tokens: { input: 0, output: 0 },
		},
	};
}

export function acceptCodexTurn(
	state: CodexTurnState,
	acceptedId: string,
	startedAt?: number | null,
): CodexTurnState {
	return {
		...state,
		acceptedTurnId: acceptedId,
		...(typeof startedAt === "number" ? { executingTurnId: acceptedId } : {}),
		items: { ...state.items, nativeTurnId: acceptedId },
	};
}

/** The runner queues notifications until turn/start has supplied the accepted id. */
export function handleCodexTurnNotification(
	state: CodexTurnState,
	notification: KnownNotification,
	now = state.items.now,
): CodexTurnUpdate {
	const update = handleNotification(state, notification, now);
	if (
		!state.settled &&
		!update.diagnostic &&
		(notification.method === "turn/started" ||
			notification.method === "turn/completed") &&
		notification.params.threadId === state.items.threadId &&
		notification.params.turn.id === update.state.items.nativeTurnId
	) {
		const refs = recordCodexTurnRefs(
			update.state.items,
			notification.method === "turn/completed",
		);
		return {
			...update,
			state: { ...update.state, items: refs.items },
			events: [...refs.events, ...update.events],
		};
	}
	return update;
}

function handleNotification(
	state: CodexTurnState,
	notification: KnownNotification,
	now = state.items.now,
): CodexTurnUpdate {
	const params = notification.params;
	if (
		"threadId" in params &&
		params.threadId &&
		params.threadId !== state.items.threadId
	)
		return { state, events: [] };
	if (state.settled) return { state, events: [] };
	let next: CodexTurnState = { ...state, items: { ...state.items, now } };
	// Goal updates can refer to the just-completed turn, or have no turn id.
	if (
		notification.method === "thread/goal/updated" ||
		notification.method === "thread/goal/cleared"
	) {
		const previous = state.goalState.goal ?? state.goalState.endedGoal;
		let facts: SessionGoalChangedPayload;
		let active = false;
		if (notification.method === "thread/goal/cleared") {
			facts = {
				sessionId: state.items.sessionId,
				goal: null,
				ended: "cleared",
				endedAt: now,
				...(previous ? { endedGoal: previous } : {}),
			};
		} else {
			const native = notification.params.goal;
			const same =
				previous?.condition === native.objective &&
				previous.setAt === native.createdAt * 1000;
			const goal = same
				? previous
				: {
						condition: native.objective,
						iterations: 0,
						setAt: native.createdAt * 1000,
						tokensAtStart: 0,
					};
			active = native.status === "active";
			facts =
				native.status === "complete"
					? {
							sessionId: state.items.sessionId,
							goal: null,
							ended: "met",
							endedGoal: {
								...goal,
								iterations: goal.iterations + (state.executingTurnId ? 1 : 0),
							},
							endedAt: now,
						}
					: {
							sessionId: state.items.sessionId,
							goal,
							...(!active
								? {
										pausedReason:
											native.status === "paused"
												? "Paused"
												: native.status === "blocked"
													? "Blocked"
													: native.status === "usageLimited"
														? "Usage limit reached"
														: native.status === "budgetLimited"
															? "Goal budget reached"
															: native.status,
									}
								: {}),
						};
		}
		if (state.interruptRequested && facts.goal && !active)
			facts = { ...facts, pausedReason: "Interrupted" };
		next = {
			...next,
			goalState: facts,
			goalActive: active,
			...(active ? { goalActivationPending: false } : {}),
		};
		const [items, event] = codexRuntimeEvent(
			next.items,
			"session.goal_changed",
			facts,
		);
		next = { ...next, items };
		const update =
			!active &&
			state.goalActive &&
			!state.executingTurnId &&
			!state.goalActivationPending &&
			!state.interruptRequested
				? settle(next, "completed")
				: { state: next, events: [] };
		return { ...update, events: [event, ...update.events] };
	}
	const expired = expireCodexGoalSuccessor(next, now);
	if (expired.outcome) return expired;
	const nativeTurnId =
		"turn" in params
			? params.turn.id
			: "turnId" in params
				? params.turnId
				: undefined;
	const successor =
		notification.method === "turn/started" &&
		notification.params.turn.id !== state.items.nativeTurnId &&
		(state.goalActive ||
			state.goalActivationPending ||
			state.interruptRequested) &&
		state.successorDeadline !== undefined;
	// compact/start acknowledges with {}, so its native id arrives in turn/started.
	if (
		next.manualCompaction &&
		!next.items.nativeTurnId &&
		notification.method === "turn/started"
	)
		next = acceptCodexTurn(
			next,
			notification.params.turn.id,
			notification.params.turn.startedAt,
		);
	if (
		notification.method === "turn/started" &&
		state.successorDeadline !== undefined &&
		!successor
	)
		return { state, events: [] };
	if (nativeTurnId && nativeTurnId !== next.items.nativeTurnId && !successor) {
		// thread/resume can publish the previous turn's cumulative usage before
		// the new turn begins. It seeds accounting without becoming turn output.
		if (
			notification.method === "thread/tokenUsage/updated" &&
			!state.items.tokenUsageTotal
		)
			return {
				state: {
					...next,
					items: {
						...next.items,
						tokenUsageBaseline: notification.params.tokenUsage.total,
					},
				},
				events: [],
			};
		return {
			state,
			events: [],
			diagnostic: {
				event: "codex.turn_ignored",
				turnId: nativeTurnId,
				expectedTurnId: state.items.nativeTurnId,
			},
		};
	}
	// The deprecated notification accompanies the item completion. Only the item
	// owns the boundary, including compaction inside an ordinary turn.
	if (notification.method === "thread/compacted")
		return { state: next, events: [] };
	if (
		(notification.method === "item/started" ||
			notification.method === "item/completed") &&
		notification.params.item.type === "contextCompaction"
	) {
		const id = notification.params.item.id;
		const previous = next.compactions?.find((item) => item.id === id);
		const completed = notification.method === "item/completed";
		if (previous?.completed || (previous && !completed))
			return { state: next, events: [] };
		const [items, event] = codexRuntimeEvent(
			next.items,
			"session.compaction",
			{
				sessionId: next.items.sessionId,
				state: completed ? "completed" : "started",
				detail: completed
					? `Context compacted${next.manualCompaction ? "" : " (auto)"}`
					: "Compacting conversation…",
			},
			id,
		);
		return {
			state: {
				...next,
				items,
				compactions: [
					...(next.compactions ?? []).filter((item) => item.id !== id),
					{ id, completed },
				],
			},
			events: [event],
		};
	}
	if (notification.method === "turn/started")
		next = {
			...next,
			executingTurnId: notification.params.turn.id,
			successorDeadline: undefined,
			items: { ...next.items, nativeTurnId: notification.params.turn.id },
		};
	if (notification.method === "turn/completed") {
		const { status, error } = notification.params.turn;
		if (state.successorDeadline !== undefined) return { state, events: [] };
		next = { ...next, executingTurnId: undefined };
		if (
			status === "completed" &&
			!state.interruptRequested &&
			!next.manualCompaction &&
			(next.goalActive || next.goalActivationPending)
		) {
			const [items, events] = settleCodexItems(next.items);
			const goal = next.goalState.goal;
			return {
				state: {
					...next,
					items,
					successorDeadline: now + CODEX_GOAL_SUCCESSOR_TIMEOUT_MS,
					goalState: goal
						? {
								...next.goalState,
								goal: { ...goal, iterations: goal.iterations + 1 },
							}
						: next.goalState,
				},
				events,
			};
		}
		if (status === "completed") return settle(next, "completed");
		if (status === "interrupted") return interruptCodexTurn(next, now);
		const info = error?.codexErrorInfo;
		// Codex serializes unit variants as camelCase strings, data variants
		// as { camelCaseVariant: { httpStatusCode } }. Unknown variants stay open.
		const variant =
			typeof info === "string"
				? info
				: isRecord(info)
					? Object.keys(info)[0]
					: undefined;
		const details = isRecord(info) && variant ? info[variant] : undefined;
		const final429 = isRecord(details) && details["httpStatusCode"] === 429;
		const code: TurnErrorCode =
			variant === "unauthorized" || variant === "Unauthorized"
				? "auth_required"
				: variant === "usageLimitExceeded" || final429
					? "usage_limited"
					: variant === "contextWindowExceeded"
						? "context_overflow"
						: variant === "httpConnectionFailed" ||
								variant === "responseStreamDisconnected"
							? "provider_unavailable"
							: "provider_error";
		return settle(next, "error", {
			code,
			message: error?.message ?? `Codex turn ended with status ${status}`,
			retryable: code === "provider_unavailable",
		});
	}
	const [items, events] = mapCodexItem(next.items, notification);
	return { state: { ...next, items }, events };
}

export function expireCodexGoalSuccessor(
	state: CodexTurnState,
	now = state.items.now,
): CodexTurnUpdate {
	return state.successorDeadline !== undefined && now >= state.successorDeadline
		? settle({ ...state, items: { ...state.items, now } }, "completed")
		: { state, events: [] };
}

export function completeCodexTurn(state: CodexTurnState): CodexTurnUpdate {
	return settle(state, "completed");
}

export function interruptCodexTurn(
	state: CodexTurnState,
	now: number,
): CodexTurnUpdate {
	if (state.settled) return { state, events: [] };
	const goal = state.goalState.goal;
	const facts = { ...state.goalState, pausedReason: "Interrupted" };
	const [items, event] = goal
		? codexRuntimeEvent({ ...state.items, now }, "session.goal_changed", facts)
		: [state.items, undefined];
	const update = settle(
		{
			...state,
			items: { ...items, now },
			goalActive: false,
			...(goal ? { goalState: facts } : {}),
		},
		"interrupted",
	);
	return { ...update, events: [...(event ? [event] : []), ...update.events] };
}

export function failCodexTurn(
	state: CodexTurnState,
	code: TurnErrorCode,
	message: string,
	now = state.items.now,
): CodexTurnUpdate {
	return settle({ ...state, items: { ...state.items, now } }, "error", {
		code,
		message,
		retryable: code === "provider_unavailable",
	});
}

function settle(
	state: CodexTurnState,
	status: "completed" | "interrupted" | "error",
	error?: TurnError,
): CodexTurnUpdate {
	if (state.settled) return { state, events: [] };
	let [closedItems, events] = settleCodexItems(state.items);
	if (
		status === "error" &&
		(state.manualCompaction ||
			state.compactions?.some((item) => !item.completed))
	) {
		const [items, failure] = codexRuntimeEvent(
			closedItems,
			"session.compaction",
			{
				sessionId: closedItems.sessionId,
				state: "failed",
				detail: `Compaction failed: ${error?.message ?? "Codex turn failed"}`,
			},
		);
		closedItems = items;
		events = [...events, failure];
	}
	const [items, terminal] =
		status === "completed"
			? codexRuntimeEvent(closedItems, "turn.completed", {
					messageId: closedItems.messageId,
					providerSessionId: closedItems.threadId,
					tokens: closedItems.tokens,
					duration: closedItems.now - state.startedAt,
					...(closedItems.contextTokens !== undefined
						? { contextTokens: closedItems.contextTokens }
						: {}),
				})
			: status === "interrupted"
				? codexRuntimeEvent(closedItems, "turn.interrupted", {
						messageId: closedItems.messageId,
					})
				: codexRuntimeEvent(closedItems, "turn.error", {
						messageId: closedItems.messageId,
						error: error?.message ?? "Codex turn failed",
						code: error?.code ?? "provider_error",
						retryable: error?.retryable ?? false,
						retryHandled: true,
					});
	return {
		state: {
			...state,
			items,
			settled: true,
			executingTurnId: undefined,
			successorDeadline: undefined,
		},
		events: [...events, terminal],
		outcome: { status, tokens: items.tokens, ...(error ? { error } : {}) },
	};
}
