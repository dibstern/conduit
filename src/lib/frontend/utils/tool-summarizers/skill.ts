import type { CanonicalToolInput } from "../../../persistence/events.js";
import { registerSummarizer } from "./registry.js";
import type {
	SummarizerContext,
	ToolSummarizer,
	ToolSummary,
} from "./types.js";

type SkillInput = Extract<CanonicalToolInput, { tool: "Skill" }>;

export const skillSummarizer: ToolSummarizer<SkillInput> = {
	tool: "Skill",
	summarize(input: SkillInput, _ctx: SummarizerContext): ToolSummary {
		const skillName = input.name || undefined;
		return {
			...(skillName && { subtitle: skillName }),
		};
	},
};

registerSummarizer(skillSummarizer);
