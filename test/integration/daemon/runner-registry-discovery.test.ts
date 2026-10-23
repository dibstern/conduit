import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	discoverAllRunners,
	prepareRunnerDirectory,
	type RunnerRegistration,
	registerRunner,
} from "../../../src/lib/provider/runner/runner-registry.js";

// Failure modes: a retained long-path directory loses its temporary alias, or
// that alias points outside its owner and discovery reads or removes other files.
describe("daemon runner discovery", () => {
	let root: string;
	let configDir: string;
	let socketDirectory: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "conduit-runner-discovery-"));
		configDir = join(root, "private", "c".repeat(120));
		socketDirectory = prepareRunnerDirectory(
			join(root, "retained-project"),
			configDir,
		);
	});

	afterEach(() => {
		rmSync(socketDirectory, { force: true });
		rmSync(root, { recursive: true, force: true });
	});

	it("restores a missing alias and discovers retained registrations without a project", () => {
		const target = readlinkSync(socketDirectory);
		const registration = {
			driverKind: "claude",
			runnerId: "0123456789ab",
			sessionId: "retained-session",
			socketPath: join(socketDirectory, "0123456789ab"),
			buildId: "retained-build",
			pid: process.pid,
		} satisfies RunnerRegistration;
		registerRunner(registration);
		writeFileSync(`${registration.socketPath}.spool`, "retained output");
		rmSync(socketDirectory);
		expect(existsSync(socketDirectory)).toBe(false);

		expect(discoverAllRunners(configDir)).toEqual([registration]);
		expect(readlinkSync(socketDirectory)).toBe(target);
		expect(readFileSync(`${registration.socketPath}.spool`, "utf8")).toBe(
			"retained output",
		);
	});

	it("refuses a substituted alias without reading or removing its files", () => {
		const otherDirectory = join(root, "other-owner");
		mkdirSync(otherDirectory);
		const otherFile = join(otherDirectory, "abcdef012345.json");
		writeFileSync(otherFile, "other owner's data");
		rmSync(socketDirectory);
		symlinkSync(otherDirectory, socketDirectory);

		expect(() => discoverAllRunners(configDir)).toThrow(
			"Unsafe runner socket alias",
		);
		expect(readFileSync(otherFile, "utf8")).toBe("other owner's data");
	});
});
