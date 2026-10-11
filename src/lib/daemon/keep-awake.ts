// Resolve the platform tool or a user-configured keep-awake command.

import { execFileSync } from "node:child_process";

export interface KeepAwakeOptions {
	command?: string;
	args?: string[];
	/** Injectable platform for testing. */
	_platform?: string;
	/** Injectable command discovery for testing. */
	_whichSync?: (cmd: string) => string | null;
}

function defaultWhichSync(cmd: string): string | null {
	try {
		return (
			execFileSync("which", [cmd], {
				encoding: "utf-8",
				timeout: 2000,
			}).trim() || null
		);
	} catch {
		return null;
	}
}

/** @internal Exported for testing only. */
export { defaultWhichSync as _defaultWhichSync };

export function resolveKeepAwakeCommand(
	options?: KeepAwakeOptions,
): { command: string; args: string[] } | null {
	const command = options?.command?.trim();
	if (command) return { command, args: [...(options?.args ?? [])] };

	const platform = options?._platform ?? process.platform;
	if (platform === "darwin") return { command: "caffeinate", args: ["-di"] };
	if (
		platform === "linux" &&
		(options?._whichSync ?? defaultWhichSync)("systemd-inhibit")
	) {
		return {
			command: "systemd-inhibit",
			args: [
				"--what=idle",
				"--who=conduit",
				"--why=Conduit relay running",
				"sleep",
				"infinity",
			],
		};
	}
	return null;
}
