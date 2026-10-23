/**
 * A slow, disposable reconstruction from the entire command history.
 * No ledger events, private state, implementation helpers, or decider outputs
 * enter this model. Every query scans retained admissions, sends and receipts.
 */
import assert from "node:assert/strict";
import type {
	Deadline,
	DeadlineKind,
	DecideContext,
	EndReason,
	Evidence,
	InputState,
	InputView,
	InteractionView,
	IssuedEffect,
	LedgerCommand,
	LedgerView,
	Observation,
	ProviderKind,
	RunEffect,
	RunEnded,
	RunOutcome,
	RunTag,
	SendToken,
} from "../../../../src/lib/provider/run-ledger/run-ledger-model.js";

export const policy: DecideContext["policy"] = {
	startMs: 1_000,
	livenessMs: 10_000,
	interruptMs: 30_000,
	closeMs: 2_000,
	settleMs: 3_000,
	fenceMs: 4_000,
};

export type Mutation = "ignore_pause" | "resend_unknown" | "extend_settle";
export interface ReferenceResult {
	readonly tag: "Accepted" | "Rejected";
	readonly effects: readonly IssuedEffect[];
	readonly ended: readonly RunEnded[];
	readonly diagnostic?: string;
	readonly alarmAt?: number | undefined;
}

interface Run {
	id: string;
	frames: {
		tag: RunTag;
		deadline: Deadline;
		by?: "stop" | "run_now" | "end";
	}[];
	result?:
		| { outcome: RunOutcome; reason: EndReason; specific?: boolean }
		| undefined;
	terminal?: RunEnded;
	nativeOpen: boolean;
	nativeDeadline?: number | undefined;
	cleanup?: { at: number; stage: "close" | "kill" } | undefined;
}
interface Admission {
	id: string;
	run?: string | undefined;
	role: "initial" | "steer";
	priority: boolean;
	states: InputState[];
	cancelled: boolean;
}
interface Interaction {
	id: string;
	run: string;
	kind: "permission" | "question";
	views: InteractionView[];
	answer?: unknown;
	timeoutAt?: number | undefined;
}
type Due = { at: number } & (
	| { role: "run"; run: Run; deadline: DeadlineKind }
	| { role: "native"; run: Run }
	| { role: "retry"; source: Send }
	| { role: "permission"; interaction: Interaction }
	| { role: "cleanup"; run: Run; stage: "close" | "kill" }
);
interface Send {
	issued: IssuedEffect;
	run?: string | undefined;
	purpose: string;
	retryAt?: number | undefined;
	retired: boolean;
	outcomes: Evidence[];
	input?: Admission | undefined;
}

const last = <T>(values: readonly T[]): T => {
	const value = values.at(-1);
	assert(value !== undefined, "reference history must contain a fact");
	return value;
};

/** The replay workspace is discarded after every external command. */
class Reconstruction {
	readonly sends: Send[] = [];
	readonly runs: Run[] = [];
	readonly admissions: Admission[] = [];
	readonly interactions: Interaction[] = [];
	readonly terminals: RunEnded[] = [];
	paused = false;
	inactive = false;
	now = 100;
	private ids = 0;

	constructor(
		readonly provider: ProviderKind,
		readonly mutation?: Mutation,
	) {}

