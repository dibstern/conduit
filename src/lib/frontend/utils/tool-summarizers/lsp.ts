import type { CanonicalToolInput } from "../../../persistence/events.js";
import { registerSummarizer } from "./registry.js";
import type {
	SummarizerContext,
	ToolSummarizer,
	ToolSummary,
} from "./types.js";

type LSPInput = Extract<CanonicalToolInput, { tool: "LSP" }>;

function stripRepoRoot(filePath: string, repoRoot?: string): string {
	if (!repoRoot) return filePath;
	const prefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
	return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
}

export const lspSummarizer: ToolSummarizer<LSPInput> = {
	tool: "LSP",
	summarize(input: LSPInput, ctx: SummarizerContext): ToolSummary {
		const operation = input.operation || undefined;
		const tags: string[] = [];
		if (input.filePath) tags.push(stripRepoRoot(input.filePath, ctx.repoRoot));
		return {
			...(operation && { subtitle: operation }),
			...(tags.length > 0 && { tags }),
		};
	},
};

registerSummarizer(lspSummarizer);
