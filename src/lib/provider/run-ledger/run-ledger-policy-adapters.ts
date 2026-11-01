import type {
	Evidence,
	Observation,
	ProviderDecisionRules,
	ProviderIntake,
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
		capabilities: {
			backgroundTasks: true,
			runnerHost: true,
			commandReceipts: true,
			wakeTurns: true,
		},
		runEnd: "result",
		intake: runnerIntake,
		rules: claudeRules,
	},
	// OPEN-6 (CONTRACT.md 3143-3154): runner-held, its own row. Background terminals are its tasks
	// (8.2); it sends no command receipts and no turn_ended, so a wake ends at its result (8.3).
	codex: {
		capabilities: {
			backgroundTasks: true,
			runnerHost: true,
			commandReceipts: false,
			wakeTurns: true,
		},
		runEnd: "result",
		intake: runnerIntake,
		rules: {
			fences: startOrSteer,
			// Section 9 gives Codex no idle proof: thread/status idle covers nothing.
			idleCovers: () => false,
			// The runner withholds its result across a goal chain, and a successor after the deadline is
			// a wake Run, so the result the ledger sees ends the work (CONTRACT.md 3087, 3118-3119).
			workEnded: (evidence) => has(evidence, "result"),
		},
	},
	cursor: {
		capabilities: {
			backgroundTasks: false,
			runnerHost: true,
			commandReceipts: false,
			wakeTurns: false,
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
		capabilities: {
			backgroundTasks: false,
			runnerHost: false,
			commandReceipts: false,
			wakeTurns: true,
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
