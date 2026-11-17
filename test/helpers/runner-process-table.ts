import { Schema } from "effect";
import {
	makeMemoryProcessAdapter,
	makeProcessTable,
	type Observed,
	StartTime,
} from "../../src/lib/provider/runner/process-table.js";

type TestProcess = {
	readonly state: "running" | "zombie" | "gone" | "unknown";
	readonly startTime?: string;
	readonly startKey?: string;
	readonly pgid?: number;
};

const started = Schema.decodeUnknownSync(StartTime);

export const testProcess = (process: TestProcess): Observed =>
	process.state === "running" || process.state === "zombie"
		? process.startTime === undefined && process.state === "running"
			? { state: "unknown" }
			: {
					...process,
					state: process.state,
					startTime: started(process.startTime ?? "unrecorded-zombie"),
				}
		: { state: process.state };

/** Keep mutable fixture facts while exercising the production pin and signal rules. */
export const makeTestProcessTable = (input: {
	readonly processes:
		| ReadonlyMap<number, TestProcess>
		| (() => ReadonlyMap<number, TestProcess>);
	readonly signal?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
}) => {
	const facts = () =>
		typeof input.processes === "function" ? input.processes() : input.processes;
	const adapter = makeMemoryProcessAdapter({
		get processes() {
			return new Map(
				[...facts()].map(([pid, seen]) => [pid, testProcess(seen)]),
			);
		},
		...(input.signal ? { signal: input.signal } : {}),
	});
	return { ...makeProcessTable(adapter), calls: adapter.calls };
};
