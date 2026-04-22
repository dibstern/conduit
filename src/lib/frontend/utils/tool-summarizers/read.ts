import type { CanonicalToolInput } from "../../../persistence/events.js";
import { registerSummarizer } from "./registry.js";
import type {
	SummarizerContext,
	ToolSummarizer,
	ToolSummary,
} from "./types.js";

type ReadInput = Extract<CanonicalToolInput, { tool: "Read" }>;

function stripRepoRoot(filePath: string, repoRoot?: string): string {
	if (!repoRoot) return filePath;
	const prefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
	return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
}

export const readSummarizer: ToolSummarizer<ReadInput> = {
	tool: "Read",
	summarize(input: ReadInput, ctx: SummarizerContext): ToolSummary {
		const filePath = input.filePath || undefined;
		const tags: string[] = [];
		if (input.offset != null) tags.push(`offset:${input.offset}`);
		if (input.limit != null) tags.push(`limit:${input.limit}`);
		return {
			...(filePath && {
				subtitle: stripRepoRoot(filePath, ctx.repoRoot),
			}),
			...(tags.length > 0 && { tags }),
			...(filePath && {
				expandedContent: {
					kind: "path" as const,
					filePath: input.filePath,
					...(input.offset != null && { offset: input.offset }),
					...(input.limit != null && { limit: input.limit }),
				},
			}),
		};
	},
};

registerSummarizer(readSummarizer);
