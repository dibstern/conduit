// Failure modes: mutations lose a Claude folder or captured launch login;
// allocated ids capture legacy driver bindings or collide with live accounts;
// live ids resolve to a different account/driver; rejected changes mutate state;
// capacity checks drift; invalid per-driver requests escape typed rejections;
// defaults dangle after removal or ignore usage order; SetDefault accepts a
// missing/wrong-driver account; deleted ids are reused or route across drivers;
// an account's driver changes without deleting and adding it.
import { Result as Either, Option } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	type AccountChange,
	accountsStateFromInstances,
	apply,
	defaultFor,
	list,
	resolve,
} from "../../../src/lib/account-directory.js";
import {
	configuredClaudeConfigDir,
	sdkDefaultClaudeConfigDir,
} from "../../../src/lib/provider/claude/claude-sdk-env.js";

const launchLogin = sdkDefaultClaudeConfigDir("/isolated-home/.claude");
const reservedIds = ["claude", "opencode", "claude-sdk"];

describe("account directory mutations", () => {
	it.each([
		"Claude",
		"OpenCode",
		"Claude SDK",
	])("allocates distinct nonlegacy ids for accounts named %s", (name) => {
		const empty = accountsStateFromInstances([], launchLogin);
		const first = Either.getOrThrow(
			apply(empty, { _tag: "Add", name, driver: "claude" }, []),
		);
		const second = Either.getOrThrow(
			apply(first, { _tag: "Add", name, driver: "claude" }, []),
		);
		const ids = list(second).map((account) => account.id);
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
		for (const id of ids) expect(reservedIds).not.toContain(id);
		expect(list(empty)).toEqual([]);
		expect(list(first)).toHaveLength(1);
	});

	it.each([
		launchLogin,
		configuredClaudeConfigDir("/explicit-launch-login"),
	])("clears a configured folder back to the captured login %j", (login) => {
		const original = accountsStateFromInstances(
			[
				{
					id: "work",
					name: "Work",
					driver: "claude",
					configDir: "/accounts/work",
				},
			],
			login,
		);
		const cleared = Either.getOrThrow(
			apply(
				original,
				{ _tag: "Update", id: "work", updates: { configDir: "  " } },
				[],
			),
		);
		const account = Either.getOrThrow(
			resolve(cleared, { _tag: "Id", id: "work" }),
		);
		expect(account).toMatchObject({ driver: "claude", folder: login });
		expect("configuredFolder" in account).toBe(false);
		expect(
			Either.getOrThrow(resolve(original, { _tag: "Id", id: "work" })),
		).toMatchObject({
			configuredFolder: "/accounts/work",
			folder: configuredClaudeConfigDir("/accounts/work"),
		});
	});

	it("applies folder and credentials together without changing the previous account", () => {
		const original = accountsStateFromInstances(
			[{ id: "claude", name: "Claude", driver: "claude" }],
			launchLogin,
		);
		const updated = Either.getOrThrow(
			apply(
				original,
				{
					_tag: "Update",
					id: "claude",
					updates: {
						name: "Personal",
						configDir: "/accounts/personal",
						env: { ANTHROPIC_API_KEY: "test-key" },
					},
				},
				[],
			),
		);
		expect(
			Either.getOrThrow(resolve(updated, { _tag: "Id", id: "claude" })),
		).toMatchObject({
			name: "Personal",
			configuredFolder: "/accounts/personal",
			folder: configuredClaudeConfigDir("/accounts/personal"),
			env: { ANTHROPIC_API_KEY: "test-key" },
			usageEligible: false,
		});
		expect(
			Either.getOrThrow(resolve(original, { _tag: "Id", id: "claude" })),
		).toMatchObject({
			name: "Claude",
			folder: launchLogin,
			usageEligible: true,
		});
		expect(Option.getOrThrow(defaultFor(updated, "claude")).id).toBe("claude");
	});

	it.each([
		2, 5,
	])("enforces a capacity of %i and releases a removed slot", (max) => {
		let state = accountsStateFromInstances(
			[],
			launchLogin,
			max === 5 ? undefined : max,
		);
		for (let index = 0; index < max; index++) {
			state = Either.getOrThrow(
				apply(
					state,
					{
						_tag: "Add",
						name: `Server ${index}`,
						driver: "opencode",
						port: 4700 + index,
					},
					[],
				),
			);
		}
		const before = list(state);
		const rejected = apply(
			state,
			{ _tag: "Add", name: "Overflow", driver: "claude" },
			[],
		);
		expect(Either.isFailure(rejected)).toBe(true);
		if (Either.isFailure(rejected)) {
			expect(rejected.failure._tag).toBe("AccountChangeRejected");
			expect(rejected.failure.reason).toMatch(/limit|max|capacity/i);
		}
		expect(list(state)).toEqual(before);
		const removedId = before[0]?.id;
		expect(removedId).toBeDefined();
		if (removedId === undefined)
			throw new Error("Expected an account to remove");
		state = Either.getOrThrow(
			apply(state, { _tag: "Remove", id: removedId }, []),
		);
		state = Either.getOrThrow(
			apply(state, { _tag: "Add", name: "Replacement", driver: "claude" }, []),
		);
		expect(list(state)).toHaveLength(max);
	});

	it.each([
		{
			name: "a managed Claude account",
			change: { _tag: "Add", name: "Work", driver: "claude", managed: true },
			reason: /managed/i,
		},
		{
			name: "a Claude port, including zero",
			change: { _tag: "Add", name: "Work", driver: "claude", port: 0 },
			reason: /port/i,
		},
		{
			name: "a Claude URL",
			change: {
				_tag: "Add",
				name: "Work",
				driver: "claude",
				url: "http://localhost:4700",
			},
			reason: /url/i,
		},
		{
			name: "a managed OpenCode account without a port",
			change: {
				_tag: "Add",
				name: "Server",
				driver: "opencode",
				managed: true,
			},
			reason: /port/i,
		},
		{
			name: "a managed OpenCode account with a URL",
			change: {
				_tag: "Add",
				name: "Server",
				driver: "opencode",
				managed: true,
				port: 4700,
				url: "http://localhost:4700",
			},
			reason: /url/i,
		},
		{
			name: "an external OpenCode account without a port or URL",
			change: {
				_tag: "Add",
				name: "Server",
				driver: "opencode",
				managed: false,
			},
			reason: /port|url/i,
		},
		...[-1, 0, 65536, 4700.5].map((port) => ({
			name: `invalid OpenCode port ${port}`,
			change: {
				_tag: "Add" as const,
				name: "Server",
				driver: "opencode",
				port,
			},
			reason: /port/i,
		})),
		{
			name: "an invalid external OpenCode URL",
			change: {
				_tag: "Add",
				name: "Server",
				driver: "opencode",
				url: "not-a-url",
			},
			reason: /url/i,
		},
		{
			name: "an unknown driver",
			change: { _tag: "Add", name: "Work", driver: "unknown-driver" },
			reason: /driver|claude|opencode/i,
		},
		{
			name: "a blank name",
			change: { _tag: "Add", name: "  ", driver: "claude" },
			reason: /name/i,
		},
		{
			name: "updating an unknown id",
			change: { _tag: "Update", id: "missing", updates: { name: "Work" } },
			reason: /not found|unknown|missing/i,
		},
		{
			name: "removing an unknown id",
			change: { _tag: "Remove", id: "missing" },
			reason: /not found|unknown|missing/i,
		},
	] satisfies ReadonlyArray<{
		name: string;
		change: AccountChange;
		reason: RegExp;
	}>)("rejects $name with a typed reason and preserves state", ({
		change,
		reason,
	}) => {
		const state = accountsStateFromInstances([], launchLogin);
		const before = structuredClone(state);
		const rejected = apply(state, change, []);
		expect(Either.isFailure(rejected)).toBe(true);
		if (Either.isFailure(rejected)) {
			expect(rejected.failure._tag).toBe("AccountChangeRejected");
			expect(rejected.failure.reason).toMatch(reason);
			expect(rejected.failure.message).toContain(rejected.failure.reason);
		}
		expect(state).toEqual(before);
	});

	it("promotes defaults in usage order, clears the last pointer and records removals", () => {
		let state = accountsStateFromInstances(
			[
				{ id: "claude", name: "Claude", driver: "claude" },
				{ id: "personal", name: "Personal", driver: "claude" },
				{ id: "work", name: "Work", driver: "claude" },
			],
			launchLogin,
		);
		state = Either.getOrThrow(
			apply(state, { _tag: "SetDefault", id: "personal" }, []),
		);
		expect(Option.getOrThrow(defaultFor(state, "claude")).id).toBe("personal");
		for (const [removed, promoted] of [
			["personal", "work"],
			["work", "claude"],
			["claude", undefined],
		] as const) {
			state = Either.getOrThrow(
				apply(state, { _tag: "Remove", id: removed }, [
					"missing",
					"work",
					"claude",
				]),
			);
			expect(Option.getOrUndefined(defaultFor(state, "claude"))?.id).toBe(
				promoted,
			);
			expect(state.deleted).toContainEqual({ id: removed, driver: "claude" });
			const routed = resolve(state, { _tag: "Id", id: removed });
			if (promoted === undefined) expect(Either.isFailure(routed)).toBe(true);
			else expect(Either.getOrThrow(routed).id).toBe(promoted);
		}
		const added = Either.getOrThrow(
			apply(state, { _tag: "Add", name: "Personal", driver: "claude" }, []),
		);
		expect(Option.getOrThrow(defaultFor(added, "claude")).id).toBe(
			"personal-2",
		);
		expect(
			Either.isFailure(
				apply(
					added,
					{ _tag: "Add", id: "personal", name: "Reuse", driver: "claude" },
					[],
				),
			),
		).toBe(true);
	});

	it("rejects unavailable and OpenCode defaults without changing state", () => {
		const state = accountsStateFromInstances(
			[
				{ id: "opencode", name: "OpenCode", driver: "opencode" },
				{ id: "claude", name: "Claude", driver: "claude" },
			],
			launchLogin,
		);
		for (const id of ["missing", "opencode"])
			expect(
				Either.isFailure(apply(state, { _tag: "SetDefault", id }, [])),
			).toBe(true);
		expect(Option.getOrThrow(defaultFor(state, "claude")).id).toBe("claude");
	});

	it("rejects changing an account's type", () => {
		const state = accountsStateFromInstances(
			[{ id: "claude", name: "Claude", driver: "claude" }],
			launchLogin,
		);
		for (const change of [
			{ _tag: "Update", id: "claude", updates: { driver: "opencode" } },
		] satisfies ReadonlyArray<AccountChange>) {
			const result = apply(state, change, []);
			expect(Either.isFailure(result)).toBe(true);
			if (Either.isFailure(result)) {
				expect(result.failure._tag).toBe("AccountChangeRejected");
				expect(result.failure.id).toBe("claude");
				expect(result.failure.reason).toMatch(/type.*delete.*add/i);
			}
		}
		expect(list(state)).toHaveLength(1);
	});

	it("preserves pointers, deleted routing, folders and unique ids over random mutations", () => {
		const operation = fc.record({
			kind: fc.constantFrom<"Add" | "Update" | "Remove" | "SetDefault">(
				"Add",
				"Update",
				"Remove",
				"SetDefault",
			),
			index: fc.nat({ max: 16 }),
			name: fc.constantFrom(
				"Claude",
				"OpenCode",
				"Claude SDK",
				"Personal",
				"Team",
			),
			driver: fc.constantFrom<"claude" | "opencode">("claude", "opencode"),
			configDir: fc.constantFrom("", "/accounts/personal", "/accounts/team"),
			apiKey: fc.boolean(),
		});
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						driver: fc.constantFrom<"claude" | "opencode">(
							"claude",
							"opencode",
						),
						configDir: fc.constantFrom("", "/accounts/initial"),
					}),
					{ maxLength: 5 },
				),
				fc.array(operation, { minLength: 1, maxLength: 60 }),
				(initialAccounts, operations) => {
					let state = accountsStateFromInstances(
						[
							{ id: "opencode", name: "OpenCode", driver: "opencode" },
							...initialAccounts.map((account, index) => ({
								...account,
								id: `initial-${index}`,
								name: `Initial ${index}`,
							})),
						],
						launchLogin,
						8,
					);
					for (const step of operations) {
						const previous = list(state);
						const snapshot = structuredClone(state);
						const id =
							previous[step.index % Math.max(previous.length, 1)]?.id ??
							"missing";
						const change: AccountChange =
							step.kind === "Add"
								? {
										_tag: "Add",
										name: step.name,
										driver: step.driver,
										configDir: step.configDir,
										...(step.driver === "opencode"
											? { port: 4700 + step.index }
											: {}),
									}
								: step.kind === "Update"
									? {
											_tag: "Update",
											id,
											updates: {
												name: step.name,
												driver: step.driver,
												configDir: step.configDir,
												env: {
													ANTHROPIC_API_KEY: step.apiKey ? "test-key" : "",
												},
												...(step.driver === "opencode"
													? { port: 4700 + step.index }
													: {}),
											},
										}
									: { _tag: step.kind, id };
						const result = apply(
							state,
							change,
							previous.map((account) => account.id).reverse(),
						);
						expect(state).toEqual(snapshot);
						if (Either.isFailure(result)) {
							expect(result.failure._tag).toBe("AccountChangeRejected");
							expect(result.failure.reason.length).toBeGreaterThan(0);
							continue;
						}
						state = result.success;
						const current = list(state);
						const claudeAccounts = current.filter(
							(account) => account.driver === "claude",
						);
						const selected = defaultFor(state, "claude");
						expect(Option.isSome(selected)).toBe(claudeAccounts.length > 0);
						expect(Option.isSome(state.defaults.claude)).toBe(
							claudeAccounts.length > 0,
						);
						if (Option.isSome(selected)) {
							expect(state.defaults.claude).toEqual(
								Option.some(selected.value.id),
							);
							expect(
								claudeAccounts.some(
									(account) => account.id === selected.value.id,
								),
							).toBe(true);
						}
						if (change._tag === "SetDefault")
							expect(Option.getOrThrow(selected).id).toBe(id);
						for (const deleted of state.deleted) {
							const routed = resolve(state, { _tag: "Id", id: deleted.id });
							const fallback = defaultFor(state, deleted.driver);
							if (Option.isSome(fallback))
								expect(routed).toEqual(Either.succeed(fallback.value));
							else expect(Either.isFailure(routed)).toBe(true);
						}
						if (change._tag === "Remove") {
							const removed = previous.find((account) => account.id === id);
							expect(state.deleted).toContainEqual({
								id,
								driver: removed?.driver,
							});
						}
						for (const legacyId of reservedIds) {
							if (current.some((account) => account.id === legacyId)) continue;
							const expectedDriver =
								state.deleted.find((account) => account.id === legacyId)
									?.driver ?? (legacyId === "opencode" ? "opencode" : "claude");
							const routed = resolve(state, { _tag: "Id", id: legacyId });
							if (Either.isSuccess(routed))
								expect(routed.success.driver).toBe(expectedDriver);
						}
						expect(new Set(current.map((account) => account.id)).size).toBe(
							current.length,
						);
						if (change._tag === "Add") {
							const added = current.filter(
								(account) => !previous.some((old) => old.id === account.id),
							);
							expect(added).toHaveLength(1);
							for (const account of added) {
								expect(reservedIds).not.toContain(account.id);
								expect(
									state.deleted.some((deleted) => deleted.id === account.id),
								).toBe(false);
							}
						}
						for (const { isDefault: _isDefault, ...account } of current) {
							expect(resolve(state, { _tag: "Id", id: account.id })).toEqual(
								Either.succeed(account),
							);
							if (account.driver === "claude") {
								expect(account.folder.path.trim().length).toBeGreaterThan(0);
								expect(account.folder).toEqual(
									account.configuredFolder === undefined
										? launchLogin
										: configuredClaudeConfigDir(account.configuredFolder),
								);
							}
						}
					}
				},
			),
			{ seed: 641006, numRuns: 200 },
		);
	});
});
