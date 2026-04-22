import type { CanonicalToolInput } from "../../../persistence/events.js";
import { registerSummarizer } from "./registry.js";
import type {
	SummarizerContext,
	ToolSummarizer,
	ToolSummary,
} from "./types.js";

type AskUserQuestionInput = Extract<
	CanonicalToolInput,
	{ tool: "AskUserQuestion" }
>;

export const askUserQuestionSummarizer: ToolSummarizer<AskUserQuestionInput> = {
	tool: "AskUserQuestion",
	summarize(input: AskUserQuestionInput, _ctx: SummarizerContext): ToolSummary {
		const questions = input.questions as
			| { header?: string; question?: string }[]
			| undefined
			| null;
		if (Array.isArray(questions) && questions.length > 0) {
			const first = questions[0];
			const subtitle = first?.header || first?.question;
			return {
				subtitle: subtitle
					? subtitle.length > 60
						? `${subtitle.slice(0, 60)}\u2026`
						: subtitle
					: "Question",
			};
		}
		return { subtitle: "Question" };
	},
};

registerSummarizer(askUserQuestionSummarizer);
