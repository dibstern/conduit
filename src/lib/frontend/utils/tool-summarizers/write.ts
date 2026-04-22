import type { CanonicalToolInput } from "../../../persistence/events.js";
import { registerSummarizer } from "./registry.js";
import type {
	SummarizerContext,
	ToolSummarizer,
	ToolSummary,
} from "./types.js";

type WriteInput = Extract<CanonicalToolInput, { tool: "Write" }>;

function stripRepoRoot(filePath: string, repoRoot?: string): string {
	if (!repoRoot) return filePath;
	const prefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
	return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
}

export const writeSummarizer: ToolSummarizer<WriteInput> = {
	tool: "Write",
	summarize(input: WriteInput, ctx: SummarizerContext): ToolSummary {
		const filePath = input.filePath || undefined;
		return {
			...(filePath && {
				subtitle: stripRepoRoot(filePath, ctx.repoRoot),
			}),
		};
	},
};

registerSummarizer(writeSummarizer);
