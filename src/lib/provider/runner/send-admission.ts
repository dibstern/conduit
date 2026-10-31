import { Clock, Data, Effect } from "effect";
import { createLogger } from "../../logger.js";

export const SEND_ADMISSION_GRACE_MS = 1_000;

type WaitReason =
	| "foldersPending"
	| "loginPending"
	| "legacyCursor"
	| "retunePending";

export class SendAdmissionTimeout extends Data.TaggedError(
	"SendAdmissionTimeout",
)<{ readonly reason: WaitReason }> {
	readonly operation = "send-turn";
	readonly code = "send_admission_timeout";
	readonly retryable = false;
	get message(): string {
		return `Message wasn't sent because the runner is waiting (${this.reason}). Wait for running work to finish, then resend.`;
	}
}

/** One budget from the first wait, including retries and changing wait reasons. */
export function makeSendAdmissionWait(sessionId: string, inputId: string) {
	let startedAt: number | undefined;
	return <A, E, R>(reason: WaitReason, effect: Effect.Effect<A, E, R>) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;
			startedAt ??= now;
			const refuse = Effect.sync(() => {
				createLogger("send-admission").warn(
					`send_admission_timeout sessionId=${sessionId} inputId=${inputId} reason=${reason} limitMs=${SEND_ADMISSION_GRACE_MS}`,
				);
				return new SendAdmissionTimeout({ reason });
			}).pipe(Effect.flatMap(Effect.fail));
			const remaining = SEND_ADMISSION_GRACE_MS - (now - startedAt);
			if (remaining <= 0) return yield* refuse;
			return yield* effect.pipe(
				Effect.timeoutOrElse({ duration: remaining, orElse: () => refuse }),
			);
		});
}
