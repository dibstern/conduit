import { Effect } from "effect";
import { isRecord } from "../../utils.js";
import type { EventSinkError } from "../event-sink-errors.js";
import { claudeRuntimeEvent } from "./claude-runtime-event.js";
import type {
	ClaudeSessionContext,
	SDKMessage,
	SDKResultSuccess,
} from "./types.js";

/** Emit a known limit or a deferred fallback; repeats retain the intake tuple. */
export const emitClaudeUsageLimit = (
	ctx: ClaudeSessionContext,
	repeated = false,
): Effect.Effect<void, EventSinkError> =>
	Effect.gen(function* () {
		if (
			!ctx.usageLimit ||
			(ctx.usageLimitReported && !repeated) ||
			!ctx.eventSink ||
			!ctx.currentUserMessageId
		)
			return;
		yield* ctx.eventSink.push(
			claudeRuntimeEvent("session.usage_limited", ctx.sessionId, {
				instanceId: ctx.instanceId ?? "claude",
				...ctx.usageLimit,
				cutOffMessageId: ctx.currentUserMessageId,
			}),
		);
		ctx.usageLimitReported = true;
	});

/** Filter limit replies before the translator, leaving result finalization intact. */
export const interceptClaudeUsageLimit = (
	ctx: ClaudeSessionContext,
	message: SDKMessage,
): Effect.Effect<readonly SDKMessage[], EventSinkError> =>
	Effect.gen(function* () {
		const rejected =
			message.type === "rate_limit_event" &&
			isRecord(message.rate_limit_info) &&
			message.rate_limit_info.status === "rejected";
		const limitAssistant =
			message.type === "assistant" && message.error === "rate_limit";
		const limitResult =
			message.type === "result" && message.terminal_reason === "blocking_limit";
		if (rejected || limitAssistant || limitResult) {
			ctx.pendingSyntheticMessages = undefined;
			const info =
				rejected && message.type === "rate_limit_event"
					? message.rate_limit_info
					: undefined;
			// Once reported, preserve the intake tuple so late background notices
			// cannot turn an unknown fallback into a second limit for this prompt.
			if (!ctx.usageLimitReported)
				ctx.usageLimit = {
					rateLimitType:
						info?.rateLimitType ?? ctx.usageLimit?.rateLimitType ?? "unknown",
					...(info?.resetsAt !== undefined
						? { resetsAt: info.resetsAt }
						: ctx.usageLimit?.resetsAt !== undefined
							? { resetsAt: ctx.usageLimit.resetsAt }
							: {}),
				};
		}
		// A metadata-free assistant error waits for the result (or stream end),
		// allowing a rejected notice to supply its type/reset time first.
		if (rejected || (message.type === "result" && ctx.usageLimit))
			yield* emitClaudeUsageLimit(ctx, rejected);
		if (message.type === "rate_limit_event" || limitAssistant) return [];
		if (message.type === "stream_event" && message.parent_tool_use_id == null) {
			if (ctx.usageLimit) return [];
			if (
				message.event.type === "message_start" &&
				message.event.message.model === "<synthetic>"
			)
				ctx.pendingSyntheticMessages ??= [];
			if (ctx.pendingSyntheticMessages) {
				ctx.pendingSyntheticMessages.push(message);
				return [];
			}
		}
		if (
			message.type === "assistant" &&
			message.parent_tool_use_id == null &&
			isRecord(message.message) &&
			message.message.model === "<synthetic>"
		) {
			if (ctx.usageLimit) return [];
			// A blocking result can be the first limit signal. Keep both the
			// snapshot and its stream until the result decides their meaning.
			ctx.pendingSyntheticMessages ??= [];
		}
		if (message.type === "result" && ctx.usageLimit) {
			// The SDK turn still ended. Hide its synthetic error/result text while
			// preserving usage, cursor receipts, tool state, and normal idle release.
			const completion: SDKResultSuccess = {
				...message,
				subtype: "success",
				is_error: false,
				result: "",
			};
			return [completion];
		}
		if (
			ctx.pendingSyntheticMessages &&
			message.type === "assistant" &&
			message.parent_tool_use_id == null
		) {
			ctx.pendingSyntheticMessages.push(message);
			return [];
		}
		if (ctx.pendingSyntheticMessages && message.type === "result") {
			const pending = ctx.pendingSyntheticMessages;
			ctx.pendingSyntheticMessages = undefined;
			return [...pending, message];
		}
		return [message];
	});
