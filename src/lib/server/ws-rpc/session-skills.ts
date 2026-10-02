import { Effect } from "effect";
import { getSkillNamesForSession } from "../../handlers/settings.js";
import { ReadQueryEffectTag } from "../../persistence/effect/read-query-effect.js";
import { collectSessionSkillLoads } from "../../session/session-skills.js";
import { mapRpcFailure, type WsRpcHandlerMap } from "./shared.js";

export const sessionSkillsHandlers = {
	GetSessionSkills: (request) =>
		Effect.gen(function* () {
			const readQuery = yield* ReadQueryEffectTag;
			const messages = yield* readQuery.getSessionMessagesWithParts(
				request.sessionId,
			);
			const names = yield* getSkillNamesForSession(request.sessionId);
			return { loads: collectSessionSkillLoads(messages, names) };
		}).pipe(Effect.catchAll(mapRpcFailure("GetSessionSkills"))),
} satisfies Pick<WsRpcHandlerMap, "GetSessionSkills">;
