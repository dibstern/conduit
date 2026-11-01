/**
 * The traces 32.2.17 replays and permutes (CONTRACT.md 3592): the catalogue's, the reviews' and the
 * generator's, each as the oracle's timed commands.
 */
import fc from "fast-check";
import type {
	LedgerCommand,
	ProviderKind,
} from "../../../../src/lib/provider/run-ledger/run-ledger-model.js";
import { traceAction } from "./fake-provider.js";
import { TraceDriver } from "./harness.js";
import { reviewTraces } from "./review-traces.js";
import { Driver, type Stepped, scenarios } from "./scenarios.js";

export interface Timed {
	readonly command: LedgerCommand;
	readonly now: number;
}
export interface Trace {
	readonly id: string;
	readonly provider: ProviderKind;
	readonly steps: readonly Timed[];
}

export const providers = ["claude", "codex", "cursor", "opencode"] as const;
const generatedRuns = 12;
const generatedCommands = 40;

/** Records a catalogue scenario's commands; the WeakMap is set before a subclass field could be. */
const recorded = new WeakMap<Driver, Timed[]>();
class RecordingDriver extends Driver {
	override step(command: LedgerCommand, now?: number): Stepped {
		const stepped = super.step(command, now);
		recorded.set(this, [
			...(recorded.get(this) ?? []),
			{ command, now: this.now },
		]);
		return stepped;
	}
}

export function catalogueTraces(): Trace[] {
	return scenarios.map((scenario) => {
		const d = new RecordingDriver(scenario.provider);
		scenario.run(d);
		return {
			id: `catalogue ${scenario.id}`,
			provider: scenario.provider,
			steps: recorded.get(d) ?? [],
		};
	});
}

/** A review or generated trace may stop at a fake-side check; its oracle steps so far still stand. */
function traceDriverTrace(
	id: string,
	provider: ProviderKind,
	drive: (d: TraceDriver) => void,
): Trace {
	const d = new TraceDriver(provider);
	try {
		drive(d);
	} catch {}
	return { id, provider, steps: d.commands };
}

function generatedTraces(provider: ProviderKind): Trace[] {
	return fc
		.sample(
			fc.array(traceAction, {
				minLength: generatedCommands,
				maxLength: generatedCommands,
			}),
			{
				seed: 82_217_000,
				numRuns: generatedRuns,
			},
		)
		.map((actions, run) =>
			traceDriverTrace(`generated ${provider} ${run}`, provider, (d) => {
				d.step({
					verb: "settle",
					settlement: {
						kind: "process_started",
						label: d.label,
						reattached: false,
					},
				});
				for (const action of actions) {
					const packet = d.host.next(action, {
						issued: d.issued,
						view: d.view(),
						now: d.now,
						alarmAt: d.alarmAt,
					});
					d.step(packet.command, packet.now);
				}
			}),
		);
}

/** Every catalogue, review and generated trace. */
export const allTraces = (): Trace[] => [
	...catalogueTraces(),
	...reviewTraces.map((trace) =>
		traceDriverTrace(`review ${trace.id}`, trace.provider, trace.run),
	),
	...providers.flatMap(generatedTraces),
];
