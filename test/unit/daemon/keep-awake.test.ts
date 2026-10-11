// Command resolution tests retained from the retired imperative KeepAwake.
// Process lifecycle is covered by leaf-services-effect and the daemon E2E.

import { describe, expect, it } from "vitest";
import {
	_defaultWhichSync,
	resolveKeepAwakeCommand,
} from "../../../src/lib/daemon/keep-awake.js";

describe("Keep-awake command resolution", () => {
	it("resolves caffeinate with -di on macOS", () => {
		expect(resolveKeepAwakeCommand({ _platform: "darwin" })).toEqual({
			command: "caffeinate",
			args: ["-di"],
		});
	});

	it("uses config command/args when provided on any platform", () => {
		expect(
			resolveKeepAwakeCommand({
				_platform: "linux",
				_whichSync: () => null,
				command: "my-keep-awake",
				args: ["--flag"],
			}),
		).toEqual({ command: "my-keep-awake", args: ["--flag"] });
	});

	it("auto-detects systemd-inhibit on Linux when available", () => {
		expect(
			resolveKeepAwakeCommand({
				_platform: "linux",
				_whichSync: (cmd) =>
					cmd === "systemd-inhibit" ? "/usr/bin/systemd-inhibit" : null,
			}),
		).toEqual({
			command: "systemd-inhibit",
			args: [
				"--what=idle",
				"--who=conduit",
				"--why=Conduit relay running",
				"sleep",
				"infinity",
			],
		});
	});

	it("resolves null on Linux when systemd-inhibit is not found", () => {
		expect(
			resolveKeepAwakeCommand({ _platform: "linux", _whichSync: () => null }),
		).toBeNull();
	});

	it("config command overrides auto-detection", () => {
		expect(
			resolveKeepAwakeCommand({
				_platform: "darwin",
				command: "/opt/my-tool",
				args: ["--no-sleep"],
			}),
		).toEqual({ command: "/opt/my-tool", args: ["--no-sleep"] });
	});

	it("resolves null on Windows with no configured command", () => {
		expect(resolveKeepAwakeCommand({ _platform: "win32" })).toBeNull();
	});

	it("resolves a configured command on Windows", () => {
		expect(
			resolveKeepAwakeCommand({
				_platform: "win32",
				command: "powercfg",
				args: ["/change", "standby-timeout-ac", "0"],
			}),
		).toEqual({
			command: "powercfg",
			args: ["/change", "standby-timeout-ac", "0"],
		});
	});

	it("empty command falls through to auto-detection", () => {
		expect(
			resolveKeepAwakeCommand({ _platform: "darwin", command: "" }),
		).toEqual({
			command: "caffeinate",
			args: ["-di"],
		});
	});

	describe("command discovery", () => {
		it("finds an existing command", () => {
			const result = _defaultWhichSync("ls");
			expect(result).not.toBeNull();
			expect(result).toContain("/ls");
		});

		it("returns null for a nonexistent command", () => {
			expect(
				_defaultWhichSync("this_command_does_not_exist_xyz_123"),
			).toBeNull();
		});

		it("returns null for an empty string", () => {
			expect(_defaultWhichSync("")).toBeNull();
		});
	});
});
