// Failure modes: capture headers mislabel the installed SDK, private manifest
// exports block version lookup, and replay/audit silently accept unknown SDKs.
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as realSdk from "../../../../src/lib/provider/cursor/sdk-real.js";
import { createCursorSdkTrace } from "../../../../src/lib/provider/cursor/sdk-trace.js";
import {
	createTraceCursorSdkPort,
	SUPPORTED_TRACE_VERSIONS,
} from "../../../../src/lib/provider/cursor/sdk-trace-player.js";

const root = resolve(import.meta.dirname, "../../../..");
const installedVersion = (
	JSON.parse(
		readFileSync(join(root, "node_modules/@cursor/sdk/package.json"), "utf8"),
	) as { version: string }
).version;
const source = readFileSync(
	join(root, "test/fixtures/cursor-sdk-traces/basic.jsonl"),
	"utf8",
);
const directories: string[] = [];

function traceFile(version: string): { directory: string; path: string } {
	const directory = mkdtempSync(join(tmpdir(), "cursor-trace-version-"));
	directories.push(directory);
	const fixtureDirectory = join(directory, "test/fixtures/cursor-sdk-traces");
	mkdirSync(fixtureDirectory, { recursive: true });
	const path = join(fixtureDirectory, "basic.jsonl");
	const [header, ...rows] = source.split("\n");
	writeFileSync(
		path,
		[
			JSON.stringify({ ...JSON.parse(header ?? ""), sdkVersion: version }),
			...rows,
		].join("\n"),
	);
	return { directory, path };
}

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("Cursor SDK trace versions", () => {
	it("reads the installed version even though the manifest subpath is private", () => {
		const require = createRequire(import.meta.url);
		expect(() => require.resolve("@cursor/sdk/package.json")).toThrow();
		expect(realSdk.cursorSdkVersion()).toBe(installedVersion);
	});

	it("stamps captures with the resolved installed SDK version", () => {
		const { path } = traceFile("1.0.37");
		rmSync(path);
		createCursorSdkTrace(path).record("runtime.probe", { available: true });
		const header = JSON.parse(readFileSync(path, "utf8").split("\n")[0] ?? "");
		expect(header.sdkVersion).toBe(installedVersion);
	});

	it.each(["1.0.37", "1.0.40"])("replays declared SDK %s traces", (version) => {
		const { path } = traceFile(version);
		expect(() => createTraceCursorSdkPort(path)).not.toThrow();
	});

	it.each([
		"1.0.41",
		"2.0.0",
		"not-a-version",
	])("rejects undeclared SDK %s traces", (version) => {
		const { path } = traceFile(version);
		expect(() => createTraceCursorSdkPort(path)).toThrow(
			"Invalid Cursor SDK trace header",
		);
	});

	it.each(["1.0.37", "1.0.40"])("audits declared SDK %s traces", (version) => {
		const { directory } = traceFile(version);
		const checked = spawnSync(
			process.execPath,
			[join(root, "scripts/check-cursor-sdk-traces.mjs")],
			{
				cwd: directory,
				encoding: "utf8",
			},
		);
		expect(checked.status, checked.stderr || checked.stdout).toBe(0);
		expect(JSON.parse(checked.stdout).supportedTraceVersions).toEqual(
			SUPPORTED_TRACE_VERSIONS,
		);
	});

	it("rejects an undeclared semver in the trace audit", () => {
		const { directory } = traceFile("1.0.41");
		const checked = spawnSync(
			process.execPath,
			[join(root, "scripts/check-cursor-sdk-traces.mjs")],
			{
				cwd: directory,
				encoding: "utf8",
			},
		);
		expect(checked.status).toBe(1);
		expect(JSON.parse(checked.stdout).invalidHeaders).toBe(1);
	});
});
