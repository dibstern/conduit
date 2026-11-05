import type { ChildProcess } from "node:child_process";
import { Cause, Deferred, Effect, Exit, Scope, type Semaphore } from "effect";
import type { PendingInteractionService } from "../../domain/relay/Services/pending-interaction-service.js";
import type { ProviderRuntimeIngestion } from "../../domain/relay/Services/provider-runtime-ingestion-service.js";
import {
	type RunnerHello,
	type RunnerSocket,
	runnerFailure,
} from "./runner-protocol.js";
import type { RunnerMember } from "./runner-receipts.js";
import type { currentPendingSendOwner } from "./runner-recovery.js";
import type {
	RunnerSourceDelivery,
	RunnerUpgrade,
	RunnerUpgradeState,
} from "./runner-upgrade.js";
import type {
	SessionFailure,
	SessionOutput,
	SessionTurn,
} from "./session-runner.js";

/** Read-only outside this module, which is the only writer of every field. */
export interface RunnerChild {
	readonly recoveringCommands?: boolean;
	/** The attached host's hello querySeq, its start's label (CONTRACT 6.1). */
	readonly querySeq?: number;
	readonly ownsPendingSend?: Effect.Success<typeof currentPendingSendOwner>;
	readonly attachmentId?: string | undefined;
	readonly registeredAt?: number;
	readonly sessionId: string;
	readonly registrationRoot?: string;
	readonly launch?:
		| Pick<SessionTurn, "workspaceRoot" | "extraFolders">
		| undefined;
	readonly launchSnapshot?: RunnerUpgradeState["snapshot"];
	/** The entry's memory: closing it releases every waiter below (CONTRACT 6.11). */
	readonly scope: Scope.Closeable;
	readonly ready: Deferred.Deferred<RunnerSocket, SessionFailure>;
	readonly drained: Deferred.Deferred<void>;
	readonly socketPath: string;
	readonly outputs: Semaphore.Semaphore;
	readonly lifecycle: RunnerEntryLifecycle;
	readonly runnerId: string;
	/** Exit callbacks run in the construction runtime, after recovery returns. */
	readonly ingestion?: ProviderRuntimeIngestion | undefined;
	readonly pendingInteractions?: PendingInteractionService | undefined;
	readonly pid?: number | undefined;
	readonly startTime?: string | undefined;
	readonly reaper?: RunnerMember | undefined;
	readonly child?: ChildProcess;
	readonly connection?: RunnerSocket;
	readonly buildId?: string;
	readonly capabilities?: {
		readonly stopsTasks: boolean;
		readonly rebindsAccount: boolean;
		readonly settlesAnswers: boolean;
		readonly declaresLogin: boolean;
	};
	readonly interactionSinks?: ReadonlyMap<string, string>;
	/** One verified terminal delivery, including its release-sink unwind. */
	readonly sourceDelivery?: RunnerSourceDelivery | undefined;
	readonly upgrade: RunnerUpgrade;
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };

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

// Notification is private to admission; it never changes account eligibility.
const waiters = new WeakMap<RunnerChild, Set<Deferred.Deferred<void>>>();
export const notifyEntry = (entry: RunnerChild): void => {
	const armed = [...(waiters.get(entry) ?? [])];
	// Completing a Deferred can synchronously register its next observation.
	waiters.delete(entry);
	for (const waiter of armed) Deferred.doneUnsafe(waiter, Effect.void);
};
/** Completes `changed` at the entry's next notification, or at once once its scope closed. */
export const watch = (entry: RunnerChild, changed: Deferred.Deferred<void>) => {
	// A waiter registers only while the entry scope that releases it is open (B25).
	if (entry.scope.state._tag === "Closed") {
		Deferred.doneUnsafe(changed, Effect.void);
		return;
	}
	const armed = waiters.get(entry) ?? new Set();
	waiters.set(entry, armed.add(changed));
};
export const unwatch = (entry: RunnerChild, changed: Deferred.Deferred<void>) =>
	waiters.get(entry)?.delete(changed);

