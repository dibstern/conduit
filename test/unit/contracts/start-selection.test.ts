// Failure modes: a down selection is used, fallback mutates the snapshot,
// recovery sticks to managed, or an unavailable managed server picks a third server.
import { describe, expect, it } from "vitest";
import { openCodeStartSelection } from "../../../src/lib/contracts/start-selection.js";
import type { InstanceStatus } from "../../../src/lib/shared-types.js";

describe("OpenCode draft start", () => {
	it.each([
		"healthy",
		"starting",
		"unhealthy",
		"stopped",
		undefined,
	] as const)("resolves a %s selection without writing it", (status) => {
		const accounts = Object.freeze([
			Object.freeze({
				id: "opencode",
				driver: "opencode",
				isDefault: false,
			}),
			Object.freeze({
				id: "chosen",
				driver: "opencode",
				isDefault: true,
				managed: true,
			}),
			Object.freeze({
				id: "other",
				driver: "opencode",
				isDefault: false,
			}),
		]);
		const statuses = new Map<string, InstanceStatus>([
			["opencode", "stopped"],
			["other", "healthy"],
			...(status === undefined ? [] : [["chosen", status] as const]),
		]);
		expect(openCodeStartSelection(accounts, statuses)).toEqual(
			status === "healthy"
				? { account: { _tag: "Id", id: "chosen" } }
				: { account: { _tag: "Id", id: "opencode" }, fallback: "unreachable" },
		);
		expect(accounts[1]?.isDefault).toBe(true);
		expect(
			openCodeStartSelection(
				accounts,
				new Map(accounts.map(({ id }) => [id, "healthy"])),
			),
		).toEqual({ account: { _tag: "Id", id: "chosen" } });
	});
	it("keeps the lazy managed default even while stopped", () => {
		expect(
			openCodeStartSelection(
				[
					{
						id: "opencode",
						driver: "opencode",
						isDefault: true,
					},
				],
				new Map([["opencode", "stopped"]]),
			),
		).toEqual({ account: { _tag: "Id", id: "opencode" } });
	});
});
