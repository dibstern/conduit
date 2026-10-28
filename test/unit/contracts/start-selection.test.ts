// Failure modes: a down selection is used, fallback mutates the snapshot,
// recovery sticks to managed, or an unavailable managed server picks a third server.
import { describe, expect, it } from "vitest";
import { openCodeStartSelection } from "../../../src/lib/contracts/start-selection.js";

describe("OpenCode draft start", () => {
	it.each([
		"healthy",
		"starting",
		"unhealthy",
		"stopped",
	] as const)("resolves a %s selection without writing it", (status) => {
		const accounts = Object.freeze([
			Object.freeze({
				id: "opencode",
				driver: "opencode",
				isDefault: false,
				status: "stopped",
			}),
			Object.freeze({
				id: "chosen",
				driver: "opencode",
				isDefault: true,
				status,
			}),
			Object.freeze({
				id: "other",
				driver: "opencode",
				isDefault: false,
				status: "healthy",
			}),
		]);
		expect(openCodeStartSelection(accounts)).toEqual(
			status === "healthy"
				? { account: { _tag: "Id", id: "chosen" } }
				: { account: { _tag: "Id", id: "opencode" }, fallback: "unreachable" },
		);
		expect(accounts[1]?.isDefault).toBe(true);
		expect(
			openCodeStartSelection(
				accounts.map((account) => ({ ...account, status: "healthy" })),
			),
		).toEqual({ account: { _tag: "Id", id: "chosen" } });
	});
	it("keeps the lazy managed default even while stopped", () => {
		expect(
			openCodeStartSelection([
				{
					id: "opencode",
					driver: "opencode",
					isDefault: true,
					status: "stopped",
				},
			]),
		).toEqual({ account: { _tag: "Id", id: "opencode" } });
	});
});
