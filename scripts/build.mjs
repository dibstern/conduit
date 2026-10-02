import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

// One identity for both outputs, without modifying the source dev sentinel.
const buildId = randomUUID();
const env = { ...process.env, CONDUIT_BUILD_ID: buildId };

function run(...args) {
	const result = spawnSync("pnpm", args, { env, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

// Copy first: migrations now also contain TS modules emitted by tsgo.
run("copy:assets");
run("exec", "tsgo");
writeFileSync(
	"dist/src/lib/build-id.js",
	`export const BUILD_ID = ${JSON.stringify(buildId)};\n`,
);
if (process.argv[2] !== "server") run("exec", "vite", "build");
