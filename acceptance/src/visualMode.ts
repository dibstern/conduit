export type VisualMode = "assert" | "capture";

export function currentVisualMode(baseline?: string): VisualMode {
	const selected = process.env["VISUAL_ACCEPTANCE_CAPTURE_BASELINES"];
	return process.env["VISUAL_ACCEPTANCE_MODE"] === "capture" &&
		(!selected || selected.split(",").includes(baseline ?? ""))
		? "capture"
		: "assert";
}
