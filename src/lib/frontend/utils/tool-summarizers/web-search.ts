import type { CanonicalToolInput } from "../../../persistence/events.js";
import { registerSummarizer } from "./registry.js";
import type {
	SummarizerContext,
	ToolSummarizer,
	ToolSummary,
} from "./types.js";

type WebSearchInput = Extract<CanonicalToolInput, { tool: "WebSearch" }>;

export const webSearchSummarizer: ToolSummarizer<WebSearchInput> = {
	tool: "WebSearch",
	summarize(input: WebSearchInput, _ctx: SummarizerContext): ToolSummary {
		const query = input.query || undefined;
		return {
			...(query && { subtitle: query }),
		};
	},
};

registerSummarizer(webSearchSummarizer);
