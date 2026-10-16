import { expectTypeOf, it } from "vitest";
import type { LiveEventType } from "../../../../src/lib/contracts/stored-event.js";
import { CLAUDE_EVENT_CLASSIFICATION } from "../../../../src/lib/provider/claude/event-type-guard.js";

it("requires a Claude classification for every live event", () => {
	const { "session.created": _missing, ...incomplete } =
		CLAUDE_EVENT_CLASSIFICATION;

	// @ts-expect-error A record missing a live event is not a total classification.
	incomplete satisfies Record<LiveEventType, unknown>;

	expectTypeOf<
		keyof typeof CLAUDE_EVENT_CLASSIFICATION
	>().toEqualTypeOf<LiveEventType>();
});
