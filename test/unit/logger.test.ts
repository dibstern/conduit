import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_getOutputStream,
	createLogger,
	createSilentLogger,
	createTestLogger,
	setLogFile,
	setLogFormat,
	setLogLevel,
} from "../../src/lib/logger.js";

/**
 * Helper: collect all lines written to the logger's output stream.
 * For JSON format, lines are raw JSON. For pretty format, lines are formatted text.
 */
function collectLines(): string[] {
	const dest = _getOutputStream();
	const lines: string[] = [];
	dest.write = ((chunk: Buffer | string) => {
		const str = chunk.toString().trim();
		if (str) lines.push(str);
		return true;
	}) as typeof dest.write;
	return lines;
}

/** Parse the first collected line as JSON, with a descriptive assertion if missing. */
// biome-ignore lint/suspicious/noExplicitAny: test helper needs loose typing for JSON
function parseFirst(lines: string[]): any {
	expect(lines.length).toBeGreaterThanOrEqual(1);
	return JSON.parse(lines[0] ?? "{}");
}

/** Get the nth collected line as a string. */
function line(lines: string[], index: number): string {
	expect(lines.length).toBeGreaterThan(index);
	return lines[index] ?? "";
}

describe("createLogger", () => {
	beforeEach(() => {
		// Reset to known state before each test
		setLogLevel("debug");
		setLogFormat("json");
	});

	afterAll(() => {
		// Restore suppressed level so subsequent tests in the same process
		// don't inherit "debug" and spam the console.
		setLogLevel("error");
		setLogFormat("json");
	});

	it("creates a root logger that writes output", () => {
		const lines = collectLines();
		const log = createLogger("test");
		log.info("hello");
		const parsed = parseFirst(lines);
		expect(parsed.component).toContain("test");
		expect(parsed.msg).toBe("hello");
	});

	it("maps levels to correct pino levels", () => {
		const lines = collectLines();
		const log = createLogger("test");
		log.info("i");
		log.warn("w");
		log.error("e");
		log.debug("d");

		expect(lines.length).toBe(4);
		const levels = lines.map((l) => JSON.parse(l).level);
		// pino levels: debug=20, info=30, warn=40, error=50
		expect(levels).toEqual([30, 40, 50, 20]);
	});

	it("child logger includes parent and child tags", () => {
		const lines = collectLines();
		const parent = createLogger("relay");
		const child = parent.child("sse");
		child.info("connected");
		const parsed = parseFirst(lines);
		expect(parsed.component).toContain("relay");
		expect(parsed.component).toContain("sse");
		expect(parsed.msg).toBe("connected");
	});

	it("child logger nests component tags in order", () => {
		const lines = collectLines();
		const root = createLogger("relay");
		const child = root.child("sse");
		const grandchild = child.child("reconnect");
		grandchild.info("attempt");
		const parsed = parseFirst(lines);
		expect(parsed.component).toEqual(["relay", "sse", "reconnect"]);
	});

	it("passes extra args as merged message", () => {
		const lines = collectLines();
		const log = createLogger("test");
		log.warn("failed:", new Error("boom"));
		const parsed = parseFirst(lines);
		expect(parsed.msg).toContain("failed:");
	});

	it("verbose outputs at custom level 25", () => {
		const lines = collectLines();
		const log = createLogger("test");
		log.verbose("v");
		const parsed = parseFirst(lines);
		expect(parsed.level).toBe(25);
		expect(parsed.msg).toBe("v");
	});
});

