import type {
	TerminalEvidence,
	TerminalSummary,
} from "./run-ledger-internal.js";
import type { EndReason, RunOutcome } from "./run-ledger-model.js";

/** Arrival order matters for the latest outcome/policy and explicit supersession.
 * Generic errors never displace the first specific failure; later reports of that
 * same failure can suppress a retry the provider already handles (RL-055). */
export function accumulateTerminalEvidence(
	summary: TerminalSummary,
	evidence: TerminalEvidence,
): TerminalSummary {
	if (evidence.kind === "superseded") return {};
	const error =
		evidence.outcome === "error"
			? (evidence.error ?? { code: "provider_error", retryable: false })
			: undefined;
	return {
		...summary,
		latest: evidence,
		...(evidence.outcome === "completed" ? { completed: true } : {}),
		...(error?.code === "provider_error" ? { genericFailure: error } : {}),
		...(error &&
		error.code !== "provider_error" &&
		(!summary.specificFailure || summary.specificFailure.code === error.code)
			? { specificFailure: error }
			: {}),
	};
}
/** One terminal policy, evaluated only when the run finishes. Explicit failure
 * causes outrank closure defaults. Stop changes only evidence-free closures;
 * an observed native completion during Stop still wins. */
export function classifyTerminalEvidence(
	evidence: TerminalSummary,
	fallback: { readonly outcome: RunOutcome; readonly reason: EndReason },
	by?: "stop" | "run_now" | "end",
): { readonly outcome: RunOutcome; readonly reason: EndReason } {
	if (by !== undefined && evidence.completed)
		return { outcome: "completed", reason: { kind: "completed" } };
	if (
		!["completed", "provider_error", "interrupted"].includes(
			fallback.reason.kind,
		)
	)
		return fallback;
	if (by !== undefined && !evidence.latest)
		return {
			outcome: "interrupted",
			reason: {
				kind: "interrupted",
				by,
				forced:
					fallback.reason.kind === "interrupted" && fallback.reason.forced,
			},
		};
	if (!evidence.latest) return fallback;
	if (evidence.latest.outcome === "completed")
		return { outcome: "completed", reason: { kind: "completed" } };
	if (evidence.latest.outcome === "interrupted")
		return {
			outcome: "interrupted",
			reason: { kind: "interrupted", by: by ?? "stop", forced: false },
		};
	const error = evidence.specificFailure ?? evidence.genericFailure;
	return {
		outcome: "error",
		reason: {
			kind: "provider_error",
			code: error?.code ?? "provider_error",
			retryable: error?.retryable ?? false,
		},
	};
}