	private active(): Run | undefined {
		return this.runs.find((run) => !run.terminal);
	}
	private currentInput(id: string): Admission | undefined {
		return this.admissions
			.slice()
			.reverse()
			.find((input) => input.id === id);
	}
	private inputView(input: Admission): InputView {
		const state = last(input.states);
		return {
			inputId: input.id,
			state,
			uncertain: state.tag === "Delivered" && state.certainty === "unknown",
		};
	}
	private issue(effect: RunEffect, purpose: string): Send {
		for (const prior of this.sends) {
			if (prior.purpose === purpose) {
				prior.retired = true;
				prior.retryAt = undefined;
			}
		}
		const send: Send = {
			issued: { token: `reference-send-${++this.ids}` as SendToken, effect },
			purpose,
			// A missing probe response must retry even without a transport outcome.
			retryAt: effect.kind === "probe" ? this.now + policy.closeMs : undefined,
			retired: false,
			outcomes: [],
			...("runId" in effect ? { run: effect.runId } : {}),
		};
		this.sends.push(send);
		return send;
	}
	private frame(run: Run, tag: RunTag, kind: DeadlineKind, duration: number) {
		const previous = run.frames.at(-1);
		const deadline = { at: this.now + duration, kind };
		run.frames.push({
			tag,
			deadline,
			...(tag === "Interrupting" && previous?.by ? { by: previous.by } : {}),
		});
	}
	private carry(input: Admission, run: Run, kind: "start" | "steer") {
		input.run = run.id;
		input.role = kind === "start" ? "initial" : "steer";
		if (kind === "start") run.nativeOpen = true;
		input.states.push({ tag: "Delivered", certainty: "sent" });
		const send = this.issue(
			{ kind, runId: run.id, inputId: input.id },
			`input:${run.id}:${this.admissions.indexOf(input)}`,
		);
		send.input = input;
	}
	private unresolvedNative(): Send[] {
		return this.sends.filter((send) => {
			const effect = send.issued.effect;
			const run = this.runs.find((item) => item.id === send.run);
			if (!run?.terminal || send.retired) return false;
			if (
				(effect.kind === "start" || effect.kind === "steer") &&
				run.nativeOpen
			)
				return true;
			if (
				!["close", "kill_and_respawn", "cancel_request", "interrupt"].includes(
					effect.kind,
				)
			)
				return false;
			if (this.provider !== "opencode" && effect.kind === "interrupt")
				return false;
			return (
				!send.outcomes.some(
					(item) =>
						item.kind === "effect_outcome" && item.outcome.tag === "succeeded",
				) && !send.retired
			);
		});
	}
	private startWaiting() {
		if (this.inactive || this.active()) return;
		const waiting = this.admissions.filter(
			(input) =>
				!input.run && !input.cancelled && last(input.states).tag === "Queued",
		);
		const input = waiting.find((item) => item.priority) ?? waiting[0];
		if (
			!input ||
			(this.paused && !input.priority && this.mutation !== "ignore_pause")
		)
			return;
		const run: Run = {
			id: `reference-run-${++this.ids}`,
			frames: [],
			nativeOpen: false,
		};
		this.runs.push(run);
		input.run = run.id;
		if (this.unresolvedNative().length) {
			this.frame(run, "Queued", "fence", policy.fenceMs);
			this.issue(
				{ kind: "probe", runId: run.id, target: { tag: "native_session" } },
				`native-probe:${run.id}`,
			);
		} else {
			this.carry(input, run, "start");
			this.frame(run, "Starting", "start", policy.startMs);
		}
	}
	private releaseWaiting() {
		const run = this.active();
		if (
			!this.inactive &&
			run &&
			last(run.frames).tag === "Queued" &&
			!this.unresolvedNative().length
		) {
			const input = this.admissions.find((item) => item.run === run.id);
			if (input) this.carry(input, run, "start");
			this.frame(run, "Starting", "start", policy.startMs);
		} else this.startWaiting();
	}
	private acceptInput(input: Admission, nativeMessageId?: string) {
		const previous = input.states.find(
			(state) =>
				state.tag === "Accepted" && state.nativeMessageId !== undefined,
		);
		const id =
			previous?.tag === "Accepted" ? previous.nativeMessageId : nativeMessageId;
		input.states.push({
			tag: "Accepted",
			...(id !== undefined ? { nativeMessageId: id } : {}),
			...(input.cancelled ? { cancelled: true as const } : {}),
		});
		for (const send of this.sends)
			if (send.input === input) {
				send.retryAt = undefined;
				if (send.issued.effect.kind === "probe") send.retired = true;
			}
	}
	private consumeAnswer(item: Interaction) {
		item.views.push({
			tag: "Answered",
			interactionId: item.id,
			kind: item.kind,
			delivery: "settled",
		});
		item.timeoutAt = undefined;
		for (const send of this.sends) {
			const effect = send.issued.effect;
			if (
				send.run === item.run &&
				((effect.kind === "deliver_answer" &&
					effect.interactionId === item.id) ||
					(effect.kind === "probe" &&
						effect.target.tag === "interaction" &&
						effect.target.interactionId === item.id))
			) {
				send.retired = true;
				send.retryAt = undefined;
			}
		}
	}
	private probeInput(input: Admission, runId: string) {
		const send = this.issue(
			{ kind: "probe", runId, target: { tag: "input", inputId: input.id } },
			`input-probe:${runId}:${this.admissions.indexOf(input)}`,
		);
		send.input = input;
	}
	private finish(
		run: Run,
		outcome: RunOutcome,
		reason: EndReason,
		cleanup = false,
	) {
		if (run.terminal) return;
		run.terminal = { runId: run.id, outcome, reason };
		this.terminals.push(run.terminal);
		for (const send of this.sends) {
			if (send.run !== run.id) continue;
			const effect = send.issued.effect;
			if (effect.kind === "start" || effect.kind === "steer")
				send.retryAt = undefined;
			// Run lifecycle ends now; native work and answer delivery can outlive it.
			if (
				(run.nativeOpen &&
					(effect.kind === "start" || effect.kind === "steer")) ||
				effect.kind === "deliver_answer" ||
				(effect.kind === "probe" && effect.target.tag !== "native_session") ||
				(run.cleanup && ["close", "kill_and_respawn"].includes(effect.kind)) ||
				(this.provider === "opencode" && effect.kind === "interrupt")
			)
				continue;
			send.retired = true;
			send.retryAt = undefined;
		}
		for (const interaction of this.interactions)
			if (interaction.run === run.id) interaction.timeoutAt = undefined;
		if (outcome !== "completed") this.paused = true;
		for (const input of this.admissions.filter((item) => item.run === run.id)) {
			if (input.role !== "steer" || last(input.states).tag === "Accepted")
				continue;
			if (last(input.states).tag === "Declined") continue;
			input.run = undefined;
			input.states.push({ tag: "Delivered", certainty: "unknown" });
			if (!this.inactive) this.probeInput(input, run.id);
		}
		if (cleanup && !this.inactive) this.cleanup(run);
		this.startWaiting();
	}
	private cleanup(run: Run) {
		if (this.provider === "opencode") {
			this.issue({ kind: "cancel_request", runId: run.id }, `cancel:${run.id}`);
			this.issue({ kind: "interrupt", runId: run.id }, `abort:${run.id}`);
			this.issue(
				{ kind: "probe", runId: run.id, target: { tag: "native_session" } },
				`native-probe:${run.id}`,
			);
		} else {
			this.issue({ kind: "close", runId: run.id }, `close:${run.id}`);
		}
		run.nativeDeadline = undefined;
		run.cleanup = { at: this.now + policy.closeMs, stage: "close" };
	}

