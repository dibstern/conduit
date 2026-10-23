import type { CanonicalEvent } from "../../contracts/stored-event.js";
import type {
	Observation,
	ProviderKind,
	RunEffect,
	SendToken,
} from "./run-ledger-model.js";
import { nativePolicies } from "./run-ledger-policy-adapters.js";

export interface TerminalIdentity {
	readonly runId: string;
	readonly token: SendToken;
}

export type NativeTerminal = Extract<
	Observation,
	{ readonly kind: "result" | "query_ended" }
>;

/** Native boundaries and terminal meaning belong to the provider policy. */
export interface NativePolicy {
	readonly runEnd: "result" | "query_ended";
	/** Whether the Run terminal also releases the native session. */
	readonly resultReleasesFence: boolean;
	readonly controlEffect: (
		by: "stop" | "run_now" | "end",
	) => "interrupt" | "end_session";
	readonly closeEffect: "close" | "cancel_request";
	readonly interruptFailure: "settle" | "fence";
	readonly postTombstoneProbe: boolean;
	/** Outstanding native work that prevents a successor from starting. */
	readonly fences: (effect: RunEffect) => boolean;
	/** Whether an idle sample proves earlier native work can no longer execute. */
	readonly idleCovers: (
		effect: RunEffect,
		deliveryConfirmed: boolean,
	) => boolean;
	/** Whether successful delivery itself proves the native query is closed. */
	readonly confirmsIdle: (effect: RunEffect) => boolean;
	readonly classifyTerminal: (
		event: CanonicalEvent,
		streamsSessionLifecycle: boolean,
		identity: TerminalIdentity,
	) => NativeTerminal | undefined;
}

export function nativePolicy(provider: ProviderKind): NativePolicy {
	return nativePolicies[provider];
}

/** The caller resolves the send; the policy validates native terminal meaning. */
export function classifyRunTerminal(
	event: CanonicalEvent,
	provider: ProviderKind,
	streamsSessionLifecycle: boolean,
	identity: TerminalIdentity,
): NativeTerminal | undefined {
	return nativePolicy(provider).classifyTerminal(
		event,
		streamsSessionLifecycle,
		identity,
	);
}
