import type { CanonicalToolInput } from "../../../persistence/events.js";
import { registerSummarizer } from "./registry.js";
import type {
	SummarizerContext,
	ToolSummarizer,
	ToolSummary,
} from "./types.js";

type WebFetchInput = Extract<CanonicalToolInput, { tool: "WebFetch" }>;

function extractHostname(url: string): string | undefined {
	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
}

export const webFetchSummarizer: ToolSummarizer<WebFetchInput> = {
	tool: "WebFetch",
	summarize(input: WebFetchInput, _ctx: SummarizerContext): ToolSummary {
		const url = input.url || undefined;
		const hostname = url ? extractHostname(url) : undefined;
		return {
			...(hostname && { subtitle: hostname }),
			...(url && {
				expandedContent: {
					kind: "link" as const,
					url,
					label: hostname ?? url,
				},
			}),
		};
	},
};

registerSummarizer(webFetchSummarizer);
