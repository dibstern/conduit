import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import {
	makeLinuxProcessAdapter,
	makeProcessTable,
	sameProcess,
} from "../../src/lib/provider/runner/process-table.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function procFixture() {
	const root = mkdtempSync(join(tmpdir(), "conduit-proc-"));
	roots.push(root);
	mkdirSync(join(root, "sys/kernel/random"), { recursive: true });
	writeFileSync(
		join(root, "sys/kernel/random/boot_id"),
		"12345678-1234-1234-1234-123456789abc\n",
	);
	writeFileSync(join(root, "stat"), "cpu 1 2 3 4\nbtime 1704067200\n");
	return root;
}

function putProcess(
	root: string,
	pid: number,
	ticks: string,
	state = "S",
	pgid = 10,
) {
	mkdirSync(join(root, String(pid)), { recursive: true });
	// Linux permits spaces, newlines and ')' in comm; field 22 is the start tick.
	writeFileSync(
		join(root, String(pid), "stat"),
		`${pid} (name ) with\nspaces)) ${[state, "1", String(pgid), ...Array<string>(16).fill("0"), ticks, "0"].join(" ")}\n`,
	);
}

it("Linux start times truncate ticks at second boundaries and keep one boot identity", () => {
	const root = procFixture();
	const table = makeProcessTable(makeLinuxProcessAdapter(root));
	const zone = process.env["TZ"];
	process.env["TZ"] = "UTC";
	try {
		for (const [ticks, expected] of [
			["0", "Mon Jan  1 00:00:00 2024"],
			["99", "Mon Jan  1 00:00:00 2024"],
			["100", "Mon Jan  1 00:00:01 2024"],
			["199", "Mon Jan  1 00:00:01 2024"],
			["200", "Mon Jan  1 00:00:02 2024"],
		]) {
			putProcess(root, 10, ticks ?? "");
			expect(table.identify([10]).get(10)).toEqual({
				state: "running",
				pgid: 10,
				startTime: expected,
				startKey: `l:12345678-1234-1234-1234-123456789abc:${ticks}`,
			});
		}
		writeFileSync(join(root, "sys/kernel/random/boot_id"), "changed\n");
		expect(table.identify([10]).get(10)).toHaveProperty(
			"startKey",
			"l:12345678-1234-1234-1234-123456789abc:200",
		);
	} finally {
		if (zone === undefined) delete process.env["TZ"];
		else process.env["TZ"] = zone;
	}
});

it("Linux argv preserves empty arguments and spaces, and zombies are gone for identity", () => {
	const root = procFixture();
	putProcess(root, 10, "123", "Z");
	writeFileSync(join(root, "10/cmdline"), "python3\0argument with spaces\0\0");
	const table = makeProcessTable(makeLinuxProcessAdapter(root));
	expect(table.argv(10)).toEqual(["python3", "argument with spaces", ""]);
	expect(table.argv(11)).toBeUndefined();
	const seen = table.identify([10]).get(10);
	expect(seen).toHaveProperty("state", "zombie");
	expect(sameProcess({ pid: 10 }, seen)).toBe("gone");
});

it("Linux groups skip vanished pids and yield while walking bounded slices", async () => {
	const root = procFixture();
	for (let pid = 10; pid < 90; pid++)
		putProcess(root, pid, "100", pid === 11 ? "Z" : "S", pid === 12 ? 12 : 10);
	mkdirSync(join(root, "90"));
	const table = makeProcessTable(makeLinuxProcessAdapter(root));
	let yielded = false;
	setImmediate(() => {
		yielded = true;
	});
	const observation = await Effect.runPromise(
		table.observe({ pgid: 10, pids: [10] }),
	);
	expect(yielded).toBe(true);
	expect(observation.group).toHaveLength(79);
	expect(observation.processes.get(11)).toHaveProperty("state", "zombie");
	expect(observation.group?.some(({ pid }) => pid === 12 || pid === 90)).toBe(
		false,
	);
});

it("Linux unreadable or malformed stat is unknown and never an empty group", async () => {
	const root = procFixture();
	putProcess(root, 10, "100");
	mkdirSync(join(root, "11"));
	symlinkSync("stat", join(root, "11/stat")); // ELOOP, unlike a vanished process.
	const table = makeProcessTable(makeLinuxProcessAdapter(root));
	expect(table.identify([11, 12]).get(11)).toEqual({ state: "unknown" });
	expect(table.identify([12]).get(12)).toEqual({ state: "gone" });
	expect(
		(await Effect.runPromise(table.observe({ pgid: 10, pids: [10] }))).group,
	).toBeUndefined();
	rmSync(join(root, "11/stat"));
	for (const stat of [
		"garbage",
		"12 (wrong pid) S 1 10",
		"11 (bad) S 1 10",
		"",
	]) {
		writeFileSync(join(root, "11/stat"), stat);
		expect(table.identify([11]).get(11)).toEqual({ state: "unknown" });
		expect(
			(await Effect.runPromise(table.observe({ pgid: 10, pids: [10] }))).group,
		).toBeUndefined();
	}
	rmSync(join(root, "10"), { recursive: true });
	expect(
		(await Effect.runPromise(table.observe({ pgid: 10, pids: [10] }))).group,
	).toBeUndefined();
});

it("Linux self-check rejects an implausible USER_HZ or process layout", () => {
	const root = procFixture();
	putProcess(root, process.pid, "0");
	const adapter = makeLinuxProcessAdapter(root);
	expect(() => adapter.selfCheck()).toThrow(/self-check/);
});
