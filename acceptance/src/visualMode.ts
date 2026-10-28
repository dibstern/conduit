export type VisualMode = "assert" | "capture" | "skip";

export function currentVisualMode(baseline?: string): VisualMode {
	const mode = process.env["VISUAL_ACCEPTANCE_MODE"];
	if (mode === "skip") return "skip";
	const selected = process.env["VISUAL_ACCEPTANCE_CAPTURE_BASELINES"];
	return mode === "capture" &&
		(!selected || selected.split(",").includes(baseline ?? ""))
		? "capture"
		: "assert";
}
