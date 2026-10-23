import assert from "node:assert/strict";
import {
	decide,
	evolve,
	initialSessionLedgerState,
	viewLedger,
} from "../../../../src/lib/provider/run-ledger/run-ledger-decider.js";
import type {
	IssuedEffect,
	LedgerCommand,
	LedgerView,
	ProviderKind,
	RunEffect,
	SendToken,
} from "../../../../src/lib/provider/run-ledger/run-ledger-model.js";
import {
	HistoryReference,
	type Mutation,
	policy,
	type ReferenceResult,
} from "./reference.js";

export { policy };

/** Both drivers expose only public views and outputs. Events are solely folded. */
export class TraceDriver {
	now = 100;
	lastEventCount = 0;
	alarmAt: number | undefined;
	private serial = 0;
	private readonly reference: HistoryReference;
	private state: ReturnType<typeof initialSessionLedgerState>;
	private readonly transmissions: IssuedEffect[] = [];

	constructor(
		readonly provider: ProviderKind,
		readonly mode: "reference" | "decider" = "reference",
		mutation?: Mutation,
	) {
		this.reference = new HistoryReference(provider, mutation);
		this.state = initialSessionLedgerState("oracle-session", provider);
	}

	step(command: LedgerCommand, now = this.now + 1): ReferenceResult {
		this.now = now;
		if (this.mode === "reference") {
			const before = JSON.stringify(this.view());
			const result = this.reference.step(command, now);
			if (result.tag === "Accepted") this.alarmAt = result.alarmAt;
			this.lastEventCount =
				before === JSON.stringify(this.view()) &&
				!result.effects.length &&
				!result.ended.length
					? 0
					: 1;
			return result;
		}
		const translate = (token: SendToken): SendToken => {
			const index = this.transmissions.findIndex(
				(send) => send.token === token,
			);
			return this.reference.issued[index]?.token ?? token;
		};
		const expected = this.reference.step(
			command.verb === "observe"
				? {
						...command,
						observation: {
							...command.observation,
							token: translate(command.observation.token),
						},
					}
				: command.verb === "settle" && "token" in command.settlement
					? {
							...command,
							settlement: {
								...command.settlement,
								token: translate(command.settlement.token),
							},
						}
					: command,
			now,
		);
		const result = decide(this.state, command, {
			now,
			policy,
			newId: () => `decider-id-${++this.serial}`,
		});
		if (result.tag === "Rejected") {
			this.lastEventCount = 0;
			return { ...result, effects: [], ended: [] };
		}
		assert.equal(
			result.alarmAt,
			expected.alarmAt,
			"[step1] alarmAt after every accepted command",
		);
		this.alarmAt = result.alarmAt;
		this.lastEventCount = result.events.length;
		this.state = result.events.reduce(evolve, this.state);
		this.transmissions.push(...result.effects);
		return {
			tag: result.tag,
			effects: result.effects,
			ended: result.ended,
			...(result.alarmAt !== undefined ? { alarmAt: result.alarmAt } : {}),
		};
	}

	view(): LedgerView {
		return this.mode === "reference"
			? this.reference.view()
			: viewLedger(this.state);
	}
	get issued(): readonly IssuedEffect[] {
		return this.mode === "reference"
			? this.reference.issued
			: this.transmissions;
	}
	latest(
		kind: RunEffect["kind"],
		predicate?: (effect: RunEffect) => boolean,
	): IssuedEffect {
		const send = this.issued
			.slice()
			.reverse()
			.find(
				(item) =>
					item.effect.kind === kind && (!predicate || predicate(item.effect)),
			);
		assert(send, `trace has no issued ${kind} matching the selector`);
		return send;
	}
}
