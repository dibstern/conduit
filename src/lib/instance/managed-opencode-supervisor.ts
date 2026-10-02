// A live supervisor pins the private session/group, so stopping it never
// targets a persisted numeric PID that the OS might have reused.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { createServer } from "node:net";

const port = Number(process.argv[2]);
const token = process.env["CONDUIT_OPENCODE_CONTROL_TOKEN"] ?? "";
const { CONDUIT_OPENCODE_CONTROL_TOKEN: _token, ...env } = process.env;
let child: ChildProcess | undefined;
let stopping = false;
let committed = false;
let lastListenerPid: number | undefined;

const stopGroup = () => {
	if (stopping) return;
	stopping = true;
	// This process is the session leader. Both signals address its own live
	// group, never a PID read from config or supplied by a control client.
	setTimeout(() => process.kill(0, "SIGKILL"), 1500);
	process.kill(0, "SIGTERM");
};
process.on("SIGTERM", () => {});
process.on("SIGINT", stopGroup);
process.on("SIGHUP", stopGroup);
process.on("uncaughtException", stopGroup);
process.on("unhandledRejection", stopGroup);
// A parent crash before recording identity must not leave an undiscoverable
// group. The parent commits only after its config write has completed.
const bootstrapTimeout = setTimeout(stopGroup, 10000);
process.on("disconnect", () => {
	if (!committed) stopGroup();
});
process.on("message", (message: unknown) => {
	if (
		typeof message === "object" &&
		message !== null &&
		"command" in message &&
		message.command === "commit"
	) {
		committed = true;
		clearTimeout(bootstrapTimeout);
		process.send?.({ committed: true });
	}
});

const listenerPid = async (): Promise<number | undefined> => {
	if (process.platform === "darwin") {
		return new Promise((resolve) => {
			execFile(
				"/usr/sbin/lsof",
				[
					"-nP",
					"-a",
					"-g",
					String(process.pid),
					`-iTCP:${port}`,
					"-sTCP:LISTEN",
					"-FpgfnT",
				],
				{ timeout: 1500, maxBuffer: 4096 },
				(error, stdout) => {
					if (error) return resolve(undefined);
					let pid: number | undefined;
					let group: number | undefined;
					let matches = false;
					for (const line of stdout.split("\n")) {
						if (line.startsWith("p")) {
							pid = Number(line.slice(1));
							group = undefined;
							matches = false;
						} else if (line.startsWith("g")) group = Number(line.slice(1));
						else if (line.startsWith("f")) matches = false;
						else if (line === `n127.0.0.1:${port}`) matches = true;
						else if (line === "TST=LISTEN" && matches && group === process.pid)
							return resolve(pid);
					}
					resolve(undefined);
				},
			);
		});
	}
	if (process.platform !== "linux") return undefined;
	const address = `0100007F:${port.toString(16).toUpperCase().padStart(4, "0")}`;
	try {
		const sockets = new Set(
			readFileSync("/proc/self/net/tcp", "utf8")
				.split("\n")
				.flatMap((row) => {
					const columns = row.trim().split(/\s+/);
					return columns[1] === address && columns[3] === "0A" && columns[9]
						? [columns[9]]
						: [];
				}),
		);
		for (const pid of readdirSync("/proc").filter((entry) =>
			/^\d+$/.test(entry),
		)) {
			try {
				const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
				if (
					Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]) !==
					process.pid
				)
					continue;
				for (const fd of readdirSync(`/proc/${pid}/fd`)) {
					const inode = /^socket:\[(\d+)\]$/.exec(
						readlinkSync(`/proc/${pid}/fd/${fd}`),
					)?.[1];
					if (inode && sockets.has(inode)) return Number(pid);
				}
			} catch {
				/* A process/descriptor may exit during this snapshot. */
			}
		}
	} catch {
		/* Unreadable ownership evidence is never treated as ownership. */
	}
	return undefined;
};

const control = createServer((socket) => {
	socket.setTimeout(3000, () => socket.destroy());
	socket.on("error", () => {});
	let input = "";
	socket.on("data", async (chunk: Buffer): Promise<void> => {
		input += chunk.toString();
		if (input.length > 4096) {
			socket.destroy();
			return;
		}
		if (!input.includes("\n")) return;
		socket.removeAllListeners("data");
		try {
			const request: unknown = JSON.parse(input);
			if (
				typeof request !== "object" ||
				request === null ||
				!("token" in request) ||
				typeof request.token !== "string" ||
				request.token.length !== token.length ||
				!timingSafeEqual(Buffer.from(request.token), Buffer.from(token)) ||
				!("supervisorPid" in request) ||
				request.supervisorPid !== process.pid ||
				!child?.pid
			) {
				socket.end("{}\n");
				return;
			}
			if ("command" in request && request.command === "stop") {
				if (!("launchPid" in request) || request.launchPid !== child.pid) {
					socket.end("{}\n");
					return;
				}
				socket.end(
					`${JSON.stringify({ supervisorPid: process.pid, launchPid: child.pid, stopped: true })}\n`,
				);
				stopGroup();
				return;
			}
			const runningBefore =
				child.exitCode === null && child.signalCode === null && !stopping;
			const pid = runningBefore ? await listenerPid() : undefined;
			if (pid !== undefined) lastListenerPid = pid;
			const running =
				runningBefore &&
				child.exitCode === null &&
				child.signalCode === null &&
				!stopping;
			socket.end(
				`${JSON.stringify({ supervisorPid: process.pid, launchPid: child.pid, pid: lastListenerPid, running, listening: running && pid !== undefined })}\n`,
			);
		} catch {
			socket.destroy();
		}
	});
});
control.on("error", stopGroup);
control.listen(0, "127.0.0.1", () => {
	child = spawn(
		"opencode",
		["serve", "--hostname", "127.0.0.1", "--port", String(port)],
		{
			env: { ...env, CONDUIT_OPENCODE_GROUP_PID: String(process.pid) },
			stdio: ["ignore", 1, 2],
		},
	);
	child.once("error", stopGroup);
	child.once("exit", stopGroup);
	child.once("spawn", () => {
		const address = control.address();
		if (!address || typeof address === "string" || !child?.pid)
			return stopGroup();
		process.send?.({
			pid: child.pid,
			supervisorPid: process.pid,
			controlPort: address.port,
		});
	});
});
