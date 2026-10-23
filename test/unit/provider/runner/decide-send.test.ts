import { describe, expect, it } from "vitest";
import {
	decideSend,
	initialRunnerLifecycle,
	type RunnerEntryLifecycle,
} from "../../../../src/lib/provider/runner/runner-entry-lifecycle.js";

const serving: RunnerEntryLifecycle = {
	...initialRunnerLifecycle(),
	activity: { _tag: "Serving" },
};
const busyCommand: RunnerEntryLifecycle = { ...serving, commandsInFlight: 1 };
const idleExiting: RunnerEntryLifecycle = { ...serving, idleExiting: true };
type Row = Partial<{
	command: "send-turn" | "pre-warm";
	lifecycle: RunnerEntryLifecycle;
	quiescent: boolean;
	rebindsAccount: boolean;
	folders: boolean;
	login: "None" | "Settings" | "Account";
	legacyCursor: boolean;
	settingsDeferred: boolean;
}>;
const unchanged = {
	folders: false,
	login: "None" as const,
	legacyCursor: false,
	settingsDeferred: false,
};

describe("decideSend", () => {
	it.each<[string, Row, ReturnType<typeof decideSend>]>([
		["unchanged, quiet", {}, "Use"],
		["unchanged, busy", { quiescent: false }, "Use"],
		[
			"settings login change, quiet, rebinds in place",
			{ login: "Settings" },
			"Use",
		],
		[
			"settings login change, quiet, cannot rebind in place",
			{ login: "Settings", rebindsAccount: false },
			"Retire",
		],
		[
			"settings login change, background busy",
			{ login: "Settings", quiescent: false },
			"DeferRebind",
		],
		[
			"settings login change, command in flight",
			{ login: "Settings", lifecycle: busyCommand },
			"DeferRebind",
		],
		[
			"settings login change, busy, cannot rebind in place",
			{ login: "Settings", quiescent: false, rebindsAccount: false },
			"Wait",
		],
		["account switch, quiet, rebinds in place", { login: "Account" }, "Use"],
		[
			"account switch, quiet, cannot rebind in place",
			{ login: "Account", rebindsAccount: false },
			"Retire",
		],
		[
			"account switch, background busy",
			{ login: "Account", quiescent: false },
			"Refuse",
		],
		[
			"account switch, command in flight",
			{ login: "Account", lifecycle: busyCommand },
			"Refuse",
		],
		[
			"account switch, busy, cannot rebind in place",
			{ login: "Account", quiescent: false, rebindsAccount: false },
			"Refuse",
		],
		[
			"account switch and folder change, busy",
			{ login: "Account", folders: true, quiescent: false },
			"Refuse",
		],
		["folder change, quiet", { folders: true }, "Retire"],
		["folder change, busy", { folders: true, quiescent: false }, "Wait"],
		[
			"settings upgrade by restart, quiet",
			{ settingsDeferred: true },
			"Retire",
		],
		[
			"settings upgrade deferred while busy",
			{ settingsDeferred: true, quiescent: false },
			"Use",
		],
		[
			"change on a runner that cannot reconfigure",
			{ login: "Account", lifecycle: idleExiting },
			"Use",
		],
		[
			"pre-warm, login change, busy",
			{ command: "pre-warm", login: "Account", quiescent: false },
			"Skip",
		],
		[
			"pre-warm, folder change, quiet",
			{ command: "pre-warm", folders: true },
			"Skip",
		],
		[
			"pre-warm, legacy cursor",
			{ command: "pre-warm", legacyCursor: true },
			"Skip",
		],
		[
			"pre-warm, settings deferred, quiet",
			{ command: "pre-warm", settingsDeferred: true },
			"Use",
		],
	])("%s -> %s", (_, row, expected) => {
		const {
			command = "send-turn",
			lifecycle = serving,
			quiescent = true,
			rebindsAccount = true,
			...changes
		} = row;
		expect(
			decideSend({
				command,
				lifecycle,
				quiescent,
				rebindsAccount,
				changes: { ...unchanged, ...changes },
			}),
		).toBe(expected);
	});
});
