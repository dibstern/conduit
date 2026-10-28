import type { Deferred } from "effect";
import type { SessionFailure } from "./session-runner.js";

type Activity =
	| {
			readonly _tag: "Starting" | "StartupTimedOut";
			readonly readiness: "Pending" | "Listening";
	  }
	| {
			readonly _tag: "Verified" | "Serving";
	  }
	| {
			readonly _tag: "AwaitingProject";
			readonly identity: "Unverified" | "Verified";
	  }
	| {
			readonly _tag: "Recovering";
			readonly identity: "Unverified" | "Verified";
			readonly project: "Available" | "AwaitingProject";
	  };

export interface RunnerEntryLifecycle {
	readonly activity: Activity;
	// Reservations span startup, recovery and cleanup until their finalizers run.
	readonly commandsInFlight: number;
	readonly candidate: boolean;
	readonly idleExiting: boolean;
	readonly failure?: SessionFailure;
	readonly stop?: { readonly signal: "Pending" | "Signalled" };
	readonly end?: {
		readonly pending: number;
		readonly released: Deferred.Deferred<void>;
	};
}

export type RunnerEntryTransition =
	| {
			readonly _tag:
				| "Listening"
				| "Verify"
				| "Ready"
				| "Recovered"
				| "StartupTimedOut"
				| "IdleExit"
				| "Stop"
				| "SignalStop"
				| "FinishEnd"
				| "AdmitCommand"
				| "FinishCommand"
				| "MakeCandidate"
				| "Promote";
	  }
	| { readonly _tag: "Fail"; readonly failure: SessionFailure }
	| { readonly _tag: "BeginEnd"; readonly released: Deferred.Deferred<void> };

export const initialRunnerLifecycle = (recovery?: {
	readonly awaitingProject: boolean;
	readonly candidate: boolean;
}): RunnerEntryLifecycle => ({
	activity: recovery
		? {
				_tag: "Recovering",
				identity: "Unverified",
				project: recovery.awaitingProject ? "AwaitingProject" : "Available",
			}
		: { _tag: "Starting", readiness: "Pending" },
	commandsInFlight: 0,
	candidate: recovery?.candidate ?? false,
	idleExiting: false,
});

const isRecovering = (state: RunnerEntryLifecycle) =>
	state.activity._tag === "Recovering";
export const isAwaitingProject = (state: RunnerEntryLifecycle | undefined) => {
	if (!state) return false;
	const { activity } = state;
	return (
		activity._tag === "AwaitingProject" ||
		(activity._tag === "Recovering" && activity.project === "AwaitingProject")
	);
};
export const hasVerifiedIdentity = (state: RunnerEntryLifecycle) => {
	const { activity } = state;
	return (
		activity._tag === "Verified" ||
		activity._tag === "Serving" ||
		((activity._tag === "AwaitingProject" || activity._tag === "Recovering") &&
			activity.identity === "Verified")
	);
};
export const needsStartupStop = (state: RunnerEntryLifecycle) => {
	const { activity } = state;
	return (
		(activity._tag === "Starting" || activity._tag === "StartupTimedOut") &&
		activity.readiness === "Pending"
	);
};
export const hasReadinessNotice = (state: RunnerEntryLifecycle) =>
	!needsStartupStop(state) && !isRecovering(state);

// Different callers deliberately have different admission policies. For
// example, End and native controls remain available while another End drains.
export const canControl = (state: RunnerEntryLifecycle) =>
	!state.failure && !state.stop;
export const countsTowardDemand = (state: RunnerEntryLifecycle) =>
	canControl(state) && !state.idleExiting;
export const canReconfigure = (state: RunnerEntryLifecycle) =>
	countsTowardDemand(state) && state.end === undefined;
export const canPreWarm = (state: RunnerEntryLifecycle) =>
	canReconfigure(state) && !isRecovering(state);
export const isCommandIdle = (state: RunnerEntryLifecycle) =>
	!isRecovering(state) && state.commandsInFlight === 0;
export const isQuiet = (state: RunnerEntryLifecycle, quiescent: boolean) =>
	isCommandIdle(state) && quiescent;
export const canUpgrade = (state: RunnerEntryLifecycle) =>
	canPreWarm(state) && !isAwaitingProject(state) && isCommandIdle(state);
export const canUseControlConnection = (state: RunnerEntryLifecycle) =>
	countsTowardDemand(state) &&
	hasVerifiedIdentity(state) &&
	!isRecovering(state);
export const mustDrainBeforeSend = (state: RunnerEntryLifecycle) =>
	state.failure !== undefined || state.idleExiting || state.end !== undefined;

