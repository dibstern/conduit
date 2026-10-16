import { Data } from "effect";

export class CursorSdkFailure extends Data.TaggedError("CursorSdkFailure")<{
	readonly operation: string;
	readonly reason: string;
	readonly authRequired?: boolean;
}> {
	override get message(): string {
		return this.reason;
	}
}