	private settleResult(run: Run) {
		if (run.result) this.finish(run, run.result.outcome, run.result.reason);
	}
	private reject(diagnostic: string): ReferenceResult {
		return { tag: "Rejected", diagnostic, effects: [], ended: [] };
	}
	private admit(id: string, priority: boolean): string | undefined {
		const existing = this.currentInput(id);
		if (existing && this.inputView(existing).uncertain)
			return "uncertain input requires provider proof before readmission";
		if (
			existing &&
			(!existing.run ||
				!this.runs.find((run) => run.id === existing.run)?.terminal)
		)
			return "input already admitted";
		const input: Admission = {
			id,
			role: "initial",
			priority,
			states: [{ tag: "Queued" }],
			cancelled: false,
		};
		this.admissions.push(input);
		const active = this.active();
		if (priority && active) this.interrupt(active, "run_now");
		else if (
			active &&
			!this.inactive &&
			!this.paused &&
			["Starting", "Running"].includes(last(active.frames).tag)
		)
			this.carry(input, active, "steer");
		else this.startWaiting();
		return undefined;
	}
	private interrupt(run: Run, by: "stop" | "run_now" | "end") {
		if (last(run.frames).tag === "Interrupting") return;
		for (const send of this.sends)
			if (
				send.run === run.id &&
				["start", "steer"].includes(send.issued.effect.kind)
			)
				send.retryAt = undefined;
		this.issue(
			{ kind: by === "end" ? "end_session" : "interrupt", runId: run.id },
			`interrupt:${run.id}`,
		);
		this.frame(run, "Interrupting", "interrupt", policy.interruptMs);
		last(run.frames).by = by;
	}
	private answer(item: Interaction, answer: unknown) {
		item.answer = answer;
		item.views.push({
			tag: "Answered",
			interactionId: item.id,
			kind: item.kind,
			delivery: "sent",
		});
		this.issue(
			{
				kind: "deliver_answer",
				runId: item.run,
				interactionId: item.id,
				answer,
			},
			`answer:${item.run}:${item.id}`,
		);
		item.timeoutAt = undefined;
	}