export type SendDecision =
	| "Use"
	| "DeferRebind"
	| "Refuse"
	| "Retire"
	| "Wait"
	| "Skip";

export const decideSend = (input: {
	readonly command: "send-turn" | "pre-warm";
	readonly lifecycle: RunnerEntryLifecycle;
	readonly quiescent: boolean;
	readonly rebindsAccount: boolean;
	readonly changes: {
		readonly folders: boolean;
		readonly login: "None" | "Settings" | "Account";
		readonly legacyCursor: boolean;
		readonly settingsDeferred: boolean;
	};
}): SendDecision => {
	const { command, lifecycle, quiescent, rebindsAccount, changes } = input;
	if (changes.legacyCursor && command === "pre-warm") return "Skip";
	if (changes.folders && command === "pre-warm") return "Skip";
	// Only an idle runner restarts. Background tasks can keep one
	// busy for hours, and it can still serve the send meanwhile.
	const upgradeByRestart =
		command === "send-turn" &&
		changes.settingsDeferred &&
		isQuiet(lifecycle, quiescent);
	if (
		(changes.folders ||
			changes.login !== "None" ||
			changes.legacyCursor ||
			upgradeByRestart) &&
		canReconfigure(lifecycle)
	) {
		// A turn's completion can reach the browser before the
		// runner reports quiescence. Do not admit the next turn
		// on its old folders while that final output drains.
		// An account switch needs a fresh native session and cannot preserve
		// background work. Same-account settings can wait for a quiet send.
		if (!isQuiet(lifecycle, quiescent)) {
			if (command === "pre-warm") return "Skip";
			if (changes.login === "Account") return "Refuse";
			if (changes.login === "Settings" && !changes.folders && rebindsAccount)
				return "DeferRebind";
			return "Wait";
		}
		// New Claude payloads replace only the SDK query when quiet.
		// Older peers still need a restart.
		if (changes.folders || upgradeByRestart || !rebindsAccount) return "Retire";
	}
	return "Use";
};

/** Pure reduction; unsupported or repeated notifications are silent no-ops. */
export const nextRunnerLifecycle = (
	state: RunnerEntryLifecycle,
	event: RunnerEntryTransition,
): RunnerEntryLifecycle => {
	const { activity } = state;
	switch (event._tag) {
		case "MakeCandidate":
			return state.candidate ? state : { ...state, candidate: true };
		case "Promote":
			return state.candidate ? { ...state, candidate: false } : state;
		case "IdleExit":
			return state.idleExiting ? state : { ...state, idleExiting: true };
		case "Fail":
			return { ...state, failure: event.failure };
		case "Stop":
			return state.stop ? state : { ...state, stop: { signal: "Pending" } };
		case "SignalStop":
			return state.stop ? { ...state, stop: { signal: "Signalled" } } : state;
		case "BeginEnd":
			return {
				...state,
				end: state.end
					? { ...state.end, pending: state.end.pending + 1 }
					: { pending: 1, released: event.released },
			};
		case "FinishEnd": {
			if (!state.end) return state;
			const { end, ...next } = state;
			return end.pending === 1
				? next
				: { ...state, end: { ...end, pending: end.pending - 1 } };
		}
		case "AdmitCommand":
			return { ...state, commandsInFlight: state.commandsInFlight + 1 };
		case "FinishCommand":
			return state.commandsInFlight === 0
				? state
				: { ...state, commandsInFlight: state.commandsInFlight - 1 };
		case "Listening":
			return activity._tag === "Starting" || activity._tag === "StartupTimedOut"
				? { ...state, activity: { ...activity, readiness: "Listening" } }
				: state;
		case "StartupTimedOut":
			return activity._tag === "Starting"
				? { ...state, activity: { ...activity, _tag: "StartupTimedOut" } }
				: state;
		case "Verify":
			if (activity._tag === "Recovering" || activity._tag === "AwaitingProject")
				return { ...state, activity: { ...activity, identity: "Verified" } };
			return activity._tag === "Starting"
				? { ...state, activity: { _tag: "Verified" } }
				: state;
		case "Ready":
			return activity._tag === "Verified"
				? { ...state, activity: { _tag: "Serving" } }
				: state;
		case "Recovered":
			if (activity._tag !== "Recovering") return state;
			return {
				...state,
				activity:
					activity.project === "AwaitingProject"
						? { _tag: "AwaitingProject", identity: activity.identity }
						: activity.identity === "Verified"
							? { _tag: "Serving" }
							: { _tag: "Starting", readiness: "Pending" },
			};
		default:
			return state;
	}
};
