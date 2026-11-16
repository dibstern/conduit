import { Effect, Option } from "effect";
import type { InputDraftKey } from "../contracts/ws-rpc.js";
import { DraftPreWarmTag } from "../domain/project-services/Services/draft-prewarm.js";
import { InputDraftsTag } from "../domain/project-services/Services/input-drafts.js";
import { ConfigTag } from "../domain/project-services/Services/services.js";

export const syncInputDraft = ({
	key,
	text,
	from,
}: {
	key: InputDraftKey;
	text: string;
	from?: string;
}) =>
	Effect.gen(function* () {
		const drafts = yield* InputDraftsTag;
		const projectId = "draft" in key ? (yield* ConfigTag).slug : undefined;
		yield* drafts.write(key, text, from, projectId);
		if ("draft" in key && text === "") {
			const warm = yield* Effect.serviceOption(DraftPreWarmTag);
			if (Option.isSome(warm)) yield* warm.value.discardDraft(key.draft);
		}
	});