	apply(command: LedgerCommand, now: number): ReferenceResult {
		this.now = now;
		const beforeSends = this.sends.length;
		const beforeTerminals = this.terminals.length;
		let diagnostic: string | undefined;
		switch (command.verb) {
			case "admit":
				diagnostic = this.admit(command.inputId, command.runNow);
				break;
			case "control": {
				const control = command.control;
				const run = this.active();
				switch (control.kind) {
					case "stop":
					case "end":
						this.paused = true;
						if (run) this.interrupt(run, control.kind);
						break;
					case "resume":
						this.paused = false;
						this.startWaiting();
						break;
					case "run_now": {
						const input = this.currentInput(control.inputId);
						if (input && !input.run) {
							input.priority = true;
							if (run) this.interrupt(run, "run_now");
							else this.startWaiting();
						} else diagnostic = this.admit(control.inputId, true);
						break;
					}
					case "cancel_input": {
						const input = this.currentInput(control.inputId);
						if (!input) {
							diagnostic = "unknown input";
							break;
						}
						if (last(input.states).tag === "Accepted") {
							diagnostic = "accepted input cannot be recalled";
							break;
						}
						input.cancelled = true;
						if (last(input.states).tag === "Queued")
							input.states.push({ tag: "Declined", reason: "cancelled" });
						else {
							input.states.push({ tag: "Delivered", certainty: "unknown" });
							if (input.run && !this.inactive)
								this.probeInput(input, input.run);
						}
						break;
					}
					case "answer": {
						const item = this.interactions
							.slice()
							.reverse()
							.find(
								(interaction) =>
									interaction.id === control.interactionId &&
									interaction.run === run?.id,
							);
						if (!item || last(item.views).tag !== "Pending")
							diagnostic = "interaction is not pending";
						else {
							item.answer = control.answer;
							const ambiguous = this.sends.some(
								(send) =>
									send.run === item.run &&
									send.issued.effect.kind === "deliver_answer" &&
									send.issued.effect.interactionId === item.id &&
									send.outcomes.some(
										(evidence) =>
											evidence.kind === "effect_outcome" &&
											evidence.outcome.tag === "delivery_unknown",
									),
							);
							const reconciling = this.sends.some(
								(send) =>
									!send.retired &&
									send.run === item.run &&
									send.issued.effect.kind === "probe" &&
									send.issued.effect.target.tag === "interaction" &&
									send.issued.effect.target.interactionId === item.id,
							);
							if (!ambiguous || !reconciling) this.answer(item, control.answer);
						}
						break;
					}
				}
				break;
			}
			case "observe":
				diagnostic = this.observe(command.observation);
				break;
			case "settle": {
				const settlement = command.settlement;
				if (
					settlement.kind === "project_inactive" ||
					settlement.kind === "session_ended"
				) {
					const previouslyInactive = this.inactive;
					this.inactive = true;
					this.paused = true;
					const run = this.active();
					if (run)
						this.finish(
							run,
							"error",
							settlement.kind === "project_inactive"
								? { kind: "project_inactive" }
								: { kind: "session_ended", cause: settlement.cause },
						);
					for (const send of this.sends) send.retired = true;
					for (const owner of this.runs) {
						owner.nativeOpen = false;
						owner.nativeDeadline = undefined;
						owner.cleanup = undefined;
					}
					this.inactive =
						settlement.kind === "project_inactive" || previouslyInactive;
				} else if (settlement.kind === "alarm_fired") {
					let due = this.deadlines()[0];
					while (due && due.at <= now) {
						this.fire(due);
						due = this.deadlines()[0];
					}
				} else {
					const send = this.sends.find(
						(item) => item.issued.token === settlement.token,
					);
					if (!send || send.retired) break;
					if (!["start", "steer"].includes(send.issued.effect.kind))
						diagnostic = "process loss needs a query send";
					else {
						const run = this.runs.find((item) => item.id === send.run);
						if (run && !run.terminal) {
							run.nativeOpen = false;
							this.finish(run, "error", { kind: "process_lost" });
						}
					}
				}
				break;
			}
		}
		if (diagnostic) return this.reject(diagnostic);
		return {
			tag: "Accepted",
			effects: this.sends.slice(beforeSends).map((send) => send.issued),
			ended: this.terminals.slice(beforeTerminals),
			...(this.deadlines()[0] ? { alarmAt: this.deadlines()[0]?.at } : {}),
		};
	}

	/** Scan the owners each time. There is no scheduler history to reconcile. */
	private deadlines(): Due[] {
		if (this.inactive) return [];
		const due: Due[] = [];
		for (const run of this.runs) {
			if (!run.terminal) {
				const deadline = last(run.frames).deadline;
				due.push({
					role: "run",
					run,
					deadline: deadline.kind,
					at: deadline.at,
				});
			}
			if (run.nativeOpen && run.nativeDeadline !== undefined)
				due.push({ role: "native", run, at: run.nativeDeadline });
			if (run.cleanup) due.push({ role: "cleanup", run, ...run.cleanup });
		}
		for (const send of this.sends)
			if (!send.retired && send.retryAt !== undefined)
				due.push({ role: "retry", source: send, at: send.retryAt });
		for (const interaction of this.interactions)
			if (interaction.timeoutAt !== undefined)
				due.push({
					role: "permission",
					interaction,
					at: interaction.timeoutAt,
				});
		return due.sort((a, b) => a.at - b.at);
	}

