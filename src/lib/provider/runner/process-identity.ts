import { Schema } from "effect";

export const StartTime = Schema.NonEmptyString.pipe(Schema.brand("StartTime"));
export type StartTime = typeof StartTime.Type;
export const ProcessStart = Schema.Struct({
	startTime: StartTime,
	startKey: Schema.optionalKey(Schema.String),
});
export type ProcessStart = typeof ProcessStart.Type;
export type Observed =
	| ({
			readonly state: "running" | "zombie";
			readonly pgid?: number;
	  } & ProcessStart)
	| { readonly state: "gone" | "unknown" };
export const ProcessMember = Schema.Struct({
	pid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
	...ProcessStart.fields,
});
export type ProcessMember = typeof ProcessMember.Type;

export function sameProcess(
	recorded: {
		readonly pid: number;
		readonly startTime?: string | undefined;
		readonly startKey?: string | undefined;
	},
	seen: Observed | undefined,
): "same" | "gone" | "unknown" {
	if (seen?.state !== "running")
		return seen?.state === "gone" || seen?.state === "zombie"
			? "gone"
			: "unknown";
	const scheme = recorded.startKey?.split(":", 1)[0];
	if (
		(scheme === "d" || scheme === "l") &&
		seen.startKey?.startsWith(`${scheme}:`)
	)
		return recorded.startKey === seen.startKey ? "same" : "gone";
	if (recorded.startTime === undefined) return "unknown";
	return recorded.startTime === seen.startTime ? "same" : "gone";
}
