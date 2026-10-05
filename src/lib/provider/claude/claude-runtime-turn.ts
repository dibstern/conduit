import type { UUID } from "node:crypto";
import { Deferred, Effect, HashMap, Ref } from "effect";
import type { SendTurnInput, TurnResult } from "../types.js";
import { isInterruptedResult } from "./claude-event-translator.js";
import type { ClaudeProviderRuntimeState } from "./claude-provider-runtime.js";
import {
	getOrUndefined,
	getSession,
	getState,
} from "./claude-runtime-state.js";
import type {
	ClaudeSessionContext,
	SDKResultMessage,
	SDKUserMessage,
} from "./types.js";

/**
 * A sent input awaiting its result. Map order is start order: a waiter moves
 * to the end when the SDK starts it, so the last started one owns a result.
 */
export interface TurnWaiter {
	readonly deferred: Deferred.Deferred<TurnResult, Error>;
	readonly started: boolean;
	/** A held send's message, placed when the SDK starts the input. */
	readonly unplaced?: SendTurnInput;
}

export type TurnWaiters = ReadonlyMap<string, TurnWaiter>;

const zeroTurnResult = (status: TurnResult["status"]): TurnResult => ({
	status,
	cost: 0,
	tokens: { input: 0, output: 0 },
	durationMs: 0,
	providerStateUpdates: [],
});

function updateTurnWaiters<A>(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
	f: (waiters: TurnWaiters) => readonly [A, TurnWaiters],
): Effect.Effect<A> {
	return Ref.modify(stateRef, (state) => {
		const [value, waiters] = f(
			getOrUndefined(HashMap.get(state.turnWaiters, sessionId)) ?? new Map(),
		);
		return [
			value,
			{
				...state,
				turnWaiters:
					waiters.size === 0
						? HashMap.remove(state.turnWaiters, sessionId)
						: HashMap.set(state.turnWaiters, sessionId, waiters),
			},
		];
	});
}

export function addTurnWaiter(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
	inputId: string,
	waiter: TurnWaiter,
): Effect.Effect<void> {
	return updateTurnWaiters(stateRef, sessionId, (waiters) => [
		undefined,
		new Map(waiters).set(inputId, waiter),
	]);
}

function takeTurnWaiters(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
	pick: (waiters: TurnWaiters) => readonly string[],
): Effect.Effect<ReadonlyArray<readonly [string, TurnWaiter]>> {
	return updateTurnWaiters(stateRef, sessionId, (waiters) => {
		const rest = new Map(waiters);
		const taken = pick(waiters).flatMap((id) => {
			const waiter = waiters.get(id);
			rest.delete(id);
			return waiter ? [[id, waiter] as const] : [];
		});
		return [taken, rest];
	});
}

export function removeTurnWaiter(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
	inputId: string,
): Effect.Effect<void> {
	return Effect.asVoid(takeTurnWaiters(stateRef, sessionId, () => [inputId]));
}

export function pendingTurnWaiters(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
): Effect.Effect<TurnWaiters> {
	return Effect.map(
		getState(stateRef),
		(state) =>
			getOrUndefined(HashMap.get(state.turnWaiters, sessionId)) ?? new Map(),
	);
}

export function hasPendingTurn(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
): Effect.Effect<boolean> {
	return Effect.map(
		pendingTurnWaiters(stateRef, sessionId),
		(waiters) => waiters.size > 0,
	);
}

/** The input a result without uuids (older SDKs) answers. */
function currentInputId(
	ctx: ClaudeSessionContext,
	waiters: TurnWaiters,
): string[] {
	if (ctx.currentTurnId && waiters.has(ctx.currentTurnId))
		return [ctx.currentTurnId];
	const first = waiters.keys().next();
	return first.done ? [] : [first.value];
}

/**
 * `command_lifecycle: started`: marks the input started (moving it to the end
 * of start order) and hands back its still-unplaced message, once.
 */
export function startTurnWaiter(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
	inputId: string,
): Effect.Effect<SendTurnInput | undefined> {
	return updateTurnWaiters(stateRef, sessionId, (waiters) => {
		const waiter = waiters.get(inputId);
		if (!waiter) return [undefined, waiters];
		const rest = new Map(waiters);
		rest.delete(inputId);
		rest.set(inputId, { deferred: waiter.deferred, started: true });
		return [waiter.unplaced, rest];
	});
}

/** `command_lifecycle: cancelled` before `started` resolves the input cancelled. */
export function cancelTurnWaiterEffect(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
	inputId: string,
): Effect.Effect<void> {
	return Effect.gen(function* () {
		const taken = yield* takeTurnWaiters(stateRef, sessionId, (waiters) =>
			waiters.get(inputId)?.started === false ? [inputId] : [],
		);
		for (const [, waiter] of taken)
			yield* Deferred.succeed(waiter.deferred, zeroTurnResult("cancelled"));
	});
}

export function rejectTurnIfPendingEffect(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	ctx: ClaudeSessionContext,
	err: Error,
): Effect.Effect<void> {
	return Effect.gen(function* () {
		const current = yield* getSession(stateRef, ctx.sessionId);
		if (current !== ctx) return;

		const taken = yield* takeTurnWaiters(stateRef, ctx.sessionId, (waiters) =>
			currentInputId(ctx, waiters),
		);
		for (const [, waiter] of taken) yield* Deferred.fail(waiter.deferred, err);
	});
}

/**
 * Settles every input a result covers: the latest one started gets the
 * result, the rest resolve `joined`. A result without uuids answers the
 * current input.
 */
