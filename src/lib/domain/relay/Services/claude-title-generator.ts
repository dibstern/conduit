import { Duration, Effect, Schema } from "effect";
import type { Logger } from "../../../logger.js";
import type { ClaudeConfigDir } from "../../../provider/claude/claude-sdk-env.js";
import {
	type ClaudeOneShotQueryFactory,
	makeClaudeOneShot,
} from "../../daemon/Services/claude-one-shot.js";
import {
	generationFailureReason,
	SessionTitleGenerationFailure,
	type TitleGenerator,
} from "./title-generator.js";

const TITLE_GENERATION_TIMEOUT = Duration.seconds(30);
const TITLE_SYSTEM_PROMPT =
	"You write concise sidebar titles for coding-assistant sessions.";

export type ClaudeTitleQueryFactory = ClaudeOneShotQueryFactory;

export const makeClaudeTitleGenerator = (options: {
	readonly model: string;
	readonly configDir: ClaudeConfigDir;
	readonly log: Logger;
	readonly queryFactory?: ClaudeTitleQueryFactory;
}): TitleGenerator => {
	return ({ prompt, cwd }) =>
		makeClaudeOneShot({
			configDir: options.configDir,
			cwd,
			systemPrompt: TITLE_SYSTEM_PROMPT,
			onStderr: (data) =>
				options.log.debug(`Claude title generation stderr: ${data}`),
			...(options.queryFactory === undefined
				? {}
				: { queryFactory: options.queryFactory }),
		})
			.ask(prompt, Schema.String, options.model)
			.pipe(
				Effect.mapError(
					(failure) =>
						new SessionTitleGenerationFailure({
							reason:
								failure.reason === "empty"
									? "Claude returned no title text"
									: generationFailureReason(failure.cause),
						}),
				),
				Effect.timeoutFail({
					duration: TITLE_GENERATION_TIMEOUT,
					onTimeout: () =>
						new SessionTitleGenerationFailure({
							reason: "Timed out waiting for Claude title generation",
						}),
				}),
			);
};
