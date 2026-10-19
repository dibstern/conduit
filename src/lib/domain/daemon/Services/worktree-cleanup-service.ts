import { Context, Deferred, Effect, Layer, Queue } from "effect";
import type { WorktreeCleanupReport } from "../../../contracts/worktree.js";
import { WsRpcError } from "../../../contracts/ws-rpc.js";

export interface WorktreeCleanupRequest {
	readonly projectSlug?: string;
	readonly completion?: Deferred.Deferred<WorktreeCleanupReport>;
}

export class WorktreeCleanupQueueTag extends Context.Service<
	WorktreeCleanupQueueTag,
	Queue.Queue<WorktreeCleanupRequest>
>()("WorktreeCleanupQueue") {}

export const WorktreeCleanupQueueLive = Layer.effect(
	WorktreeCleanupQueueTag,
	Effect.acquireRelease(
		Queue.unbounded<WorktreeCleanupRequest>(),
		Queue.shutdown,
	),
);

// Standalone test relays can save the setting, but only the daemon runs a sweep.
export const requestWorktreeCleanup = (projectSlug?: string) =>
	Effect.gen(function* () {
		const queue = yield* Effect.serviceOption(WorktreeCleanupQueueTag);
		if (queue._tag === "Some")
			yield* Queue.offer(queue.value, {
				...(projectSlug !== undefined && { projectSlug }),
			});
	});

export const cleanUpWorktreesNow = (projectSlug?: string) =>
	Effect.gen(function* () {
		const queue = yield* Effect.serviceOption(WorktreeCleanupQueueTag);
		if (queue._tag === "None")
			return yield* new WsRpcError({
				message: "Worktree cleanup requires the daemon",
			});
		const completion = yield* Deferred.make<WorktreeCleanupReport>();
		yield* Queue.offer(queue.value, {
			...(projectSlug !== undefined && { projectSlug }),
			completion,
		});
		return yield* Deferred.await(completion);
	});
