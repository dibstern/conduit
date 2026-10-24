// Failure modes: a runner's refusal is lost, driver dispatch skips a retained
// owner, or runners without an account-switch block prevent admission.

import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { accountsStateFromInstances } from "../../../src/lib/account-directory.js";
import {
	type Account,
	AccountIdSchema,
	type ClaudeAccount,
} from "../../../src/lib/contracts/account.js";
import { AccountSwitchBusy } from "../../../src/lib/contracts/limit-recovery.js";
import type { KnownProviderDriverKind } from "../../../src/lib/contracts/provider-instance.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import { runnerFailure } from "../../../src/lib/provider/runner/runner-protocol.js";
import {
	assertSessionRunnerAvailable,
	makeRunnerProviderInstance,
} from "../../../src/lib/provider/runner/runner-provider-instance.js";
import type { SessionRunner } from "../../../src/lib/provider/runner/session-runner.js";

const target: ClaudeAccount = {
	driver: "claude",
	id: AccountIdSchema.make("account-b"),
	name: "Account B",
	folder: configuredClaudeConfigDir("/tmp/account-b"),
	usageEligible: true,
};
const block = new AccountSwitchBusy({
	sessionId: "session",
	fromAccountId: "account-a",
	toAccountId: "account-b",
	message:
		"Background work is still running on Account A. Stop it or wait for it to finish, then resend to switch to Account B.",
});

const check = (
	query?: SessionRunner["getAccountSwitchBlockEffect"],
	account: Account | undefined = target,
	driverKind: KnownProviderDriverKind = "claude",
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const provider = yield* makeRunnerProviderInstance(
				{
					accounts: Effect.succeed(
						accountsStateFromInstances([], target.folder),
					),
				},
				{
					driverKind,
					nativeSession: true,
					discoverEffect: () => Effect.die("Unexpected discovery"),
					generateTextEffect: () => Effect.die("Unexpected generation"),
					prepareTurnEffect: () => Effect.die("Unexpected preparation"),
				},
				() =>
					Effect.succeed({
						hasLiveProcessEffect: () => Effect.succeed(false),
						...(query ? { getAccountSwitchBlockEffect: query } : {}),
						getNativeSessionEffect: () =>
							Effect.die("Admission must use the runner account-switch query"),
						executeEffect: () =>
							Effect.fail(runnerFailure("test cleanup", "No runner process")),
					}),
			);
			return yield* assertSessionRunnerAvailable(
				"session",
				new ProviderRegistry([provider]),
				account,
			).pipe(Effect.result);
		}),
	);

describe("runner account switch admission", () => {
	it.each([
		"claude",
		"codex",
		"cursor",
	] as const)("forwards the live runner's refusal for a %s owner", async (driverKind) => {
		const query = vi.fn(() => Effect.succeed(block));
		const result = await Effect.runPromise(check(query, target, driverKind));
		expect(query).toHaveBeenCalledExactlyOnceWith("session", target);
		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure") expect(result.failure).toBe(block);
	});

	it("allows a send when the runner reports no account-switch block", async () => {
		const query = vi.fn(() => Effect.succeed(undefined));
		expect(await Effect.runPromise(check(query))).toMatchObject({
			_tag: "Success",
		});
		expect(query).toHaveBeenCalledExactlyOnceWith("session", target);
	});

	it("allows a runner without the optional account-switch query", async () => {
		expect(await Effect.runPromise(check())).toMatchObject({
			_tag: "Success",
		});
	});
});
