import { spawnSync } from "node:child_process";

function processSnapshot() {
	const snapshot = spawnSync("ps", ["-A", "-o", "pid=,ppid=,stat=,command="], {
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
	});
	if (snapshot.error) throw snapshot.error;
	if (snapshot.status !== 0) throw new Error(`ps failed: ${snapshot.stderr}`);
	return snapshot.stdout.split("\n").flatMap((line) => {
		const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
		return match && Number(match[1]) !== snapshot.pid
			? [
					{
						pid: Number(match[1]),
						ppid: Number(match[2]),
						stat: match[3],
						command: match[4],
					},
				]
			: [];
	});
}

function descendants(
	processes: ReturnType<typeof processSnapshot>,
	roots: ReadonlySet<number>,
) {
	const pids = new Set(roots);
	for (const pid of pids) {
		for (const child of processes) {
			if (child.ppid === pid) pids.add(child.pid);
		}
	}
	return pids;
}

/** In-process harnesses exclude children that belong to the test runner. */
export function captureExistingChildren(): ReadonlySet<number> {
	const children = descendants(processSnapshot(), new Set([process.pid]));
	children.delete(process.pid);
	return children;
}

export async function stopDaemonAndAssertNoSurvivors(
	stop: () => Promise<void>,
	existingChildren: ReadonlySet<number> = new Set(),
): Promise<void> {
	const beforeStop = processSnapshot();
	const tracked = descendants(beforeStop, new Set([process.pid]));
	const excluded = descendants(beforeStop, existingChildren);
	await stop();
	const afterStop = processSnapshot();
	// Track before teardown: a child can be reparented when its parent exits.
	const candidates = descendants(afterStop, tracked);
	const ignored = descendants(afterStop, excluded);
	const survivors = afterStop.filter(
		(child) =>
			child.pid !== process.pid &&
			candidates.has(child.pid) &&
			!ignored.has(child.pid) &&
			// Zombies (Z) and macOS processes already exiting (E) are dead, not leaks.
			!/^Z|E/.test(child.stat ?? ""),
	);
	// An exiting process has lost its arguments, so name it as it was before stop.
	const named = new Map(beforeStop.map((child) => [child.pid, child.command]));
	if (survivors.length > 0)
		throw new Error(
			`Children survived daemon.stop():\n${survivors.map((child) => `${child.pid} ppid=${child.ppid} ${child.stat} ${named.get(child.pid) ?? child.command}`).join("\n")}`,
		);
}
