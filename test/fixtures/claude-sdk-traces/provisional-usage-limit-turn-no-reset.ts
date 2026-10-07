// PROVISIONAL: variant of the constructed limit turn, with no SDK reset time.
// Replace both constructed fixtures with captured wire traffic per ADR-0002.
import type {
	SDKMessage,
	SDKUserMessage,
} from "../../../src/lib/provider/claude/types.js";
import {
	provisionalRejectedLimit,
	provisionalUsageLimitTurn,
} from "./provisional-usage-limit-turn.js";

function withoutReset(message: SDKMessage): SDKMessage {
	if (message.type !== "rate_limit_event") return message;
	const { resetsAt: _resetsAt, ...rateLimitInfo } = message.rate_limit_info;
	return { ...message, rate_limit_info: rateLimitInfo };
}

export const provisionalRejectedLimitWithoutReset = (sessionId: string) =>
	withoutReset(provisionalRejectedLimit(sessionId));

export function provisionalUsageLimitTurnWithoutReset(
	sessionId: string,
	prompt: SDKUserMessage,
) {
	const fixture = provisionalUsageLimitTurn(sessionId, prompt);
	return {
		nativeTranscript: fixture.nativeTranscript.map(withoutReset),
		events: fixture.events.map(withoutReset),
	};
}