describe("log level filtering", () => {
	beforeEach(() => {
		setLogFormat("json");
	});

	it("filters debug when level is info", () => {
		setLogLevel("info");
		const lines = collectLines();
		const log = createLogger("test");
		log.debug("should not appear");
		expect(lines.length).toBe(0);
	});

	it("filters verbose when level is info", () => {
		setLogLevel("info");
		const lines = collectLines();
		const log = createLogger("test");
		log.verbose("should not appear");
		expect(lines.length).toBe(0);
	});

	it("shows info when level is info", () => {
		setLogLevel("info");
		const lines = collectLines();
		const log = createLogger("test");
		log.info("should appear");
		expect(lines.length).toBe(1);
	});

	it("shows verbose when level is verbose", () => {
		setLogLevel("verbose");
		const lines = collectLines();
		const log = createLogger("test");
		log.verbose("should appear");
		expect(lines.length).toBe(1);
	});

	it("filters debug when level is verbose", () => {
		setLogLevel("verbose");
		const lines = collectLines();
		const log = createLogger("test");
		log.debug("should not appear");
		expect(lines.length).toBe(0);
	});

	it("shows warn and error when level is warn", () => {
		setLogLevel("warn");
		const lines = collectLines();
		const log = createLogger("test");
		log.info("no");
		log.warn("yes-warn");
		log.error("yes-error");
		expect(lines.length).toBe(2);
	});

	it("shows all levels when level is debug", () => {
		setLogLevel("debug");
		const lines = collectLines();
		const log = createLogger("test");
		log.debug("d");
		log.verbose("v");
		log.info("i");
		log.warn("w");
		log.error("e");
		expect(lines.length).toBe(5);
	});
});

describe("log format", () => {
	beforeEach(() => {
		setLogLevel("debug");
	});

	it("json format outputs parseable JSON", () => {
		setLogFormat("json");
		const lines = collectLines();
		const log = createLogger("test");
		log.info("check");
		expect(lines.length).toBe(1);
		expect(() => JSON.parse(line(lines, 0))).not.toThrow();
	});

	it("pretty format outputs human-readable text with tags", () => {
		setLogFormat("pretty");
		const lines = collectLines();
		const log = createLogger("relay");
		log.info("hello");
		const output = line(lines, 0);
		expect(output).toContain("[relay]");
		expect(output).toContain("hello");
		expect(() => JSON.parse(output)).toThrow();
	});

	it("pretty format aligns message bodies to consistent column", () => {
		setLogFormat("pretty");
		const lines = collectLines();
		const root = createLogger("relay");
		const short = root.child("sse");
		const long = root.child("status-poller");

		short.info("msg-a");
		long.info("msg-b");

		const outputA = line(lines, 0);
		const outputB = line(lines, 1);
		const idxA = outputA.indexOf("msg-a");
		const idxB = outputB.indexOf("msg-b");
		expect(idxA).toBe(idxB);
		expect(idxA).toBeGreaterThan(0);
	});
});

describe("createSilentLogger", () => {
	it("does not throw on any method", () => {
		const log = createSilentLogger();
		expect(() => {
			log.debug("a");
			log.verbose("b");
			log.info("c");
			log.warn("d");
			log.error("e");
			log.child("x").info("f");
		}).not.toThrow();
	});

	it("child returns another silent logger", () => {
		const log = createSilentLogger();
		const child = log.child("x");
		expect(child).toBeDefined();
		expect(() => child.info("test")).not.toThrow();
	});
});

describe("createTestLogger", () => {
	it("does not throw on any method", () => {
		const log = createTestLogger();
		expect(() => {
			log.debug("a");
			log.verbose("b");
			log.info("c");
			log.warn("d");
			log.error("e");
			log.child("x").info("f");
		}).not.toThrow();
	});

	it("child returns another test logger", () => {
		const log = createTestLogger();
		const child = log.child("x");
		expect(child).toBeDefined();
		expect(() => child.info("test")).not.toThrow();
	});
});

