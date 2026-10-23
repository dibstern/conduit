// Failure modes: slots follow list order, updates reset them, removed slots
// remain reserved, overflow crashes, or migration overwrites stored identities.
import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
	accountsStateFromInstances,
	apply,
	normalizeAccountConfig,
} from "../../../src/lib/account-directory.js";
import { defaultDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { sdkDefaultClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";

const login = sdkDefaultClaudeConfigDir("/isolated-home/.claude");
const instances = ["personal", "work", "lab"].map((id) => ({
	id,
	name: id,
	driver: "claude" as const,
	port: 0,
	managed: false,
}));

describe("account colour slots", () => {
	it("assigns legacy accounts once in config order and persists that order independently", () => {
		const migrated = normalizeAccountConfig({
			...defaultDaemonConfig(),
			instances,
		});
		expect(migrated.instances?.map((account) => account.colorSlot)).toEqual([
			0, 1, 2,
		]);
		const reordered = {
			...migrated,
			instances: [...(migrated.instances ?? [])].reverse(),
		};
		expect(normalizeAccountConfig(reordered)).toEqual(reordered);
	});

	it("reserves explicit slots before assigning missing ones", () => {
		const state = accountsStateFromInstances(
			instances.map((account, index) => ({
				...account,
				...(index === 0 ? {} : { colorSlot: index === 1 ? 0 : 4 }),
			})),
			login,
		);
		expect(state.accounts.map((account) => account.colorSlot)).toEqual([
			1, 0, 4,
		]);
	});

	it("keeps surviving colours on deletion and gives a new account the lowest free slot", () => {
		const original = accountsStateFromInstances(instances, login);
		const removed = Result.getOrThrow(
			apply(original, { _tag: "Remove", id: "work" }, []),
		);
		expect(
			removed.accounts.map(({ id, colorSlot }) => [id, colorSlot]),
		).toEqual([
			["personal", 0],
			["lab", 2],
		]);
		const added = Result.getOrThrow(
			apply(removed, { _tag: "Add", name: "New", driver: "cursor" }, []),
		);
		expect(added.accounts.map(({ id, colorSlot }) => [id, colorSlot])).toEqual([
			["personal", 0],
			["lab", 2],
			["new", 1],
		]);
		expect(original.accounts.map((account) => account.colorSlot)).toEqual([
			0, 1, 2,
		]);
	});

	it("keeps colours when adding and renaming an account", () => {
		const original = accountsStateFromInstances(instances, login);
		const added = Result.getOrThrow(
			apply(original, { _tag: "Add", name: "New", driver: "claude" }, []),
		);
		expect(added.accounts.map((account) => account.colorSlot)).toEqual([
			0, 1, 2, 3,
		]);
		const renamed = Result.getOrThrow(
			apply(
				added,
				{ _tag: "Update", id: "lab", updates: { name: "Renamed" } },
				[],
			),
		);
		expect(renamed.accounts.map((account) => account.colorSlot)).toEqual([
			0, 1, 2, 3,
		]);
	});

	it("reuses the lowest least-used slot when the palette is full", () => {
		const state = accountsStateFromInstances(
			Array.from({ length: 14 }, (_, index) => ({
				id: `account-${index}`,
				name: `Account ${index}`,
				driver: "claude",
			})),
			login,
			20,
		);
		expect(state.accounts.map((account) => account.colorSlot)).toEqual([
			0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5, 0, 1,
		]);
		const added = Result.getOrThrow(
			apply(state, { _tag: "Add", name: "Overflow", driver: "claude" }, []),
		);
		expect(added.accounts.at(-1)?.colorSlot).toBe(2);
	});
});
