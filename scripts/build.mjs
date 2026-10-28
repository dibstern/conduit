import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { setTimeout } from "node:timers/promises";
import { sourceHash } from "./source-hash.mjs";

// Concurrent builds (pre-commit, dev:all, agents) would interleave dist/ and
// stamp the server and frontend with different build IDs, so take turns.
const lockPath = "dist/.build.lock";
const lockPid = String(process.pid);
let announcedPid;
mkdirSync("dist", { recursive: true });
while (true) {
	try {
		writeFileSync(lockPath, lockPid, { flag: "wx" });
		break;
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
	try {
		const holder = readFileSync(lockPath, "utf8").trim();
		// Nine digits keeps any real PID in process.kill's range.
		const pid = /^\d{1,9}$/.test(holder) ? Number(holder) : 0;
		let stale = false;
		if (pid > 0) {
			try {
				process.kill(pid, 0);
			} catch (error) {
				if (error.code === "ESRCH") stale = true;
				else if (error.code !== "EPERM") throw error;
			}
			if (!stale && pid !== announcedPid) {
				console.log(`[build] waiting for build PID ${pid}`);
				announcedPid = pid;
			}
		} else {
			// The holder may be between creating the lock and writing its PID.
			stale = Date.now() - statSync(lockPath).mtimeMs > 5000;
		}
		if (stale) {
			rmSync(lockPath);
			continue;
		}
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		continue;
	}
	await setTimeout(250);
}
process.on("exit", () => {
	try {
		if (readFileSync(lockPath, "utf8") === lockPid) rmSync(lockPath);
	} catch {
		// Lock cleanup must not prevent process exit.
	}
});

// One identity for both outputs, without modifying the source dev sentinel.
const buildId = randomUUID();
const hash = sourceHash();
const env = { ...process.env, CONDUIT_BUILD_ID: buildId };

// The previous marker cannot describe outputs being replaced by this build.
rmSync("dist/build-ready.json", { force: true });

function run(...args) {
	return new Promise((resolve, reject) => {
		const child = spawn("pnpm", args, { env, stdio: "inherit" });
		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? 1));
	});
}

// Copy first: migrations now also contain TS modules emitted by tsgo.
const copyCode = await run("copy:assets");
if (copyCode !== 0) process.exit(copyCode);
const serverOnly = process.argv[2] === "server";
// The compilers write separate directories. Even on failure, wait for both
// before releasing the lock so another build cannot interleave their outputs.
const results = await Promise.allSettled([
	run("exec", "tsgo", "--project", "tsconfig.build.json"),
	...(serverOnly ? [] : [run("exec", "vite", "build")]),
]);
for (const result of results) {
	if (result.status === "rejected") throw result.reason;
	if (result.value !== 0) process.exit(result.value);
}
writeFileSync(
	"dist/src/lib/build-id.js",
	`export const BUILD_ID = ${JSON.stringify(buildId)};\n`,
);
if (!serverOnly) {
	const marker = `dist/build-ready.${process.pid}.tmp`;
	writeFileSync(marker, JSON.stringify({ buildId, sourceHash: hash }));
	renameSync(marker, "dist/build-ready.json");
}