// Every lifecycle write goes through this boundary; reduction itself is pure.
export const transition = (
	entry: RunnerChild,
	event: RunnerEntryTransition,
) => {
	const writable: Writable<RunnerChild> = entry;
	const ending = entry.lifecycle.end;
	writable.lifecycle = nextRunnerLifecycle(entry.lifecycle, event);
	if (!canReconfigure(entry.lifecycle)) writable.sourceDelivery = undefined;
	notifyEntry(entry);
	return event._tag === "FinishEnd" && ending?.pending === 1
		? ending.released
		: undefined;
};

/** A spawned child's or adopted hello's pid; the first start time read for a pid stays. */
export const bindProcess = (
	entry: RunnerChild,
	process: {
		readonly child?: ChildProcess;
		readonly pid: number | undefined;
		readonly startTime: (pid: number) => string | undefined;
	},
) => {
	const writable: Writable<RunnerChild> = entry;
	if (process.child) writable.child = process.child;
	writable.pid = process.pid;
	if (process.pid !== undefined)
		writable.startTime ??= process.startTime(process.pid);
};

/** A verified hello. The socket attaches only while the caller still owns the entry. */
export const connect = (
	entry: RunnerChild,
	attachment: {
		readonly hello: RunnerHello;
		readonly connection: RunnerSocket;
		readonly attachmentId: string | undefined;
		readonly startTime: (pid: number) => string | undefined;
		readonly owns: () => boolean;
	},
) => {
	const { hello, connection } = attachment;
	const writable: Writable<RunnerChild> = entry;
	bindProcess(entry, { pid: hello.pid, startTime: attachment.startTime });
	writable.reaper = hello.reaper;
	if (attachment.owns() && !connection.closed) {
		writable.connection = connection;
		writable.attachmentId = attachment.attachmentId;
	}
	transition(entry, { _tag: "Verify" });
};

/** The attached runner's build, capabilities and newest reported state. */
export const identify = (
	entry: RunnerChild,
	hello: RunnerHello & { readonly querySeq?: number },
) => {
	const writable: Writable<RunnerChild> = entry;
	const upgrade: Writable<RunnerUpgrade> = entry.upgrade;
	writable.buildId = hello.buildId;
	writable.querySeq = hello.querySeq ?? 0;
	writable.capabilities = {
		stopsTasks: hello.stopsTasks === true,
		rebindsAccount: hello.rebindsAccount === true,
		settlesAnswers: hello.settlesAnswers === true,
		declaresLogin: hello.declaresLogin === true,
	};
	const observed = entry.upgrade.state;
	const helloState = hello.upgradeState;
	const latest =
		observed && (!helloState || observed.revision >= helloState.revision)
			? observed
			: helloState;
	const snapshot =
		latest?.snapshot ??
		observed?.snapshot ??
		helloState?.snapshot ??
		entry.launchSnapshot;
	upgrade.state = latest
		? { ...latest, ...(snapshot ? { snapshot } : {}) }
		: undefined;
	notifyEntry(entry);
};

/**
 * Keeps a terminal delivery only while this reconfigurable runner owns its
 * send, or while it is the same delivery already held. Does not notify.
 */
export const observeDelivery = (
	entry: RunnerChild,
	delivery: RunnerSourceDelivery | undefined,
	owned: boolean,
) => {
	const writable: Writable<RunnerChild> = entry;
	const previous = entry.sourceDelivery;
	// A released sink may disappear while its already-verified delivery unwinds.
	const retained =
		delivery &&
		previous &&
		previous.generation === delivery.generation &&
		previous.sinkId === delivery.sinkId &&
		previous.token === delivery.token &&
		previous.inputId === delivery.inputId &&
		previous.runId === delivery.runId;
	writable.sourceDelivery =
		delivery?.sessionId === entry.sessionId &&
		delivery.runnerId === entry.runnerId &&
		canReconfigure(entry.lifecycle) &&
		(owned || retained)
			? delivery
			: undefined;
};

