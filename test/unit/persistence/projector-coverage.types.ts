// Compiled by pnpm check. Coverage must reject missing reasons, stale reasons,
// widened handled lists, and bodies that inspect events outside their list.
import { Effect } from "effect";
import type { LiveEventType } from "../../../src/lib/contracts/stored-event.js";
import {
	defineProjector,
	UNPROJECTED,
	type UnprojectedReasons,
} from "../../../src/lib/persistence/effect/projectors-effect.js";

// @ts-expect-error This live event is neither handled nor given a reason.
const missingReason: typeof UNPROJECTED = {
	"session.provider_cleanup_failed": "Audit receipt only",
};
void missingReason;

const staleReason: typeof UNPROJECTED = {
	...UNPROJECTED,
	// @ts-expect-error A handled live event cannot be listed as unprojected.
	"session.created": "Already projected",
};
void staleReason;

const noUnhandledReasons: UnprojectedReasons<never> = {
	// @ts-expect-error Stale reasons are rejected even when every event is handled.
	"session.handoff_delivered": "Already projected",
};
void noUnhandledReasons;

const widenedHandles: readonly LiveEventType[] = ["turn.completed"];
defineProjector(() => ({
	name: "widened-type-check",
	// @ts-expect-error A widened array cannot claim every live event.
	handles: widenedHandles,
	project: () => Effect.succeed({ stamped: [], removed: [], collections: [] }),
}));

const makeProjector = defineProjector(() => ({
	name: "type-check",
	handles: ["turn.completed"],
	project(event) {
		const messageId: string = event.data.messageId;
		void messageId;
		// @ts-expect-error The body only receives events declared in handles.
		if (event.type === "session.created") throw new Error("Unlisted event");
		return Effect.succeed({ stamped: [], removed: [], collections: [] });
	},
}));

const literalHandles: readonly ["turn.completed"] = makeProjector().handles;
void literalHandles;

defineProjector(() => ({
	name: "retired-type-check",
	// @ts-expect-error Retired events decode but cannot be handled by projectors.
	handles: ["session.read"],
	project: () => Effect.succeed({ stamped: [], removed: [], collections: [] }),
}));