export function resolveTurnEffect(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	ctx: ClaudeSessionContext,
	result: SDKResultMessage,
): Effect.Effect<void> {
	return Effect.gen(function* () {
		const covered =
			result.user_message_uuids ??
			(result.user_message_uuid ? [result.user_message_uuid] : undefined);
		const taken = yield* takeTurnWaiters(stateRef, ctx.sessionId, (waiters) =>
			covered
				? [...waiters.keys()].filter((id) => covered.includes(id))
				: currentInputId(ctx, waiters),
		);
		const owner =
			[...taken].reverse().find(([, waiter]) => waiter.started) ?? taken.at(-1);
		if (!owner) return;
		ctx.turnCount++;
		const turnResult = sdkResultToTurnResult(ctx, result);
		for (const [id, waiter] of taken)
			yield* Deferred.succeed(
				waiter.deferred,
				id === owner[0] ? turnResult : zeroTurnResult("joined"),
			);
	});
}

export function resolveErrorTurnEffect(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	ctx: ClaudeSessionContext,
	err: unknown,
): Effect.Effect<void> {
	return Effect.gen(function* () {
		const taken = yield* takeTurnWaiters(stateRef, ctx.sessionId, (waiters) =>
			currentInputId(ctx, waiters),
		);
		// Build an error TurnResult rather than rejecting the promise,
		// so the caller gets a structured response.
		const errorMsg = err instanceof Error ? err.message : String(err);
		for (const [, waiter] of taken)
			yield* Deferred.succeed(waiter.deferred, {
				...zeroTurnResult("error"),
				error: { code: "provider_error", message: errorMsg },
			});
	});
}

export function sdkResultToTurnResult(
	ctx: ClaudeSessionContext,
	result: SDKResultMessage,
): TurnResult {
	// is_error=true can appear on success-subtype results when the SDK
	// wraps an upstream API error (e.g. "unknown provider for model X",
	// 502s after all retries) as a synthetic successful completion.
	// Treat those as errors so the caller sees failure, not success.
	const isErrorFlag = result.is_error;
	const isSuccess = result.subtype === "success" && !isErrorFlag;
	const isInterrupted = !isSuccess && isInterruptedResult(result);
	// Error text source depends on result shape:
	//  - error_during_execution (and other non-success subtypes): `errors` array
	//  - success + is_error=true: `result` field contains the provider error text
	const errorsField = result.subtype === "success" ? undefined : result.errors;
	const resultField = result.subtype === "success" ? result.result : undefined;
	const errorMessage =
		Array.isArray(errorsField) && errorsField.length > 0
			? errorsField.join("; ")
			: typeof resultField === "string" && resultField.length > 0
				? resultField
				: "Unknown error";
	let status: TurnResult["status"] = "error";
	if (isSuccess) status = "completed";
	else if (isInterrupted) status = "interrupted";
	return {
		status,
		cost: result.total_cost_usd ?? 0,
		tokens: {
			input: result.usage?.input_tokens ?? 0,
			output: result.usage?.output_tokens ?? 0,
			...(result.usage?.cache_read_input_tokens != null
				? { cacheRead: result.usage.cache_read_input_tokens }
				: {}),
		},
		durationMs: result.duration_ms ?? 0,
		...(!isSuccess && !isInterrupted
			? {
					error: {
						code: "provider_error" as const,
						message: errorMessage,
					},
				}
			: {}),
		providerStateUpdates: [
			...(ctx.configDir
				? [{ key: "claudeConfigDir", value: ctx.configDir }]
				: []),
			...(ctx.resumeSessionId
				? [
						{
							key: "resumeSessionId",
							value: ctx.resumeSessionId,
						},
					]
				: []),
			...(ctx.lastAssistantUuid
				? [
						{
							key: "lastAssistantUuid",
							value: ctx.lastAssistantUuid,
						},
					]
				: []),
			{ key: "turnCount", value: ctx.turnCount },
		],
	};
}

export function buildUserMessage(input: SendTurnInput): SDKUserMessage {
	// Build content blocks matching the Anthropic SDK's MessageParam.content
	// structure. Uses 'as const' for literal type narrowing.
	const content: Array<
		| { type: "text"; text: string }
		| {
				type: "image";
				source: {
					type: "base64";
					media_type: "image/png";
					data: string;
				};
		  }
	> = [];
	if (input.images) {
		for (const img of input.images) {
			content.push({
				type: "image" as const,
				source: {
					type: "base64" as const,
					media_type: "image/png" as const,
					data: img,
				},
			});
		}
	}
	content.push({ type: "text" as const, text: input.prompt });
	// The input id is the SDK message uuid, so lifecycle frames and results
	// name the input they belong to.
	return {
		type: "user",
		message: { role: "user" as const, content },
		parent_tool_use_id: null,
		// Input ids are browser-minted UUIDs; the SDK types the field as one.
		uuid: input.inputId as UUID,
		priority: "next",
	};
}

export function settleQueuedTurnDeferredsEffect(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
	outcome: string | TurnResult,
): Effect.Effect<void, never> {
	return Effect.gen(function* () {
		const taken = yield* takeTurnWaiters(stateRef, sessionId, (waiters) => [
			...waiters.keys(),
		]);
		for (const [, waiter] of taken) {
			yield* (
				typeof outcome === "string"
					? Deferred.fail(waiter.deferred, new Error(outcome))
					: Deferred.succeed(waiter.deferred, outcome)
			).pipe(Effect.ignore);
		}
	});
}
