import type { CanonicalToolInput } from "../../../persistence/events.js";
import { registerSummarizer } from "./registry.js";
import type {
	SummarizerContext,
	ToolSummarizer,
	ToolSummary,
} from "./types.js";

type TaskInput = Extract<CanonicalToolInput, { tool: "Task" }>;

export const taskSummarizer: ToolSummarizer<TaskInput> = {
	tool: "Task",
	summarize(input: TaskInput, _ctx: SummarizerContext): ToolSummary {
		const description = input.description || undefined;
		const subagentType = input.subagentType || undefined;
		return {
			...(description && { subtitle: description }),
			...(subagentType && { tags: [subagentType] }),
		};
	},
};

registerSummarizer(taskSummarizer);
