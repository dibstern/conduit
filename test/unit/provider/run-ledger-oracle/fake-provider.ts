import fc from "fast-check";
import type {
	Evidence,
	IssuedEffect,
	LedgerCommand,
	LedgerView,
	ProviderKind,
	SendToken,
} from "../../../../src/lib/provider/run-ledger/run-ledger-model.js";

/** Selectors shrink as numbers; their meaning is resolved from public sends at execution. */
export interface TraceAction {
	readonly operation: number;
	readonly selection: number;
	readonly index: number;
	readonly variant: number;
	readonly input: number;
	readonly advance: number;
}

export const traceAction = fc.record({
	operation: fc.integer({ min: 0, max: 11 }),
	selection: fc.integer({ min: 0, max: 4 }),
	index: fc.nat({ max: 100 }),
	variant: fc.integer({ min: 0, max: 17 }),
	input: fc.nat({ max: 12 }),
	advance: fc.integer({ min: 0, max: 2_000 }),
});

export interface ProviderSnapshot {
	readonly issued: readonly IssuedEffect[];
	readonly view: LedgerView;
	readonly now: number;
	readonly alarmAt?: number | undefined;
}

export interface TracePacket {
	readonly command: LedgerCommand;
	readonly now: number;
}

const at = <T>(items: readonly T[], index: number): T | undefined =>
	items.length === 0 ? undefined : items[index % items.length];

/** No SDK or native process: packets are built exclusively from public issued effects. */
export class FakeProvider {
	private readonly held: LedgerCommand[] = [];
	private readonly delivered: LedgerCommand[] = [];
	private serial = 0;

	constructor(readonly provider: ProviderKind) {}

	private select(
		snapshot: ProviderSnapshot,
		action: TraceAction,
		predicate: (issued: IssuedEffect) => boolean = () => true,
	): IssuedEffect | undefined {
		const known = snapshot.issued.filter(predicate);
		const live = new Set(snapshot.view.live.map(({ token }) => token));
		switch (action.selection) {
			case 0:
				return at(
					known.filter(({ token }) => live.has(token)),
					action.index,
				);
			case 1:
				return at(
					known.filter(({ token }) => !live.has(token)),
					action.index,
				);
			case 2:
				// The oldest fourth stays available however far the trace advances.
				return at(
					known.slice(0, Math.max(1, Math.ceil(known.length / 4))),
					action.index,
				);
			case 3:
				return undefined;
			default:
				return at([...known].reverse(), action.index);
		}
	}

	private token(issued: IssuedEffect | undefined): SendToken {
		return (
			issued?.token ??
			(`fabricated:${this.provider}:${this.serial++}` as SendToken)
		);
	}

	private interaction(snapshot: ProviderSnapshot, index: number): string {
		return (
			at(snapshot.view.active?.interactions ?? [], index)?.interactionId ??
			`question:${index % 5}`
		);
	}

	private outcome(variant: number, now: number): Evidence {
		switch (variant % 4) {
			case 0:
				return { kind: "effect_outcome", outcome: { tag: "succeeded" } };
			case 1:
				return {
					kind: "effect_outcome",
					outcome: { tag: "retryable", retryAt: now + 100 + variant },
				};
			case 2:
				return {
					kind: "effect_outcome",
					outcome: { tag: "permanent", code: "TracePermanent" },
				};
			default:
				return { kind: "effect_outcome", outcome: { tag: "delivery_unknown" } };
		}
	}

