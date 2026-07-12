export type VisualMode = "assert" | "capture";

export function currentVisualMode(): VisualMode {
	return process.env["VISUAL_ACCEPTANCE_MODE"] === "capture"
		? "capture"
		: "assert";
}
