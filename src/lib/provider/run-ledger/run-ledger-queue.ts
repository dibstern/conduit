import { issue, liveSends } from "./run-ledger-correlation.js";
import {
	admit,
	attach,
	inbox,
	uncertain,
	uncertainAdmission,
} from "./run-ledger-input-records.js";
import {
	type ActiveRun,
	activeRun,
	putRun,
	runInputs,
	type Work,
} from "./run-ledger-internal.js";
import { deadline, finish, interrupt } from "./run-ledger-lifecycle.js";
import { nativePolicy } from "./run-ledger-policy.js";

export function admitInput(
	work: Work,
	inputId: string,
	priority: boolean,
): void {
	const run = activeRun(work.state);
	const ref = admit(work, inputId, priority);
	if (!ref) return;
	if (priority) {
		if (run) interrupt(work, run, "run_now");
		return;
	}
	if (
		(run?.tag === "Starting" || run?.tag === "Running") &&
		!uncertain(work.state, inputId)
	) {
		attach(work, ref, run.runId, "steer");
		issue(
			work,
			{ kind: "steer", runId: run.runId, inputId },
			{ runId: run.runId, admission: ref },
		);
	}
}

export function advance(work: Work): void {
	if (work.state.inactive) return;
	const run = activeRun(work.state) ?? reserve(work);
	if (!run) return;
	if (run.tag !== "Queued") return;
	const item = runInputs(work.state, run.runId)[0];
	if (!item || item.admission.state.tag === "Accepted") {
		finish(work, run, "completed", { kind: "completed" });
		advance(work);
		return;
	}
	const policy = nativePolicy(work.state.provider);
	const fenced = liveSends(work.state).some(
		(send) => send.runId !== run.runId && policy.fences(send.effect),
	);
	const protectedInput = uncertain(work.state, item.inputId);
	if (fenced || protectedInput) {
		const target = fenced
			? { tag: "native_session" as const }
			: { tag: "input" as const, inputId: item.inputId };
		const admission = protectedInput
			? (uncertainAdmission(work.state, item.inputId) ?? item)
			: undefined;
		const exists = liveSends(work.state).some(
			(send) =>
				send.runId === run.runId &&
				send.effect.kind === "probe" &&
				send.effect.target.tag === target.tag,
		);
		if (!exists)
			issue(
				work,
				{ kind: "probe", runId: run.runId, target },
				{ runId: run.runId, ...(admission ? { admission } : {}) },
			);
		return;
	}
	issue(
		work,
		{ kind: "start", runId: run.runId, inputId: item.inputId },
		{ runId: run.runId, admission: item },
	);
	putRun(work, {
		...run,
		tag: "Starting",
		deadline: deadline(work, "start", work.ctx.policy.startMs),
	});
}

function reserve(work: Work): ActiveRun | undefined {
	let run: ActiveRun | undefined;
	{
		const queued = inbox(work.state);
		const item =
			queued.find(({ admission }) => admission.priority) ??
			(!work.state.paused ? queued[0] : undefined);
		if (!item) return undefined;
		const runId = work.ctx.newId();
		work.state = { ...work.state, current: runId };
		attach(work, item, runId, "start");
		run = {
			tag: "Queued",
			runId,
			interactions: [],
			terminal: {},
			deadline: deadline(work, "fence", work.ctx.policy.fenceMs),
		};
		putRun(work, run);
	}
	return run;
}

export function queuedCancelled(work: Work): void {
	const run = activeRun(work.state);
	if (run?.tag !== "Queued") return;
	const owned = [...work.state.inputs.values()].some((record) =>
		record.admissions.some(
			(item) =>
				item.location.tag === "Run" && item.location.runId === run.runId,
		),
	);
	if (!owned)
		finish(work, run, "interrupted", {
			kind: "interrupted",
			by: "stop",
			forced: false,
		});
}
