import type {
	Evidence,
	Observation,
	ProviderDecisionRules,
	ProviderIntake,
	ProviderKind,
	ProviderPolicyTable,
	RunEffect,
} from "./run-ledger-model.js";

function terminalAnswer(
	identity: Parameters<ProviderIntake["terminal"]>[2],
	evidence: Extract<Evidence, { kind: "result" | "query_ended" }>,
): Extract<Observation, { readonly tag: "Answer" }> {
	return { tag: "Answer", token: identity.token, ...evidence };
}

const runnerTerminal: ProviderIntake["terminal"] = (
	event,
	streamsSessionLifecycle,
	identity,
) => {
	if (
		event.metadata.runId !== undefined &&
		event.metadata.runId !== identity.runId
	)
		return undefined;
	switch (event.type) {
		case "turn.interrupted":
			return terminalAnswer(identity, {
				kind: "result",
				outcome: "interrupted",
			});
		case "turn.error":
			return terminalAnswer(identity, {
				kind: "result",
				outcome: "error",
				error: {
					code: event.data.code ?? "provider_error",
					retryable:
						event.data.retryable === true && event.data.retryHandled !== true,
				},
			});
		case "turn.completed":
			return streamsSessionLifecycle
				? terminalAnswer(identity, { kind: "result", outcome: "completed" })
				: undefined;
		default:
			return undefined;
	}
};

const openCodeTerminal: ProviderIntake["terminal"] = (
	event,
	_streamsSessionLifecycle,
	identity,
) => {
	if (event.type !== "session.status")
		return runnerTerminal(event, false, identity);
	// A native-session status cannot answer a query without its resolved owner.
	if (event.metadata.runId !== identity.runId) return undefined;
	if (event.data.status === "idle")
		return terminalAnswer(identity, { kind: "query_ended" });
	if (event.data.status === "error")
		return terminalAnswer(identity, {
			kind: "result",
			outcome: "error",
			error: { code: "provider_error", retryable: false },
		});
	return undefined;
};

const runnerIntake: ProviderIntake = { terminal: runnerTerminal };
const openCodeIntake: ProviderIntake = { terminal: openCodeTerminal };

/** Canonical-event intake is known independently of the unresolved decision rules. */
export const nativeIntakes: {
	readonly [P in ProviderKind]: ProviderIntake | undefined;
} = {
	claude: runnerIntake,
	codex: undefined,
	cursor: runnerIntake,
	opencode: openCodeIntake,
};

const startOrSteer = (effect: RunEffect) =>
	effect.kind === "start" || effect.kind === "steer";
const has = (
	evidence: readonly Evidence[],
	kind: "result" | "query_ended",
): boolean => evidence.some((item) => item.kind === kind);

// Section 9's decided fence membership, work-ended column and idle proof (CONTRACT.md 3076-3093).
const claudeRules: ProviderDecisionRules = {
	fences: startOrSteer,
	idleCovers: () => false,
	// Gap (CONTRACT.md 3086, 3092-3094): "cancelled before any started" is the transmission's
	// NotConsumed{cancelled}, which may not act (3.5); following the oracle it is no work-ended
	// evidence, so a later `started` joins it to Observed.
	workEnded(evidence) {
		return (
			has(evidence, "result") ||
			(evidence.some(
				(item) => item.kind === "journal_answer" && item.answer === "absent",
			) &&
				!evidence.some((item) => item.kind === "input_accepted"))
		);
	},
};

export const nativePolicies: ProviderPolicyTable = {
	claude: {
		tag: "Ready",
		capabilities: {
			backgroundTasks: true,
			runnerHost: true,
			commandReceipts: true,
		},
		runEnd: "result",
		intake: runnerIntake,
		rules: claudeRules,
	},
	codex: {
		tag: "Pending",
		capabilities: {
			backgroundTasks: true,
			runnerHost: true,
			commandReceipts: false,
		},
		runEnd: "result",
		ticket: "conduit-test-82tn.32.2.13",
	},
	cursor: {
		tag: "Ready",
		capabilities: {
			backgroundTasks: false,
			runnerHost: true,
			commandReceipts: false,
		},
		runEnd: "result",
		intake: runnerIntake,
		rules: {
			fences: startOrSteer,
			idleCovers: () => false,
			workEnded: (evidence) => has(evidence, "result"),
		},
	},
	opencode: {
		tag: "Ready",
		capabilities: {
			backgroundTasks: false,
			runnerHost: false,
			commandReceipts: false,
		},
		runEnd: "query_ended",
		intake: openCodeIntake,
		rules: {
			fences: (effect) =>
				startOrSteer(effect) ||
				effect.kind === "interrupt" ||
				effect.kind === "cancel_request",
			// A native_idle probe covers aborts and cancel_request session-wide, and a start or steer
			// whose delivery is confirmed (D26).
			idleCovers: (effect, deliveryConfirmed) =>
				effect.kind === "interrupt" ||
				effect.kind === "cancel_request" ||
				(startOrSteer(effect) && deliveryConfirmed),
			workEnded: (evidence) => has(evidence, "query_ended"),
		},
	},
};
