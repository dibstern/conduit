import { expect, expectTypeOf, it } from "vitest";
import {
	BROWSER_MESSAGE_TYPES,
	type BrowserMessage,
} from "../../../src/lib/shared-types.js";

// conduit-test-ni8.12/.13/.14/.15: frames whose data now comes only from RPC
// replies (or from nowhere). Asserted at the union so a reintroduction fails.
const RETIRED_MESSAGE_TYPES = [
	"file_tree",
	"file_list",
	"file_content",
	"file_changed",
	"file_history_result",
	"scan_result",
	"agent_list",
	"model_list",
	"command_list",
	"banner",
	"skip_permissions",
	"proxy_detected",
	"update_available",
	"instance_status",
] as const;

it("retired push frames are absent from the BrowserMessage union", () => {
	expectTypeOf<
		Extract<BrowserMessage, { type: (typeof RETIRED_MESSAGE_TYPES)[number] }>
	>().toBeNever();
	expect(
		BROWSER_MESSAGE_TYPES.filter((type) =>
			(RETIRED_MESSAGE_TYPES as readonly string[]).includes(type),
		),
	).toEqual([]);
});
