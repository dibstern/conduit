import { Effect } from "effect";
import type { ProviderStateEffect } from "../../persistence/effect/provider-state-effect.js";
import type { ReadQueryEffect } from "../../persistence/effect/read-query-effect.js";
import { renderForkDigest } from "../fork-digest.js";
import type { SessionTurn } from "./session-runner.js";

export const resolveRunnerForkDigest = (
	input: Pick<SessionTurn, "sessionId" | "providerState">,
	providerStateKey: string,
	persistence?: {
		readonly read: ReadQueryEffect;
		readonly state: ProviderStateEffect;
	},
) =>
	Effect.gen(function* () {
		const supplied = input.providerState[providerStateKey];
		if (typeof supplied === "string" || !persistence) return supplied;
		const { read, state } = persistence;
		const stored = (yield* state.getState(input.sessionId))[providerStateKey];
		if (stored !== undefined) return stored;
		const session = yield* read.getSession(input.sessionId);
		if (
			!session?.forked_from &&
			!(session?.side_thread === 1 && session.parent_id)
		)
			return undefined;
		const inherited = (yield* read.getSessionMessagesWithParts(
			input.sessionId,
		)).filter((message) => message.is_inherited === 1);
		if (inherited.length === 0) return undefined;
		const rendered = renderForkDigest(inherited);
		// Persist before the runner hop so rejected sends and recovery reuse the snapshot.
		yield* state.saveUpdates(input.sessionId, [
			{ key: providerStateKey, value: rendered },
		]);
		return rendered;
	});