	private observe(observation: Observation): string | undefined {
		const send = this.sends.find(
			(item) => item.issued.token === observation.token,
		);
		if (!send) return undefined;
		const effect = send.issued.effect;
		const kind = observation.kind;
		const query = effect.kind === "start" || effect.kind === "steer";
		const receipt =
			["input_accepted", "input_declined", "accounting"].includes(kind) ||
			(kind === "interaction_resolved" && effect.kind === "deliver_answer") ||
			(kind === "probe_result" &&
				effect.kind === "probe" &&
				effect.target.tag !== "native_session");
		// Even stale known tokens must reject an impossible producer/evidence pairing.
		if (
			([
				"started",
				"activity",
				"result",
				"query_ended",
				"interaction_requested",
				"input_accepted",
				"input_declined",
				"accounting",
			].includes(kind) &&
				!query) ||
			(kind === "interaction_resolved" &&
				!query &&
				effect.kind !== "deliver_answer") ||
			(kind === "probe_result" && effect.kind !== "probe")
		)
			return "evidence kind cannot be produced by this send";
		if (kind === "probe_result" && effect.kind === "probe") {
			const expected =
				effect.target.tag === "input"
					? ["input_present", "input_absent"]
					: effect.target.tag === "interaction"
						? ["answer_consumed", "answer_pending"]
						: ["native_idle", "native_busy"];
			if (!expected.includes(observation.finding.tag))
				return "probe finding does not match target";
		}
		if (
			observation.kind === "interaction_resolved" &&
			effect.kind === "deliver_answer" &&
			observation.interactionId !== effect.interactionId
		)
			return "answer token belongs to another interaction";
		if (send.retired && !receipt) return undefined;
		const run = this.runs.find((item) => item.id === send.run);
		if (query && run?.terminal && !receipt && kind !== "query_ended")
			return undefined;
		const liveReceipt = !send.retired && !this.inactive;
		const nativeMessageId =
			observation.kind === "input_accepted"
				? observation.nativeMessageId
				: observation.kind === "probe_result" &&
						observation.finding.tag === "input_present"
					? observation.finding.nativeMessageId
					: undefined;
		const accepted = send.input?.states.find(
			(state) =>
				state.tag === "Accepted" && state.nativeMessageId !== undefined,
		);
		if (
			accepted?.tag === "Accepted" &&
			nativeMessageId !== undefined &&
			accepted.nativeMessageId !== nativeMessageId
		)
			return "native input identity cannot change";
		send.outcomes.push(observation);
		const input = send.input;
		switch (kind) {
			case "accounting":
				break;
			case "input_accepted":
				if (input) this.acceptInput(input, observation.nativeMessageId);
				if (
					run &&
					!run.terminal &&
					last(run.frames).tag === "Settling" &&
					this.mutation === "extend_settle"
				)
					this.frame(run, "Settling", "settle", policy.settleMs);
				if (
					run?.nativeDeadline !== undefined &&
					this.mutation === "extend_settle"
				)
					run.nativeDeadline = this.now + policy.settleMs;
				break;
			case "input_declined":
				if (input && last(input.states).tag !== "Accepted") {
					for (const prior of this.sends)
						if (prior.input === input) prior.retryAt = undefined;
					input.states.push({ tag: "Declined", reason: observation.reason });
					input.run = undefined;
					input.states.push({ tag: "Queued" });
				}
				break;
			case "started":
				if (run && !run.terminal && last(run.frames).tag === "Starting")
					this.frame(run, "Running", "liveness", policy.livenessMs);
				break;
			case "activity":
				if (run && !run.terminal) {
					if (["Starting", "Running"].includes(last(run.frames).tag))
						this.frame(run, "Running", "liveness", policy.livenessMs);
					else if (
						last(run.frames).tag === "Settling" &&
						this.mutation === "extend_settle"
					)
						this.frame(run, "Settling", "settle", policy.settleMs);
				}
				break;
			case "result":
				if (run && !run.terminal) {
					const previous = run.result;
					const result: NonNullable<Run["result"]> = {
						outcome: observation.outcome,
						reason:
							observation.outcome === "error"
								? {
										kind: "provider_error",
										code: observation.error?.code ?? "provider_error",
										retryable: observation.error?.retryable ?? false,
									}
								: observation.outcome === "interrupted"
									? {
											kind: "interrupted",
											by: last(run.frames).by ?? "stop",
											forced: false,
										}
									: { kind: "completed" },
						specific: observation.error !== undefined,
					};
					if (
						!previous ||
						(result.outcome === "error" &&
							(previous.outcome !== "error" ||
								(!previous.specific && result.specific))) ||
						(result.outcome === "completed" &&
							previous.outcome === "interrupted")
					)
						run.result = result;
					if (this.provider === "opencode") {
						if (last(run.frames).tag !== "Settling")
							this.frame(run, "Settling", "settle", policy.settleMs);
					} else {
						if (this.provider === "claude")
							run.nativeDeadline ??= this.now + policy.settleMs;
						else run.nativeOpen = false;
						this.settleResult(run);
					}
				}
				break;
			case "query_ended":
				if (run) {
					run.nativeOpen = false;
					run.nativeDeadline = undefined;
					for (const prior of this.sends)
						if (
							prior.run === run.id &&
							(["start", "steer"].includes(prior.issued.effect.kind) ||
								(this.provider !== "opencode" &&
									["interrupt", "close", "kill_and_respawn"].includes(
										prior.issued.effect.kind,
									)))
						) {
							prior.retired = true;
							prior.retryAt = undefined;
						}
					if (this.provider !== "opencode") run.cleanup = undefined;
					if (run.terminal) {
						this.releaseWaiting();
						break;
					}
					if (!run.result)
						run.result = {
							outcome: "completed",
							reason: { kind: "completed" },
						};
					this.settleResult(run);
					this.releaseWaiting();
				}
				break;
			case "interaction_requested":
				if (
					run &&
					!run.terminal &&
					!this.interactions.some(
						(item) =>
							item.run === run.id && item.id === observation.interactionId,
					)
				) {
					const item: Interaction = {
						id: observation.interactionId,
						run: run.id,
						kind: observation.interactionKind,
						views: [
							{
								tag: "Pending",
								interactionId: observation.interactionId,
								kind: observation.interactionKind,
							},
						],
					};
					this.interactions.push(item);
					if (item.kind === "permission" && observation.timeoutAt !== undefined)
						item.timeoutAt = observation.timeoutAt;
				}
				break;
			case "interaction_resolved": {
				const item = this.interactions
					.slice()
					.reverse()
					.find(
						(interaction) =>
							interaction.id === observation.interactionId &&
							interaction.run === send.run,
					);
				if (item) this.consumeAnswer(item);
				break;
			}
			case "effect_outcome":
				this.effectOutcome(send, observation.outcome);
				break;
			case "probe_result": {
				if (effect.kind !== "probe") break;
				send.retired = true;
				send.retryAt = undefined;
				const finding = observation.finding;
				if (effect.target.tag === "input") {
					const admission = send.input;
					if (admission && finding.tag === "input_present")
						this.acceptInput(admission, finding.nativeMessageId);
					if (
						admission &&
						finding.tag === "input_absent" &&
						last(admission.states).tag !== "Accepted"
					)
						admission.states.push(
							admission.cancelled
								? { tag: "Declined", reason: "cancelled" }
								: { tag: "Queued" },
						);
				} else if (effect.target.tag === "interaction") {
					const id = effect.target.interactionId;
					const item = this.interactions
						.slice()
						.reverse()
						.find(
							(interaction) =>
								interaction.id === id && interaction.run === send.run,
						);
					if (item && finding.tag === "answer_consumed")
						this.consumeAnswer(item);
					if (
						item &&
						finding.tag === "answer_pending" &&
						liveReceipt &&
						!this.inactive
					)
						this.answer(item, item.answer);
				} else if (finding.tag === "native_idle") {
					const order = this.sends.indexOf(send);
					for (const prior of this.sends.slice(0, order)) {
						const instruction = prior.issued.effect;
						// Idle proves native readiness, not an input or answer receipt.
						if (
							instruction.kind === "deliver_answer" ||
							(instruction.kind === "probe" &&
								instruction.target.tag !== "native_session")
						)
							continue;
						// OpenCode status cannot cancel a still-in-flight HTTP command.
						if (
							this.provider === "opencode" &&
							["start", "steer", "interrupt", "cancel_request"].includes(
								prior.issued.effect.kind,
							) &&
							!prior.outcomes.some(
								(item) =>
									item.kind === "effect_outcome" &&
									["succeeded", "permanent"].includes(item.outcome.tag),
							)
						)
							continue;
						prior.retired = true;
						prior.retryAt = undefined;
					}
					send.retired = true;
					send.retryAt = undefined;
					for (const owner of this.runs) {
						const remaining = this.sends.filter(
							(item) => !item.retired && item.run === owner.id,
						);
						if (
							!remaining.some((item) =>
								["start", "steer"].includes(item.issued.effect.kind),
							)
						) {
							owner.nativeOpen = false;
							owner.nativeDeadline = undefined;
						}
						if (
							!remaining.some((item) =>
								[
									"close",
									"kill_and_respawn",
									"cancel_request",
									"interrupt",
								].includes(item.issued.effect.kind),
							)
						)
							owner.cleanup = undefined;
					}
					if (
						run &&
						!run.terminal &&
						["Running", "Settling"].includes(last(run.frames).tag) &&
						!run.nativeOpen
					)
						this.finish(
							run,
							run.result?.outcome ?? "completed",
							run.result?.reason ?? { kind: "completed" },
						);
					this.releaseWaiting();
				} else if (
					finding.tag === "native_busy" &&
					run &&
					!run.terminal &&
					last(run.frames).tag === "Running"
				)
					this.frame(run, "Running", "liveness", policy.livenessMs);
				break;
			}
		}
		return undefined;
	}

