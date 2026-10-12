import { Data, type Effect } from "effect";

export class SessionTitleGenerationFailure extends Data.TaggedError(
	"SessionTitleGenerationFailure",
)<{
	readonly reason: string;
}> {}

export type TitleGenerator = (input: {
	readonly prompt: string;
	readonly cwd: string;
}) => Effect.Effect<string, SessionTitleGenerationFailure>;

export function generationFailureReason(cause: unknown): string {
	if (cause instanceof SessionTitleGenerationFailure) return cause.reason;
	if (cause instanceof Error) return cause.message;
	return String(cause);
}
