import type { CanonicalToolInput } from "../../../persistence/events.js";
import { registerSummarizer } from "./registry.js";
import type {
	SummarizerContext,
	ToolSummarizer,
	ToolSummary,
} from "./types.js";

type GrepInput = Extract<CanonicalToolInput, { tool: "Grep" }>;

function stripRepoRoot(filePath: string, repoRoot?: string): string {
	if (!repoRoot) return filePath;
	const prefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
	return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
}

export const grepSummarizer: ToolSummarizer<GrepInput> = {
	tool: "Grep",
	summarize(input: GrepInput, ctx: SummarizerContext): ToolSummary {
		const pattern = input.pattern || undefined;
		const tags: string[] = [];
		if (input.include) tags.push(input.include);
		if (input.fileType) tags.push(input.fileType);
		if (input.path) tags.push(stripRepoRoot(input.path, ctx.repoRoot));
		return {
			...(pattern && { subtitle: pattern }),
			...(tags.length > 0 && { tags }),
		};
	},
};

registerSummarizer(grepSummarizer);
