import { Data } from "effect";

export class CursorSdkFailure extends Data.TaggedError("CursorSdkFailure")<{
	readonly operation: string;
	readonly reason: string;
}> {
	override get message(): string {
		return this.reason;
	}
}
