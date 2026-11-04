// Parent for the Cursor kill check: SIGKILL the SDK host mid-shell-tool and see
// whether the local run's work still completes (marker file) or its processes survive.
// Usage: node cursor-kill.mjs <worktree> <outFile> <model> [pid|group]
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [worktree, outFile, model, mode = "pid"] = process.argv.slice(2);
// test-waits-allow real-wait: live probes time real provider work; the delays are the experiment.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const here = dirname(fileURLToPath(import.meta.url));
const marker = join(mkdtempSync(join(tmpdir(), "lane-live-kill-")), "marker");
const t0 = Date.now();
const log = [];
const note = (kind, data) => log.push({ t: Date.now() - t0, kind, data });
const descendants = (pid) => {
	let out = "";
	try {
		out = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
	} catch {}
	return out
		.split("\n")
		.filter(Boolean)
		.flatMap((c) => [Number(c), ...descendants(Number(c))]);
};
const ps = (pids) => {
	if (!pids.length) return [];
	try {
		return execFileSync(
			"ps",
			["-o", "pid=,ppid=,pgid=,command=", "-p", pids.join(",")],
			{
				encoding: "utf8",
			},
		)
			.split("\n")
			.filter(Boolean)
			.map((l) => l.trim().slice(0, 200));
	} catch {
		return [];
	}
};
const byMarker = () => {
	try {
		return execFileSync("pgrep", ["-f", marker], { encoding: "utf8" })
			.split("\n")
			.filter(Boolean)
			.map(Number);
	} catch {
		return [];
	}
};

const child = spawn(
	process.execPath,
	[
		join(here, "cursor-probe.mjs"),
		worktree,
		`${outFile}.child.json`,
		"kill-child",
		model,
		marker,
	],
	{ stdio: ["ignore", "pipe", "pipe"], detached: mode === "group" },
);
note("child_spawned", { pid: child.pid, marker });
const toolStart = new Promise((resolve) => {
	child.stdout.on("data", (b) => String(b).includes("TOOL_START") && resolve());
});
const timer = setTimeout(() => note("no_tool_start", {}), 90_000);
await Promise.race([toolStart, sleep(90_000)]);
clearTimeout(timer);
// Wait until the shell command itself runs (a process naming the marker other than the child).
for (
	let i = 0;
	i < 200 && !ps(descendants(child.pid)).some((l) => /\bsleep 8\b/.test(l));
	i++
)
	await sleep(100);
note("command_running", { tree: ps(descendants(child.pid)) });
await sleep(500);
const tree = descendants(child.pid);
note("before_kill", { tree: ps(tree), markerProcs: ps(byMarker()) });
try {
	process.kill(child.pid, "SIGKILL");
} catch (e) {
	note("sigkill_failed", String(e));
}
note("sigkill_sent", { pid: child.pid, mode });
if (mode === "group") {
	// What the runner reaper does on runner death: TERM the group, then KILL it.
	await sleep(100);
	try {
		process.kill(-child.pid, "SIGTERM");
		note("group_term_sent", { pgid: child.pid });
	} catch (e) {
		note("group_term_failed", String(e));
	}
	await sleep(3000);
	try {
		process.kill(-child.pid, "SIGKILL");
		note("group_kill_sent", { pgid: child.pid });
	} catch (e) {
		note("group_kill_failed", String(e));
	}
}
await sleep(1000);
note("after_kill_1s", { survivors: ps(tree), markerProcs: ps(byMarker()) });
await sleep(14_000);
const survivors = tree.filter((p) => ps([p]).length);
note("after_kill_15s", {
	markerExists: existsSync(marker),
	survivors: ps(survivors),
	markerProcs: ps(byMarker()),
});
// Clean up only processes this probe's child started.
for (const p of survivors) {
	try {
		process.kill(p, "SIGKILL");
	} catch {}
}
note("cleanup", { killed: survivors });
writeFileSync(outFile, JSON.stringify(log, null, 1));
console.log(JSON.stringify(log, null, 1).slice(0, 4000));
process.exit(0);
