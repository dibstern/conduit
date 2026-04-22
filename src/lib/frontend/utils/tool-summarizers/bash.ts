/**
 * Bash summarizer.
 *
 * Subtitle preference: `command` first, `description` fallback.
 *
 * Rationale: the user wants to see what actually ran, not what the model
 * claimed it would do. `description` is model-authored narrative prose;
 * `command` is the shell string that was executed. When both exist, the
 * shell string is more informative and more verifiable.
 */
import type { CanonicalToolInput } from "../../../persistence/events.js";
import { registerSummarizer } from "./registry.js";
import type {
	SummarizerContext,
	ToolSummarizer,
	ToolSummary,
} from "./types.js";

type BashInput = Extract<CanonicalToolInput, { tool: "Bash" }>;

export const bashSummarizer: ToolSummarizer<BashInput> = {
	tool: "Bash",
	summarize(input: BashInput, _ctx: SummarizerContext): ToolSummary {
		const command = input.command || undefined;
		const description = input.description || undefined;

		const subtitle = command
			? command.length > 40
				? `${command.slice(0, 40)}\u2026`
				: command
			: description;

		return {
			...(subtitle && { subtitle }),
			...(command && {
				expandedContent: {
					kind: "code" as const,
					language: "shell",
					content: `$ ${command}`,
				},
			}),
		};
	},
};

registerSummarizer(bashSummarizer);
