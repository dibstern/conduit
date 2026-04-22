import type { CanonicalToolInput } from "../../../persistence/events.js";
import type {
	SummarizerContext,
	ToolSummarizer,
	ToolSummary,
} from "./types.js";

type UnknownInput = Extract<CanonicalToolInput, { tool: "Unknown" }>;

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}...` : s;
}

export const unknownSummarizer: ToolSummarizer<UnknownInput> = {
	tool: "Unknown",
	summarize(input: UnknownInput, _ctx: SummarizerContext): ToolSummary {
		const json = JSON.stringify(input.raw);
		return {
			subtitle: truncate(json, 60),
			expandedContent: {
				kind: "text",
				body: JSON.stringify(input.raw, null, 2),
			},
		};
	},
};
