import type { CanonicalToolInput } from "../../../persistence/events.js";

export type ToolSummary = {
	subtitle?: string;
	tags?: string[];
	expandedContent?: ExpandedContent;
};

export type ExpandedContent =
	| { kind: "code"; language: string; content: string }
	| { kind: "path"; filePath: string; offset?: number; limit?: number }
	| { kind: "link"; url: string; label: string }
	| { kind: "diff"; before: string; after: string }
	| { kind: "text"; body: string };

export interface SummarizerContext {
	repoRoot?: string;
}

export type ToolSummarizer<I extends CanonicalToolInput = CanonicalToolInput> =
	{
		readonly tool: I["tool"];
		summarize(input: I, ctx: SummarizerContext): ToolSummary;
	};
