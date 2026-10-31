import type {
	Evidence,
	Observation,
	ProviderIntake,
	ProviderKind,
	ProviderPolicyTable,
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

/** Canonical-event intake is known independently of the unresolved decision rules. */
export const nativeIntakes: {
	readonly [P in ProviderKind]: ProviderIntake | undefined;
} = {
	claude: { terminal: runnerTerminal },
	codex: undefined,
	cursor: { terminal: runnerTerminal },
	opencode: { terminal: openCodeTerminal },
};

export const nativePolicies: ProviderPolicyTable = {
	claude: {
		tag: "Pending",
		capabilities: { backgroundTasks: true },
		runEnd: "result",
		ticket: "unresolved contract: Claude fence membership and idle proof",
	},
	codex: {
		tag: "Pending",
		capabilities: { backgroundTasks: true },
		runEnd: "result",
		ticket: "conduit-test-82tn.32.2.13",
	},
	cursor: {
		tag: "Pending",
		capabilities: { backgroundTasks: false },
		runEnd: "result",
		ticket: "unresolved contract: Cursor result releases native-session fence",
	},
	opencode: {
		tag: "Pending",
		capabilities: { backgroundTasks: false },
		runEnd: "query_ended",
		ticket: "unresolved contract: OpenCode fence membership and idle proof",
	},
};
