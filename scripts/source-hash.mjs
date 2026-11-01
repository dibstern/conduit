import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

export function sourceHash(root = process.cwd()) {
	const files = readdirSync(`${root}/src`, { recursive: true })
		.map((path) => `src/${path}`)
		.filter((path) => statSync(`${root}/${path}`).isFile());
	files.push(
		...[
			"package.json",
			"pnpm-lock.yaml",
			"pnpm-workspace.yaml",
			".npmrc",
			"tsconfig.json",
			"tsconfig.build.json",
			"vite.config.ts",
			"scripts/build.mjs",
			"scripts/source-hash.mjs",
			// tsconfig.build.json also emits the stamped-daemon E2E helper.
			"test/e2e/helpers/build-id-daemon.ts",
		].filter((path) => existsSync(`${root}/${path}`)),
	);
	const hash = createHash("sha256");
	for (const path of files.sort()) {
		const content = readFileSync(`${root}/${path}`);
		hash.update(`${path}\0${content.length}\0`).update(content);
	}
	return hash.digest("hex");
}

export function checkDist(distDir = "dist") {
	if (process.env.CONDUIT_SKIP_DIST_CHECK === "1") return;
	let builtHash;
	try {
		builtHash = JSON.parse(
			readFileSync(`${distDir}/build-ready.json`, "utf8"),
		)?.sourceHash;
	} catch {
		// Missing and incomplete markers both require a fresh full build.
	}
	if (builtHash !== sourceHash()) {
		throw new Error(`${distDir}/ is stale or missing: run pnpm build`);
	}
}

export function setup() {
	const distDir = process.env.CONDUIT_TEST_DIST ?? "dist";
	// An empty CONDUIT_TEST_DIST runs fixtures from source, so no build applies.
	if (distDir !== "") checkDist(distDir);
}

if (import.meta.main) {
	if (process.argv[2] !== "check") {
		console.error("Usage: node scripts/source-hash.mjs check [distDir]");
		process.exitCode = 1;
	} else {
		try {
			checkDist(process.argv[3] ?? "dist");
		} catch (error) {
			console.error(error.message);
			process.exitCode = 1;
		}
	}
}
