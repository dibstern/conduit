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
	login: boolean;
	legacyCursor: boolean;
	settingsDeferred: boolean;
}>;
const unchanged = {
	folders: false,
	login: false,
	legacyCursor: false,
	settingsDeferred: false,
};

describe("decideSend", () => {
	it.each<[string, Row, ReturnType<typeof decideSend>]>([
		["unchanged, quiet", {}, "Use"],
		["unchanged, busy", { quiescent: false }, "Use"],
		["login change, quiet, rebinds in place", { login: true }, "Use"],
		[
			"login change, quiet, cannot rebind in place",
			{ login: true, rebindsAccount: false },
			"Retire",
		],
		[
			"login change, background busy",
			{ login: true, quiescent: false },
			"Wait",
		],
		[
			"login change, command in flight",
			{ login: true, lifecycle: busyCommand },
			"Wait",
		],
		[
			"login change, busy, cannot rebind in place",
			{ login: true, quiescent: false, rebindsAccount: false },
			"Wait",
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
			{ login: true, lifecycle: idleExiting },
			"Use",
		],
		[
			"pre-warm, login change, busy",
			{ command: "pre-warm", login: true, quiescent: false },
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
