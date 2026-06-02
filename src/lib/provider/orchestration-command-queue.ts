import { Deferred, Effect, Exit } from "effect";

export class DurableCommandQueue<A = unknown, E = unknown> {
	private readonly inFlightByCommandId = new Map<
		string,
		Deferred.Deferred<A, E>
	>();
	private tail: Deferred.Deferred<void> | undefined;

	run<R>(
		commandId: string,
		work: Effect.Effect<A, E, R>,
	): Effect.Effect<A, E, R> {
		return Effect.gen(this, function* () {
			const completion = yield* Deferred.make<A, E>();
			const releaseTail = yield* Deferred.make<void>();
			const existing = this.inFlightByCommandId.get(commandId);
			if (existing) return yield* Deferred.await(existing);

			const previousTail = this.tail;

			this.inFlightByCommandId.set(commandId, completion);
			this.tail = releaseTail;

			const exit = yield* (
				previousTail
					? Deferred.await(previousTail).pipe(Effect.zipRight(work))
					: work
			).pipe(Effect.exit);

			yield* Deferred.done(completion, exit);
			yield* Deferred.succeed(releaseTail, undefined);
			yield* Effect.sync(() => {
				if (this.inFlightByCommandId.get(commandId) === completion) {
					this.inFlightByCommandId.delete(commandId);
				}
				if (this.tail === releaseTail) {
					this.tail = undefined;
				}
			});

			return yield* Exit.matchEffect(exit, {
				onFailure: Effect.failCause,
				onSuccess: Effect.succeed,
			});
		});
	}
}