describe("log file", () => {
	let tempDir: string;
	let logPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "conduit-logger-"));
		logPath = join(tempDir, "daemon.log");
		setLogLevel("debug");
		setLogFormat("json");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("writes only warn and error JSON records, including existing loggers' components", () => {
		const log = createLogger("daemon").child("startup");
		const lines = collectLines();
		setLogFile(logPath);

		log.debug("debug");
		log.verbose("verbose");
		log.info("info");
		log.warn("warning");
		log.error("error");

		const records = readFileSync(logPath, "utf8").trim().split("\n");
		expect(records).toHaveLength(2);
		expect(JSON.parse(line(records, 0))).toMatchObject({
			level: 40,
			component: ["daemon", "startup"],
			msg: "warning",
		});
		expect(JSON.parse(line(records, 1))).toMatchObject({
			level: 50,
			component: ["daemon", "startup"],
			msg: "error",
		});
		expect(lines).toHaveLength(5);
	});

	it.each([
		"json",
		"pretty",
	] as const)("preserves stdout filtering at every level in %s format", (format) => {
		setLogFormat(format);
		setLogFile(logPath);
		const levels = ["debug", "verbose", "info", "warn", "error"] as const;

		for (const [index, level] of levels.entries()) {
			setLogLevel(level);
			const lines = collectLines();
			const log = createLogger("test");
			for (const messageLevel of levels) log[messageLevel](messageLevel);

			const expected = levels.slice(index);
			expect(lines).toHaveLength(expected.length);
			for (const [messageIndex, message] of expected.entries()) {
				const output = line(lines, messageIndex);
				if (format === "json") {
					expect(JSON.parse(output).msg).toBe(message);
				} else {
					expect(output).toContain("[test]");
					expect(output).toContain(message);
					expect(() => JSON.parse(output)).toThrow();
				}
			}
		}

		const records = readFileSync(logPath, "utf8").trim().split("\n");
		expect(records.map((record) => JSON.parse(record).level)).toEqual([
			40, 50, 40, 50, 40, 50, 40, 50, 40, 50,
		]);
	});

	it("keeps the file attached across level and format changes", () => {
		setLogFile(logPath);
		collectLines();
		const existing = createLogger("test");
		existing.warn("before");
		setLogLevel("verbose");
		collectLines();
		existing.warn("existing");
		createLogger("test").warn("level");
		setLogFormat("pretty");
		collectLines();
		createLogger("test").warn("format");

		const records = readFileSync(logPath, "utf8").trim().split("\n");
		expect(records.map((record) => JSON.parse(record).msg)).toEqual([
			"before",
			"existing",
			"level",
			"format",
		]);
	});

	it("appends to an existing file", () => {
		const original = '{"level":40,"component":["old"],"msg":"kept"}\n';
		writeFileSync(logPath, original);
		setLogFile(logPath);
		collectLines();
		createLogger("test").warn("appended");

		const content = readFileSync(logPath, "utf8");
		expect(content.startsWith(original)).toBe(true);
		expect(JSON.parse(content.slice(original.length)).msg).toBe("appended");
	});

	it("rotates at the byte limit using the existing size and replaces its only backup", () => {
		const cap = 512;
		const original = "old\n".repeat(128);
		writeFileSync(logPath, original);
		writeFileSync(`${logPath}.1`, "stale backup\n");
		setLogFile(logPath, cap);
		collectLines();
		const log = createLogger("test");

		log.warn(`first ${"🙂".repeat(50)}`);
		const first = readFileSync(logPath, "utf8");
		expect(readFileSync(`${logPath}.1`, "utf8")).toBe(original);
		expect(JSON.parse(first).msg).toBe(`first ${"🙂".repeat(50)}`);
		expect(Buffer.byteLength(first)).toBeLessThanOrEqual(cap);

		log.error(`second ${"🙂".repeat(50)}`);
		expect(readFileSync(`${logPath}.1`, "utf8")).toBe(first);
		const second = readFileSync(logPath, "utf8");
		expect(JSON.parse(second).msg).toBe(`second ${"🙂".repeat(50)}`);
		expect(readdirSync(tempDir).sort()).toEqual(["daemon.log", "daemon.log.1"]);
	});

	it("ignores an unwritable path and keeps stdout logging", () => {
		const blocker = join(tempDir, "regular-file");
		writeFileSync(blocker, "not a directory");
		const lines = collectLines();
		expect(() => setLogFile(join(blocker, "daemon.log"))).not.toThrow();
		const log = createLogger("test");
		expect(() => {
			log.info("info");
			log.warn("warning");
			log.error("error");
		}).not.toThrow();
		expect(lines.map((output) => JSON.parse(output).msg)).toEqual([
			"info",
			"warning",
			"error",
		]);
	});

	it("ignores write failures after attachment and keeps stdout logging", () => {
		setLogFile(logPath);
		rmSync(logPath);
		mkdirSync(logPath);
		const lines = collectLines();
		const log = createLogger("test");
		expect(() => {
			log.warn("warning");
			log.error("error");
		}).not.toThrow();
		expect(lines.map((output) => JSON.parse(output).msg)).toEqual([
			"warning",
			"error",
		]);
	});
});
