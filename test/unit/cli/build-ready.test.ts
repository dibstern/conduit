// Failure cases: a marker published before the frontend, mismatched identities,
// a server-only or failed build leaving an old ready marker, and a partial file.
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function build(serverOnly = false, failFrontend = false) {
	const root = mkdtempSync(join(tmpdir(), "conduit-build-ready-"));
	roots.push(root);
	const bin = join(root, "bin");
	mkdirSync(bin);
	mkdirSync(join(root, "dist"));
	writeFileSync(join(root, "dist/build-ready.json"), '{"buildId":"old"}');
	writeFileSync(
		join(bin, "pnpm"),
		`#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[1] === "tsgo") mkdirSync("dist/src/lib", { recursive: true });
if (args[1] === "vite") {
	writeFileSync("frontend-start.json", JSON.stringify({ ready: existsSync("dist/build-ready.json") }));
	if (process.env.FAIL_FRONTEND === "1") process.exit(1);
	mkdirSync("dist/public", { recursive: true });
	writeFileSync("dist/public/index.html", process.env.CONDUIT_BUILD_ID);
}
`,
		{ mode: 0o755 },
	);
	const result = spawnSync(
		process.execPath,
		[resolve("scripts/build.mjs"), ...(serverOnly ? ["server"] : [])],
		{
			cwd: root,
			env: {
				...process.env,
				PATH: `${bin}:${process.env["PATH"] ?? ""}`,
				FAIL_FRONTEND: failFrontend ? "1" : "0",
			},
			encoding: "utf8",
		},
	);
	return { root, result, ready: join(root, "dist/build-ready.json") };
}

describe("complete build publication", () => {
	it("publishes one identity only after the frontend finishes", () => {
		const { root, result, ready } = build();
		expect(result.status, result.stderr).toBe(0);
		expect(
			JSON.parse(readFileSync(join(root, "frontend-start.json"), "utf8")),
		).toEqual({ ready: false });
		const marker: unknown = JSON.parse(readFileSync(ready, "utf8"));
		const frontendId = readFileSync(
			join(root, "dist/public/index.html"),
			"utf8",
		);
		expect(marker).toEqual({ buildId: frontendId });
		expect(
			readFileSync(join(root, "dist/src/lib/build-id.js"), "utf8"),
		).toContain(JSON.stringify(frontendId));
		expect(readdirSync(join(root, "dist"))).toEqual(
			expect.arrayContaining(["build-ready.json", "public", "src"]),
		);
		expect(
			readdirSync(join(root, "dist")).filter((name) => name.endsWith(".tmp")),
		).toEqual([]);
	});

	it("invalidates an old marker without publishing a server-only build", () => {
		const { root, result, ready } = build(true);
		expect(result.status, result.stderr).toBe(0);
		expect(existsSync(ready)).toBe(false);
		expect(existsSync(join(root, "dist/public/index.html"))).toBe(false);
	});

	it("keeps a failed frontend build unavailable", () => {
		const { result, ready } = build(false, true);
		expect(result.status).toBe(1);
		expect(existsSync(ready)).toBe(false);
	});
});