	private effectOutcome(
		send: Send,
		outcome: Extract<Evidence, { kind: "effect_outcome" }>["outcome"],
	) {
		const effect = send.issued.effect;
		const run = this.runs.find((item) => item.id === send.run);
		const input = send.input;
		if (effect.kind === "probe") {
			if (outcome.tag === "retryable") send.retryAt = outcome.retryAt;
			return;
		}
		const interaction =
			"interactionId" in effect
				? this.interactions
						.slice()
						.reverse()
						.find(
							(item) =>
								item.id === effect.interactionId && item.run === send.run,
						)
				: undefined;
		// Native receipts outrank an interpreter outcome delivered afterwards.
		if (
			input?.states.some(
				(state) => state.tag === "Accepted" || state.tag === "Declined",
			)
		)
			return;
		const answerView = interaction ? last(interaction.views) : undefined;
		if (answerView?.tag === "Answered" && answerView.delivery === "settled")
			return;
		if (outcome.tag === "retryable") {
			if (
				input &&
				this.inputView(input).uncertain &&
				run &&
				(effect.kind === "start" || effect.kind === "steer")
			) {
				this.probeInput(input, run.id);
				return;
			}
			if (interaction)
				interaction.views.push({
					tag: "Answered",
					interactionId: interaction.id,
					kind: interaction.kind,
					delivery: "queued",
				});
			send.retryAt = outcome.retryAt;
		} else if (outcome.tag === "delivery_unknown") {
			send.retryAt = undefined;
			if (input && run) {
				input.states.push({ tag: "Delivered", certainty: "unknown" });
				if (this.mutation === "resend_unknown")
					this.carry(input, run, effect.kind === "steer" ? "steer" : "start");
				else this.probeInput(input, run.id);
			} else if (interaction && run) {
				interaction.views.push({
					tag: "Answered",
					interactionId: interaction.id,
					kind: interaction.kind,
					delivery: "unknown",
				});
				this.issue(
					{
						kind: "probe",
						runId: run.id,
						target: { tag: "interaction", interactionId: interaction.id },
					},
					`answer-probe:${run.id}:${interaction.id}`,
				);
			}
		} else if (outcome.tag === "permanent") {
			send.retryAt = undefined;
			if (interaction) {
				// A terminal failure is visible as a still-pending request, never a false consumption.
				interaction.views.push({
					tag: "Pending",
					interactionId: interaction.id,
					kind: interaction.kind,
				});
				this.issue(
					{
						kind: "probe",
						runId: interaction.run,
						target: { tag: "interaction", interactionId: interaction.id },
					},
					`answer-probe:${interaction.run}:${interaction.id}`,
				);
			} else if (effect.kind === "kill_and_respawn") {
				send.retired = true;
				if (run) run.cleanup = undefined;
				this.issue(
					{ kind: "quarantine", runId: effect.runId },
					`quarantine:${effect.runId}`,
				);
			} else if (effect.kind === "interrupt" && run && !run.terminal) {
				if (this.provider !== "opencode") this.cleanup(run);
			} else if (effect.kind === "steer" && input) {
				input.run = undefined;
				input.states.push({ tag: "Queued" });
			} else if (run && !run.terminal && effect.kind === "start") {
				run.nativeOpen = false;
				this.finish(run, "error", { kind: "refused", code: outcome.code });
			}
		} else if (outcome.tag === "succeeded") {
			send.retryAt = undefined;
			if (
				[
					"close",
					"kill_and_respawn",
					"cancel_request",
					"end_session",
					"quarantine",
				].includes(effect.kind)
			) {
				send.retired = true;
				if (
					run &&
					["close", "kill_and_respawn", "end_session"].includes(effect.kind)
				) {
					run.nativeOpen = false;
					run.nativeDeadline = undefined;
					run.cleanup = undefined;
					for (const prior of this.sends)
						if (
							prior.run === run.id &&
							["start", "steer", "close", "kill_and_respawn"].includes(
								prior.issued.effect.kind,
							)
						) {
							prior.retired = true;
							prior.retryAt = undefined;
						}
				}
				this.releaseWaiting();
			}
		}
	}

