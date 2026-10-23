import type { Send } from "./run-ledger-internal.js";

/** All delivery precedence lives here. No observation replaces earlier proof. */
export function sendProof(send: Send) {
	const has = (kind: Send["facts"][number]["kind"]) =>
		send.facts.some((fact) => fact.kind === kind);
	const accepted = has("accepted");
	const observed = has("observed");
	const nativeCompleted = has("native_completed");
	const succeeded = has("transport_succeeded");
	const unknown = has("delivery_unknown");
	const satisfied = has("probe_satisfied");
	const failures = send.facts.flatMap((fact) =>
		fact.kind === "transport_failed" ? [fact.code] : [],
	);
	const failure = failures.sort()[0];
	const retries = send.facts.flatMap((fact) =>
		fact.kind === "retryable" ? [fact.at] : [],
	);
	const retryAt = retries.length > 0 ? Math.min(...retries) : send.probeRetryAt;
	const confirmed = succeeded || nativeCompleted;
	const retryBlocked =
		send.effect.kind === "probe"
			? satisfied || failure !== undefined
			: confirmed || observed || unknown || failure !== undefined;
	return {
		confirmed,
		// Acceptance proves consumption, never HTTP completion. Failures cannot
		// manufacture completion or erase an independently received success.
		inputOutcome: accepted
			? undefined
			: failure !== undefined
				? ({ tag: "failed", code: failure } as const)
				: unknown
					? ({ tag: "unknown" } as const)
					: succeeded
						? ({ tag: "sent" } as const)
						: undefined,
		retryAt: retryBlocked ? undefined : retryAt,
		retainAtNativeEnd:
			!confirmed &&
			!observed &&
			(retries.length === 0 || accepted || unknown || failure !== undefined),
		obsoleteAfterEnd:
			retries.length > 0 &&
			!accepted &&
			!observed &&
			!confirmed &&
			!unknown &&
			failure === undefined,
		refusesStart: failure !== undefined && !accepted && !nativeCompleted,
		// Transport/native completion cannot answer whether unknown input was
		// consumed. That obligation is settled by an input receipt/probe only.
		needsInputProbe: unknown,
		uncertain: observed || unknown || failure !== undefined,
	};
}
