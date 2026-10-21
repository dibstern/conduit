import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import type { ProcessInfo } from "../service-runtime/driver.js";

// Never enumerate a live config directory or signal an unrecorded PID. The
// temporary cwd and explicit Claude folder identify this run's process roots.
export function trackProcesses(options: {
	project: string;
	home: string;
	registry: string;
	onSeen(info: ProcessInfo): void;
}) {
	const known = new Map<number, ProcessInfo>();
	function remember(info: ProcessInfo) {
		if (known.get(info.pid)?.startTime === info.startTime) return;
		known.set(info.pid, info);
		appendFileSync(options.registry, `${info.pid}\t${info.startTime}\n`);
		options.onSeen(info);
	}
	function table(pid?: number): ProcessInfo[] {
		let output: string;
		try {
			output = execFileSync(
				"/bin/ps",
				[
					...(pid === undefined ? ["-axww"] : ["-ww", "-p", String(pid)]),
					"-o",
					"pid=,ppid=,pgid=,lstart=,state=,command=",
				],
				{ encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
			);
		} catch (error) {
			if (
				pid !== undefined &&
				error instanceof Error &&
				"status" in error &&
				error.status === 1 &&
				"stderr" in error &&
				String(error.stderr).trim() === ""
			)
				return [];
			throw error;
		}
		return output.split("\n").flatMap((line) => {
			if (!line.trim()) return [];
			const match = line.match(
				/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(\S+)\s+(.*)$/,
			);
			assert(match, `Cannot parse ps process identity: ${line}`);
			return [
				{
					pid: Number(match[1]),
					ppid: Number(match[2]),
					pgid: Number(match[3]),
					startTime: match[4] ?? "",
					state: match[5]?.slice(0, 1) ?? "",
					argv: (match[6] ?? "").trim().split(/\s+/),
				},
			];
		});
	}
	function withSid(info: ProcessInfo): ProcessInfo | undefined {
		if (info.state === "Z") return info;
		const previous = known.get(info.pid);
		if (previous && previous.startTime === info.startTime && previous.sid)
			return { ...info, sid: previous.sid };
		// macOS ps's sess is a kernel pointer, not the numeric session ID.
		const sid = execFileSync(
			"/usr/bin/python3",
			[
				"-c",
				[
					"import os, sys",
					"try: print(os.getsid(int(sys.argv[1])))",
					"except ProcessLookupError: pass",
				].join("\n"),
				String(info.pid),
			],
			{ encoding: "utf8", timeout: 5000 },
		).trim();
		return sid ? { ...info, sid } : undefined;
	}
	function processInfo(pid: number) {
		const info = table(pid)[0];
		return info && withSid(info);
	}
	function processes() {
		const rows = table().filter((info) => info.state !== "Z");
		const owned = new Set<number>();
		for (const info of rows) {
			if (
				known.get(info.pid)?.startTime === info.startTime ||
				info.argv.includes(`${options.home}/.claude`)
			) {
				owned.add(info.pid);
				continue;
			}
			if (
				!info.argv.some(
					(arg) =>
						/\/(?:claude-session-runner|pty-host|managed-opencode-supervisor)\.js$/.test(
							arg,
						) || /(^|\/)opencode$/.test(arg),
				)
			)
				continue;
			// These owners inherit the service cwd. lsof only reads process
			// metadata; no other service's files or environment enter artifacts.
			try {
				const cwd = execFileSync(
					"/usr/sbin/lsof",
					["-a", "-p", String(info.pid), "-d", "cwd", "-Fn"],
					{ encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 },
				);
				if (cwd.split("\n").includes(`n${options.project}`))
					owned.add(info.pid);
			} catch (error) {
				// The process can exit between ps and lsof.
				if (
					!(error instanceof Error && "status" in error && error.status === 1)
				)
					throw error;
			}
		}
		let changed: boolean;
		do {
			changed = false;
			for (const info of rows) {
				if (!owned.has(info.pid) && owned.has(info.ppid)) {
					owned.add(info.pid);
					changed = true;
				}
			}
		} while (changed);
		const result = rows
			.filter((info) => owned.has(info.pid))
			.flatMap((info) => withSid(info) ?? []);
		for (const info of result) remember(info);
		return result;
	}
	return { processInfo, processes };
}

// The EXIT trap also discovers owners if the driver failed before its next
// sample, or could not start. This command only records private-cwd owners.
if (process.argv[2] === "--collect") {
	const [project, home, registry, evidence] = process.argv.slice(3);
	assert(project && home && registry && evidence);
	assert(home.startsWith("/private/tmp/conduit-m37914-"));
	trackProcesses({
		project,
		home,
		registry,
		onSeen(info) {
			appendFileSync(
				evidence,
				`${JSON.stringify({ at: new Date().toISOString(), phase: "cleanup", event: "owned-process-seen", process: info })}\n`,
			);
		},
	}).processes();
}
