import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	_getOutputStream,
	createLogger,
	createSilentLogger,
	createTestLogger,
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
	const origWrite = dest.write.bind(dest) as (chunk: unknown) => boolean;
	dest.write = ((chunk: Buffer | string) => {
		const str = chunk.toString().trim();
		if (str) lines.push(str);
		return origWrite(chunk);
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