	private fire(due: Due) {
		if (due.role === "permission") {
			due.interaction.timeoutAt = undefined;
			if (last(due.interaction.views).tag === "Pending")
				this.answer(due.interaction, { decision: "reject", reason: "timeout" });
			return;
		}
		if (due.role === "retry") {
			const original = due.source;
			original.retryAt = undefined;
			if (!original || original.retired || this.inactive) return;
			const effect = original.issued.effect;
			const query = effect.kind === "start" || effect.kind === "steer";
			if (
				query &&
				original.input?.states.some(
					(state) => state.tag === "Accepted" || state.tag === "Declined",
				)
			)
				return;
			if (
				query &&
				original.input &&
				last(original.input.states).tag === "Delivered" &&
				this.inputView(original.input).uncertain
			)
				return;
			const run = this.runs.find((item) => item.id === original.run);
			if (effect.kind === "deliver_answer") {
				const interaction = this.interactions
					.slice()
					.reverse()
					.find(
						(item) =>
							item.id === effect.interactionId && item.run === effect.runId,
					);
				const view = interaction ? last(interaction.views) : undefined;
				if (!view || (view.tag === "Answered" && view.delivery === "settled"))
					return;
			}
			if (effect.kind === "start" || effect.kind === "steer") {
				if (
					!run ||
					run.terminal ||
					(this.paused && !original.input?.priority) ||
					!["Starting", "Running"].includes(last(run.frames).tag)
				)
					return;
			}
			if (effect.kind === "start" && run && !run.terminal) {
				for (const previous of this.sends)
					if (previous.run === run.id) previous.retired = true;
				this.issue(effect, original.purpose).input = original.input;
				run.result = undefined;
				run.nativeOpen = true;
				this.frame(run, "Starting", "start", policy.startMs);
			} else this.issue(effect, original.purpose).input = original.input;
			if (effect.kind === "deliver_answer") {
				const item = this.interactions
					.slice()
					.reverse()
					.find(
						(interaction) =>
							interaction.id === effect.interactionId &&
							interaction.run === effect.runId,
					);
				if (item)
					item.views.push({
						tag: "Answered",
						interactionId: item.id,
						kind: item.kind,
						delivery: "sent",
					});
			}
			return;
		}
		const run = due.run;
		if (due.role === "native") {
			run.nativeDeadline = undefined;
			this.cleanup(run);
			return;
		}
		if (due.role === "cleanup") {
			run.cleanup = undefined;
			if (this.inactive) return;
			if (due.stage === "close" && this.provider !== "opencode") {
				for (const previous of this.sends)
					if (
						previous.run === run.id &&
						previous.issued.effect.kind === "close"
					)
						previous.retired = true;
				this.issue(
					{ kind: "kill_and_respawn", runId: run.id },
					`kill:${run.id}`,
				);
				run.cleanup = { at: this.now + policy.closeMs, stage: "kill" };
			} else
				this.issue(
					{ kind: "quarantine", runId: run.id },
					`quarantine:${run.id}`,
				);
			return;
		}
		if (run.terminal) return;
		switch (due.deadline) {
			case "start":
				this.finish(
					run,
					"error",
					{ kind: "deadline_expired", deadline: "start" },
					true,
				);
				break;
			case "interrupt":
				this.finish(
					run,
					"interrupted",
					{
						kind: "interrupted",
						by: last(run.frames).by ?? "stop",
						forced: true,
					},
					true,
				);
				break;
			case "liveness":
				this.issue(
					{ kind: "probe", runId: run.id, target: { tag: "native_session" } },
					`native-probe:${run.id}`,
				);
				this.frame(run, "Running", "liveness", policy.livenessMs);
				break;
			case "settle":
				this.finish(
					run,
					run.result?.outcome ?? "error",
					run.result?.reason ?? {
						kind: "deadline_expired",
						deadline: "settle",
					},
					true,
				);
				break;
			case "fence":
				this.finish(run, "error", { kind: "fence_unconfirmed" });
				break;
			default:
				break;
		}
	}