	private evidence(
		issued: IssuedEffect | undefined,
		snapshot: ProviderSnapshot,
		action: TraceAction,
		now: number,
	): Evidence {
		const effect = issued?.effect;
		// Every sixth variant deliberately disregards send capability.
		if (action.variant % 6 !== 5 && effect) {
			if (effect.kind === "probe") {
				if (action.variant % 3 === 2) return this.outcome(action.variant, now);
				const present = action.variant % 2 === 0;
				switch (effect.target.tag) {
					case "input":
						return {
							kind: "probe_result",
							finding: present
								? {
										tag: "input_present",
										nativeMessageId: `native:${action.input}`,
									}
								: { tag: "input_absent" },
						};
					case "interaction":
						return {
							kind: "probe_result",
							finding: { tag: present ? "answer_consumed" : "answer_pending" },
						};
					case "native_session":
						return {
							kind: "probe_result",
							finding: { tag: present ? "native_idle" : "native_busy" },
						};
				}
			}
			if (effect.kind === "deliver_answer") {
				return action.variant % 3 === 0
					? {
							kind: "interaction_resolved",
							interactionId: effect.interactionId,
						}
					: this.outcome(action.variant, now);
			}
			if (effect.kind !== "start" && effect.kind !== "steer") {
				return this.outcome(action.variant, now);
			}
		}
		switch (action.variant) {
			case 0:
				return { kind: "started" };
			case 1:
				return {
					kind: "input_accepted",
					nativeMessageId: `native:${action.input}`,
				};
			case 2:
				return { kind: "input_declined", reason: "TraceDeclined" };
			case 3:
				return { kind: "activity" };
			case 4:
			case 5:
				return {
					kind: "interaction_requested",
					interactionId: `question:${action.input % 5}`,
					interactionKind: action.variant === 4 ? "question" : "permission",
					...(action.variant === 5 ? { timeoutAt: now + 200 } : {}),
				};
			case 6:
				return {
					kind: "interaction_resolved",
					interactionId: this.interaction(snapshot, action.index),
				};
			case 7:
				return { kind: "result", outcome: "completed" };
			case 8:
				return {
					kind: "result",
					outcome: "error",
					error: { code: "ActualFailure", retryable: false },
				};
			case 9:
				return { kind: "result", outcome: "interrupted" };
			case 10:
				return { kind: "query_ended" };
			case 11:
				return { kind: "accounting" };
			case 16:
				return { kind: "probe_result", finding: { tag: "native_idle" } };
			case 17:
				return { kind: "probe_result", finding: { tag: "answer_consumed" } };
			default:
				return this.outcome(action.variant, now);
		}
	}

	next(action: TraceAction, snapshot: ProviderSnapshot): TracePacket {
		let now = snapshot.now + action.advance;
		const inputId = `input:${action.input}`;
		let command: LedgerCommand;
		switch (action.operation) {
			case 0:
			case 1:
				command = { verb: "admit", inputId, runNow: action.operation === 1 };
				break;
			case 2: {
				const interactionId = this.interaction(snapshot, action.index);
				const controls = [
					{ kind: "stop" },
					{ kind: "resume" },
					{ kind: "end" },
					{ kind: "run_now", inputId },
					{ kind: "cancel_input", inputId },
					{
						kind: "answer",
						interactionId,
						answer: { allow: action.input % 2 === 0 },
					},
				] as const;
				command = {
					verb: "control",
					control: controls[action.variant % controls.length] ?? controls[0],
				};
				break;
			}
			case 3:
			case 4:
			case 5: {
				const issued = this.select(snapshot, action);
				command = {
					verb: "observe",
					observation: {
						token: this.token(issued),
						...this.evidence(issued, snapshot, action, now),
					},
				};
				if (action.operation === 5) {
					this.held.push(command);
					command = {
						verb: "observe",
						observation: { token: this.token(undefined), kind: "activity" },
					};
				}
				break;
			}
			case 6: {
				if (snapshot.alarmAt !== undefined) {
					switch (action.variant % 4) {
						case 0:
							now = Math.max(snapshot.now, snapshot.alarmAt);
							break;
						case 1:
							now = Math.max(snapshot.now, snapshot.alarmAt - 1);
							break;
						case 2:
							now = Math.max(now, snapshot.alarmAt + 100_000);
							break;
					}
				}
				command = {
					verb: "settle",
					settlement: { kind: "alarm_fired" },
				};
				break;
			}
			case 7: {
				const issued = this.select(
					snapshot,
					action,
					({ effect }) => effect.kind === "start" || effect.kind === "steer",
				);
				command = {
					verb: "settle",
					settlement: { kind: "process_lost", token: this.token(issued) },
				};
				break;
			}
			case 8:
				command = {
					verb: "settle",
					settlement:
						action.variant % 3 === 0
							? { kind: "project_inactive" }
							: {
									kind: "session_ended",
									cause:
										action.variant % 2 === 0
											? "usage_limit_failover"
											: "native_session_vanished",
								},
				};
				break;
			case 9: {
				const index =
					this.held.length === 0 ? 0 : action.index % this.held.length;
				command = this.held.splice(index, 1)[0] ?? {
					verb: "control",
					control: { kind: "resume" },
				};
				break;
			}
			case 10:
				command = at(this.delivered, action.index) ?? {
					verb: "control",
					control: { kind: "stop" },
				};
				break;
			default:
				command = {
					verb: "control",
					control: {
						kind: "answer",
						interactionId: this.interaction(snapshot, action.index),
						answer: `answer:${action.input}`,
					},
				};
		}
		if (command.verb === "observe" || command.verb === "settle")
			this.delivered.push(command);
		return { command, now };
	}
}
