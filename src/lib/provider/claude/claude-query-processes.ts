import type { Options as SDKOptions } from "@anthropic-ai/claude-agent-sdk";
import { spawnOwnedSubprocess } from "../../domain/daemon/Services/subprocess.js";
import { ClaudeRuntimeError } from "../event-sink-errors.js";

/** Each query owner must await stop() after aborting or closing its SDK query. */
export const makeClaudeQueryProcesses = (options: {
	readonly stderr?: SDKOptions["stderr"];
	readonly killProcessGroup: boolean;
}) => {
	const processes = new Set<ReturnType<typeof spawnOwnedSubprocess>>();
	let closing = false;
	const spawnClaudeCodeProcess: NonNullable<
		SDKOptions["spawnClaudeCodeProcess"]
	> = (spawnOptions) => {
		if (closing)
			throw new ClaudeRuntimeError({ message: "Claude query is closing" });
		const process = spawnOwnedSubprocess(
			spawnOptions.command,
			spawnOptions.args,
			{ ...spawnOptions, killProcessGroup: options.killProcessGroup },
		);
		processes.add(process);
		process.child.stderr.on("data", (chunk: Buffer) =>
			options.stderr?.(chunk.toString("utf8")),
		);
		return process.child;
	};
	const stop = async () => {
		closing = true;
		await Promise.all([...processes].map((process) => process.stop()));
	};
	return { spawnClaudeCodeProcess, stop };
};
