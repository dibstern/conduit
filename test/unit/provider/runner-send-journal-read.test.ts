import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readRunnerSendJournal } from "../../../src/lib/provider/runner/runner-send-journal.js";

const roots: string[] = [];
const fixture = () => {
	const directory = mkdtempSync(join(tmpdir(), "send-journal-read-"));
	roots.push(directory);
	const input = {
		directory,
		sessionId: "s",
		driverKind: "claude",
		commandId: "c",
		attempt: 1,
		nativeResumeFallback: false,
	};
	const sends = join(directory, "sends", "s");
	mkdirSync(sends, { recursive: true });
	const key = createHash("sha256")
		.update(JSON.stringify(["claude", "s", "c", 1, false]))
		.digest("hex");
	return { input, sends, filename: join(sends, `${key}.json`) };
};
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

it("distinguishes an absent transmission from a corrupt or unreadable journal", () => {
	const f = fixture();
	expect(readRunnerSendJournal(f.input)).toEqual({ _tag: "Absent" });
	writeFileSync(f.filename, "{");
	expect(readRunnerSendJournal(f.input)).toEqual({ _tag: "Unreadable" });
	rmSync(f.sends, { recursive: true });
	writeFileSync(f.sends, "not a directory");
	expect(readRunnerSendJournal(f.input)).toEqual({ _tag: "Unreadable" });
});

it("retains received input as uncertain and returns a completed journal answer", () => {
	const f = fixture();
	const record = {
		commandId: "c",
		attempt: 1,
		runnerPid: 123,
		startedAt: 1,
		nativeResumeFallback: false,
	};
	writeFileSync(f.filename, JSON.stringify(record));
	expect(readRunnerSendJournal(f.input)).toEqual({
		_tag: "Present",
		state: {
			commandId: "c",
			attempt: 1,
			nativeResumeFallback: false,
			status: "uncertain",
		},
	});
	const result = {
		status: "completed",
		cost: 0,
		tokens: { input: 0, output: 0 },
		durationMs: 0,
		providerStateUpdates: [],
	};
	writeFileSync(
		f.filename,
		JSON.stringify({ ...record, completedAt: 2, result }),
	);
	expect(readRunnerSendJournal(f.input)).toEqual({
		_tag: "Present",
		state: {
			commandId: "c",
			attempt: 1,
			nativeResumeFallback: false,
			status: "finished",
			result,
		},
	});
});

it("rejects a well-formed record for a different command as unreadable", () => {
	const f = fixture();
	writeFileSync(
		f.filename,
		JSON.stringify({
			commandId: "other",
			attempt: 1,
			runnerPid: 123,
			startedAt: 1,
			nativeResumeFallback: false,
		}),
	);
	expect(readRunnerSendJournal(f.input)).toEqual({ _tag: "Unreadable" });
});
