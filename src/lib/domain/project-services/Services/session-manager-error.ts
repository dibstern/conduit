import { Data } from "effect";

export class SessionManagerError extends Data.TaggedError(
	"SessionManagerError",
)<{
	operation: string;
	cause: unknown;
}> {}