/** Applies a state report unless it is older than the held one. */
export const upgradeState = (
	entry: RunnerChild,
	state: RunnerUpgradeState,
	owned: boolean,
): boolean => {
	const upgrade: Writable<RunnerUpgrade> = entry.upgrade;
	const held = entry.upgrade.state;
	if (held && state.revision < held.revision) return false;
	observeDelivery(entry, state.sourceDelivery, owned);
	const snapshot = state.snapshot ?? held?.snapshot ?? entry.launchSnapshot;
	// Only snapshots are omitted when unchanged. An omitted cursor is cleared.
	upgrade.state = { ...state, ...(snapshot ? { snapshot } : {}) };
	notifyEntry(entry);
	return true;
};

/** Bumps the version an upgrade attempt compares against; returns the new one. */
export const touch = (entry: RunnerChild): number => {
	const upgrade: Writable<RunnerUpgrade> = entry.upgrade;
	return ++upgrade.activity;
};

export const ownPendingSends = (
	entry: RunnerChild,
	owner: RunnerChild["ownsPendingSend"],
) => {
	const writable: Writable<RunnerChild> = entry;
	writable.ownsPendingSend = owner;
};

/** Routes interaction resolutions to the sink whose request is still open. */
export const trackInteraction = (entry: RunnerChild, output: SessionOutput) => {
	const writable: Writable<RunnerChild> = entry;
	if (
		output.type === "question-request" ||
		output.type === "permission-request"
	) {
		writable.interactionSinks = new Map(entry.interactionSinks).set(
			`${output.type}:${output.request.requestId}`,
			output.sinkId,
		);
		return;
	}
	if (
		!entry.interactionSinks ||
		(output.type !== "cancel-interaction" && output.type !== "release-sink")
	)
		return;
	const cancelled =
		output.type === "cancel-interaction"
			? [
					`question-request:${output.requestId}`,
					`permission-request:${output.requestId}`,
				]
			: undefined;
	writable.interactionSinks = new Map(
		[...entry.interactionSinks].filter(
			([key, sinkId]) =>
				sinkId !== output.sinkId ||
				(cancelled !== undefined && !cancelled.includes(key)),
		),
	);
};

/** The entry stops delivering. Idempotent. */
export const end = (entry: RunnerChild) => {
	const writable: Writable<RunnerChild> = entry;
	writable.sourceDelivery = undefined;
	notifyEntry(entry);
};

/**
 * An entry's one scope and the waiters it owns (CONTRACT 6.11). A child of the
 * provider instance's scope, so the instance's close is the last closer.
 */
export const open = (parent: Scope.Scope) =>
	Effect.gen(function* () {
		return {
			scope: yield* Scope.fork(parent, "sequential"),
			ready: yield* Deferred.make<RunnerSocket, SessionFailure>(),
			drained: yield* Deferred.make<void>(),
		};
	});

/**
 * The entry scope's finalizers. They run in reverse: the runner's sends still
 * dispatched to it close, then every waiter is released with the close cause.
 * Neither takes the runner lock or touches the runner socket.
 */
export const own = (
	entry: RunnerChild,
	closeSends: (runnerId: string) => Effect.Effect<void>,
) =>
	Effect.gen(function* () {
		yield* Scope.addFinalizerExit(entry.scope, (exit) =>
			Effect.gen(function* () {
				end(entry);
				yield* Deferred.failCause(
					entry.ready,
					Exit.isFailure(exit)
						? exit.cause
						: Cause.fail(
								entry.lifecycle.failure ??
									runnerFailure("stop runner", "Provider process stopped"),
							),
				);
				yield* Deferred.succeed(entry.drained, undefined);
				const ending = entry.lifecycle.end;
				if (ending) yield* Deferred.succeed(ending.released, undefined);
			}),
		);
		yield* Scope.addFinalizer(entry.scope, closeSends(entry.runnerId));
	});

/** Closes the entry scope; idempotent. Its closers are listed in CONTRACT 6.11. */
export const close = (
	entry: RunnerChild,
	cause?: Cause.Cause<SessionFailure>,
) => Scope.close(entry.scope, cause ? Exit.failCause(cause) : Exit.void);

/** Ends the entry and lets go of its connection and child, without stopping the process. */
export const detach = (entry: RunnerChild, failure?: SessionFailure) => {
	end(entry);
	entry.connection?.destroy(failure);
	entry.child?.unref();
	if (entry.child?.connected) entry.child.disconnect();
};
