import { createHash } from "node:crypto";
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
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, expect } from "vitest";
import { sendToken } from "../../../src/lib/provider/runner/runner-protocol.js";
import {
	RunnerSendJournal,
	readRunnerSendJournal,
} from "../../../src/lib/provider/runner/runner-send-journal.js";

const roots: string[] = [];
const token = sendToken("hold", "c", 1);
const fixture = () => {
	const directory = mkdtempSync(join(tmpdir(), "send-journal-read-"));
	roots.push(directory);
	const input = {
		directory,
		sessionId: "s",
		driverKind: "claude",
		token,
		commandId: "c",
	};
	const sends = join(directory, "sends", "s");
	mkdirSync(sends, { recursive: true });
	const key = createHash("sha256")
		.update(JSON.stringify(["claude", "s", token]))
		.digest("hex");
	return { input, sends, filename: join(sends, `${key}.json`) };
};
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
const rejected = {
	status: "completed" as const,
	cost: 0,
	tokens: { input: 0, output: 0 },
	durationMs: 0,
	nativeResumeRejected: true,
	providerStateUpdates: [],
};

it("distinguishes an absent transmission from a corrupt or unreadable journal", () => {
	const f = fixture();
	expect(readRunnerSendJournal(f.input)).toEqual({ _tag: "Absent" });
	writeFileSync(f.filename, "{");
	expect(readRunnerSendJournal(f.input)).toEqual({ _tag: "Unreadable" });
	rmSync(f.sends, { recursive: true });
	writeFileSync(f.sends, "not a directory");
	expect(readRunnerSendJournal(f.input)).toEqual({ _tag: "Unreadable" });
});

it("answers a retained send by its token alone", () => {
	const f = fixture();
	const record = { token, runnerPid: 123, startedAt: 1 };
	writeFileSync(f.filename, JSON.stringify(record));
	expect(readRunnerSendJournal(f.input)).toEqual({
		_tag: "Present",
		state: { token, status: "uncertain" },
	});
	writeFileSync(
		f.filename,
		JSON.stringify({ ...record, completedAt: 2, result: rejected }),
	);
	expect(readRunnerSendJournal(f.input)).toEqual({
		_tag: "Present",
		state: { token, status: "finished", result: rejected },
	});
});

it("rejects a well-formed record for a different token as unreadable", () => {
	const f = fixture();
	writeFileSync(
		f.filename,
		JSON.stringify({
			token: sendToken("hold", "c", 2),
			runnerPid: 123,
			startedAt: 1,
		}),
	);
	expect(readRunnerSendJournal(f.input)).toEqual({ _tag: "Unreadable" });
});

it("reads an older build's attempt-keyed record of the same command as unreadable, never absent", () => {
	const f = fixture();
	const legacy = (commandId: string) =>
		writeFileSync(
			join(
				f.sends,
				`${createHash("sha256")
					.update(JSON.stringify(["claude", "s", commandId, 0, false]))
					.digest("hex")}.json`,
			),
			JSON.stringify({
				commandId,
				attempt: 0,
				runnerPid: 123,
				startedAt: 1,
				nativeResumeFallback: false,
			}),
		);
	legacy("other");
	expect(readRunnerSendJournal(f.input)).toEqual({ _tag: "Absent" });
	legacy("c");
	expect(readRunnerSendJournal(f.input)).toEqual({ _tag: "Unreadable" });
	// The new host answers only tokens; the older record fences nothing there.
	const host = new RunnerSendJournal(f.input.directory, "s", "claude", {
		allowOpaqueFences: true,
	});
	expect(host.tokens).toEqual([]);
});

it.effect(
	"runs a fresh transmission after a rejected resume under its own token, with no fallback marker",
	() =>
		Effect.gen(function* () {
			const f = fixture();
			const journal = new RunnerSendJournal(f.input.directory, "s", "claude");
			const fresh = sendToken("hold", "c", 2);
			expect(yield* journal.execute(token, Effect.succeed(rejected))).toEqual(
				rejected,
			);
			let ran = false;
			yield* journal.execute(
				fresh,
				Effect.sync(() => {
					ran = true;
					return undefined;
				}),
			);
			expect(ran).toBe(true);
			expect(journal.answers.map((answer) => answer.token).sort()).toEqual([
				token,
				fresh,
			]);
			for (const name of readdirSync(f.sends))
				expect(
					Object.keys(JSON.parse(readFileSync(join(f.sends, name), "utf8"))),
				).not.toContain("nativeResumeFallback");
		}),
);

it.effect("acknowledges exactly the listed tokens", () =>
	Effect.gen(function* () {
		const f = fixture();
		const journal = new RunnerSendJournal(f.input.directory, "s", "claude");
		const later = sendToken("hold", "c", 2);
		yield* journal.execute(token, Effect.succeed(undefined));
		yield* journal.execute(later, Effect.succeed(undefined));
		expect(journal.acknowledge([later]).map((record) => record.token)).toEqual([
			later,
		]);
		expect(journal.tokens).toEqual([token]);
		expect(readRunnerSendJournal(f.input)._tag).toBe("Present");
	}),
);
