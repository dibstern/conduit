import type { CanonicalToolInput } from "../../../persistence/events.js";
import { registerSummarizer } from "./registry.js";
import type {
	SummarizerContext,
	ToolSummarizer,
	ToolSummary,
} from "./types.js";

type EditInput = Extract<CanonicalToolInput, { tool: "Edit" }>;

function stripRepoRoot(filePath: string, repoRoot?: string): string {
	if (!repoRoot) return filePath;
	const prefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
	return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
}

export const editSummarizer: ToolSummarizer<EditInput> = {
	tool: "Edit",
	summarize(input: EditInput, ctx: SummarizerContext): ToolSummary {
		const filePath = input.filePath || undefined;
		return {
			...(filePath && {
				subtitle: stripRepoRoot(filePath, ctx.repoRoot),
			}),
			...(input.oldString &&
				input.newString && {
					expandedContent: {
						kind: "diff" as const,
						before: input.oldString,
						after: input.newString,
					},
				}),
		};
	},
};

registerSummarizer(editSummarizer);
