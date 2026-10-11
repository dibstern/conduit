import type { CanonicalToolInput } from "../../../persistence/events.js";
import { registerSummarizer } from "./registry.js";
import type {
	SummarizerContext,
	ToolSummarizer,
	ToolSummary,
} from "./types.js";
import { unknownSummarizer } from "./unknown.js";

type PatchInput = Extract<CanonicalToolInput, { tool: "Patch" | "Unknown" }>;

export const patchSummarizer: ToolSummarizer<PatchInput> = {
	tool: "Patch",
	summarize(input: PatchInput, ctx: SummarizerContext): ToolSummary {
		if (input.tool === "Unknown")
			return unknownSummarizer.summarize(input, ctx);
		const repoPrefix = ctx.repoRoot
			? ctx.repoRoot.endsWith("/")
				? ctx.repoRoot
				: `${ctx.repoRoot}/`
			: undefined;
		const paths = input.filePaths.map((path) =>
			repoPrefix && path.startsWith(repoPrefix)
				? path.slice(repoPrefix.length)
				: path,
		);
		return {
			...(paths.length > 0 && { subtitle: paths.join(", ") }),
			expandedContent: { kind: "code", language: "diff", content: input.patch },
		};
	},
};

registerSummarizer(patchSummarizer, ["ApplyPatch", "apply_patch"]);
