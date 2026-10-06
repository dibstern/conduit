import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, expectTypeOf, it } from "vitest";
import {
	RELAY_MESSAGE_TYPES,
	type RelayMessage,
} from "../../../src/lib/shared-types.js";

it("has no producers or consumers of retired session relay frames", () => {
	const root = join(process.cwd(), "src");
	const retired = new RegExp(
		`${["session", "switched"].join("_")}|${["history", "page"].join("_")}`,
	);
	const matches: string[] = [];
	const visit = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (
				entry.isFile() &&
				(path.endsWith(".ts") || path.endsWith(".svelte")) &&
				retired.test(readFileSync(path, "utf8"))
			) {
				matches.push(relative(root, path));
			}
		}
	};
	visit(root);
	expect(matches).toEqual([]);
});

// conduit-test-ni8.12/.13/.14/.15: frames whose data now comes only from RPC
// replies (or from nowhere). Asserted at the union so a reintroduction fails.
const RETIRED_RELAY_TYPES = [
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

it("retired push frames are absent from the RelayMessage union", () => {
	expectTypeOf<
		Extract<RelayMessage, { type: (typeof RETIRED_RELAY_TYPES)[number] }>
	>().toBeNever();
	expect(
		RELAY_MESSAGE_TYPES.filter((type) =>
			(RETIRED_RELAY_TYPES as readonly string[]).includes(type),
		),
	).toEqual([]);
});