	view(): LedgerView {
		const run = this.active();
		const frame = run?.frames.at(-1);
		return {
			paused: this.paused,
			...(run && frame
				? {
						active: {
							runId: run.id,
							...frame,
							inputs: this.admissions
								.filter((input) => input.run === run.id)
								.map((input) => this.inputView(input)),
							interactions: this.interactions
								.filter((item) => item.run === run.id)
								.map((item) => last(item.views)),
						},
					}
				: {}),
			inbox: this.admissions
				.filter((input) => !input.run && !input.cancelled)
				.map((input) => this.inputView(input)),
			live: this.sends
				.filter((send) => !send.retired)
				.map((send) => send.issued),
		};
	}
}

export class HistoryReference {
	readonly history: { command: LedgerCommand; now: number }[] = [];
	private reconstruction: Reconstruction;
	constructor(
		readonly provider: ProviderKind,
		readonly mutation?: Mutation,
	) {
		this.reconstruction = new Reconstruction(provider, mutation);
	}
	step(command: LedgerCommand, now: number): ReferenceResult {
		this.history.push({ command, now });
		const rebuilt = new Reconstruction(this.provider, this.mutation);
		let result: ReferenceResult = { tag: "Accepted", effects: [], ended: [] };
		for (const entry of this.history)
			result = rebuilt.apply(entry.command, entry.now);
		this.reconstruction = rebuilt;
		return result;
	}
	view(): LedgerView {
		return this.reconstruction.view();
	}
	get issued(): readonly IssuedEffect[] {
		return this.reconstruction.sends.map((send) => send.issued);
	}
}
