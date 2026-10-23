import type { CanonicalEvent } from "../../contracts/stored-event.js";
import type { ProviderKind } from "./run-ledger-model.js";
import type {
	NativePolicy,
	NativeTerminal,
	TerminalIdentity,
} from "./run-ledger-policy.js";

function classifyRunnerTerminal(
	event: CanonicalEvent,
	streamsSessionLifecycle: boolean,
	identity: TerminalIdentity,
): NativeTerminal | undefined {
	if (
		event.metadata.runId !== undefined &&
		event.metadata.runId !== identity.runId
	)
		return undefined;
	const { token } = identity;
	switch (event.type) {
		case "turn.interrupted":
			return { kind: "result", token, outcome: "interrupted" };
		case "turn.error":
			return {
				kind: "result",
				token,
				outcome: "error",
				error: {
					code: event.data.code ?? "provider_error",
					retryable:
						event.data.retryable === true && event.data.retryHandled !== true,
				},
			};
		case "turn.completed":
			return streamsSessionLifecycle
				? { kind: "result", token, outcome: "completed" }
				: undefined;
		default:
			return undefined;
	}
}

function classifyOpenCodeTerminal(
	event: CanonicalEvent,
	_streamsSessionLifecycle: boolean,
	identity: TerminalIdentity,
): NativeTerminal | undefined {
	if (event.type !== "session.status")
		return classifyRunnerTerminal(event, false, identity);
	// A session-wide status is evidence only with an explicit resolved owner.
	if (event.metadata.runId !== identity.runId) return undefined;
	const { token } = identity;
	if (event.data.status === "idle") return { kind: "query_ended", token };
	if (event.data.status === "error")
		return {
			kind: "result",
			token,
			outcome: "error",
			error: { code: "provider_error", retryable: false },
		};
	return undefined;
}

const claudePolicy: NativePolicy = {
	controlEffect: (by) => (by === "end" ? "end_session" : "interrupt"),
	closeEffect: "close",
	interruptFailure: "settle",
	postTombstoneProbe: false,
	fences: (effect) =>
		[
			"start",
			"steer",
			"interrupt",
			"end_session",
			"close",
			"kill_and_respawn",
			"quarantine",
		].includes(effect.kind),
	idleCovers: (effect) =>
		claudePolicy.fences(effect) ||
		(effect.kind === "probe" && effect.target.tag === "native_session"),
	confirmsIdle: (effect) =>
		["close", "kill_and_respawn", "end_session"].includes(effect.kind),
	classifyTerminal: classifyRunnerTerminal,
};

const cursorPolicy: NativePolicy = { ...claudePolicy };

const openCodePolicy: NativePolicy = {
	...claudePolicy,
	closeEffect: "cancel_request",
	interruptFailure: "fence",
	postTombstoneProbe: true,
	fences: (effect) =>
		["start", "steer", "interrupt", "cancel_request", "end_session"].includes(
			effect.kind,
		) ||
		(effect.kind === "probe" && effect.target.tag === "native_session"),
	confirmsIdle: () => false,
	// HTTP requests and session-wide aborts can still execute after an idle sample.
	idleCovers: (effect, deliveryConfirmed) =>
		(effect.kind === "probe" && effect.target.tag === "native_session") ||
		(deliveryConfirmed && openCodePolicy.fences(effect)),
	classifyTerminal: classifyOpenCodeTerminal,
};

export const nativePolicies: Readonly<Record<ProviderKind, NativePolicy>> = {
	claude: claudePolicy,
	cursor: cursorPolicy,
	opencode: openCodePolicy,
};
