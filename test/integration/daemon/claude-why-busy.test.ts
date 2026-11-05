// Why a session is busy (82tn.56): the view lists exactly Session Activity's reasons plus the open
// tool calls, over the isolated process harness and the recorded background-shell-turn trace. Held
// before trace line 55 the user turn's Bash call is open (tool_use at 51, its result at 57); before 84
// the shell runs beside the turn; before 85 only the shell runs; before 153 Claude's wake turn runs.
// How it could fail (lane-56 audit):
// 1. a reason Session Activity does not hold (row status, tool rows);
// 2. a reason it holds is missing (input Run, wake Run, background work);
// 3, 5. tool rows open the view, or a finished tool still lists as open;
// 6. a queued input shows with no Run, or is not counted under the Run;
// 9. the wake Run reads as the user's turn, or loses its task;
// 11. the view keeps its reasons once the session goes idle.

import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type WhyBusyRow, whyBusy } from "../../../src/lib/session/why-busy.js";
import type { HistoryMessage } from "../../../src/lib/shared-types.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const PROOF = "test-results/82tn-56-why-busy.json";

/** The latest session_row each feed sent for the session. */
const latest = (browser: ProcessBrowser, sessionId: string) => {
	let feed = "";
	const last: Record<string, Record<string, unknown>> = {};
	for (const { message } of browser.frames) {
		if (message["type"] === "shell" || message["type"] === "family")
			feed = String(message["type"]);
		if (message["type"] === "session_row" && message["id"] === sessionId)
			last[feed] = message;
	}
	return last;
};

/** The session's pending inputs as its detail stream last left them: the tray. */
const pendingInputs = (browser: ProcessBrowser, sessionId: string) => {
	const inputs = new Map<string, unknown>();
	for (const { message } of browser.frames) {
		if (
			message["type"] !== "session_detail" ||
			message["sessionId"] !== sessionId
		)
			continue;
		if (message["_tag"] === "snapshot") inputs.clear();
		// A removed input is named `input:<inputId>` (transcript.svelte.ts applies the same).
		if (message["_tag"] === "remove")
			inputs.delete(String(message["id"]).replace(/^input:/, ""));
		const items =
			message["_tag"] === "snapshot"
				? (message["rows"] as readonly Record<string, unknown>[])
				: message["_tag"] === "upsert"
					? [message["item"] as Record<string, unknown>]
					: [];
		for (const item of items)
			if (item["_tag"] === "pendingInput") {
				const input = item["input"] as { inputId: string };
				inputs.set(input.inputId, input);
			}
	}
	return [...inputs.values()];
};

describe("Why busy over a Claude background shell and its wake", () => {
	let harness: ProcessHarness | undefined;
	const proof: Record<string, unknown> = {};

	afterEach(async ({ task }) => {
		try {
			await harness?.dispose();
			harness?.assertNoRunners();
		} finally {
			proof[task.name] = {
				...(proof[task.name] as object),
				outcome: task.result?.state === "pass" ? "passed" : "failed",
			};
			mkdirSync("test-results", { recursive: true });
			writeFileSync(PROOF, `${JSON.stringify(proof, null, 2)}\n`);
			harness = undefined;
		}
	});

	it("lists Session Activity's reasons and the open tool calls at every step", async () => {
		const name =
			"lists Session Activity's reasons and the open tool calls at every step";
		const fixture = await ProcessHarness.start({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			claudeReplay: { turns: ["background-shell-turn"] },
		});
		harness = fixture;
		const browser = await fixture.connect();
		await browser.followSessions();
		const sessionId = await browser.createSession("Why busy");
		await browser.followFamily(sessionId);
		const hold = join(fixture.root, "claude-replay-hold");
		const reached = () =>
			existsSync(`${hold}.reached`)
				? readFileSync(`${hold}.reached`, "utf8").split("\n").filter(Boolean)
						.length
				: 0;
		const steps: Record<string, unknown>[] = [];
		proof[name] = { sessionId, steps };
		let holds = 0;
		const holdAt = async (message: number, start?: () => void) => {
			holds += 1;
			writeFileSync(hold, JSON.stringify({ turn: 1, message, id: holds }));
			start?.();
			// test-waits-allow polling: the held replay line reports only through this file.
			await vi.waitFor(() => expect(reached()).toBe(holds), {
				timeout: 10_000,
			});
		};
		/** What the view reads on each feed, beside the row's own Session Activity. */
		const read = async () => {
			const rows = latest(browser, sessionId);
			const detail = {
				pending: pendingInputs(browser, sessionId),
				messages: (await browser.history(sessionId)) as HistoryMessage[],
			};
			return {
				activity: rows["family"]?.["activity"] ?? null,
				attention: rows["family"]?.["attention"] ?? null,
				shell: whyBusy((rows["shell"] ?? {}) as WhyBusyRow, detail) ?? null,
				family: whyBusy((rows["family"] ?? {}) as WhyBusyRow, detail) ?? null,
			};
		};
		/** Records what the view reads once both feeds settle on `expected`. */
		const step = async (label: string, expected: unknown, timeout = 5_000) => {
			const record: Record<string, unknown> = { label, expected };
			steps.push(record);
			// Every step is recorded before any is judged, so a red run shows them all.
			// test-waits-allow polling: rows are coalesced up to a second after the change.
			await vi
				.waitFor(
					async () => {
						Object.assign(record, await read());
						expect(record["shell"]).toEqual(expected);
						expect(record["family"]).toEqual(expected);
					},
					{ timeout },
				)
				.catch(() => {});
		};
		const bash = {
			callId: "toolu_01WQY3MCEqQ1GJBXtwPAicoj",
			tool: "Bash",
			since: expect.any(Number),
		};
		const shell = {
			kind: "background",
			activity: "work",
			tasks: [
				{
					label: expect.stringContaining("sleep 8"),
					since: expect.any(Number),
				},
			],
			servers: [],
		};

		await holdAt(55, () => {
			browser.send(sessionId, "Run sleep 8 in the background").catch(() => {});
		});
		const queuedId = randomUUID();
		const queued = await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId: queuedId,
				delivery: "queue",
				text: "and then the logs",
			}),
		);
		expect(queued.ok).toBe(true);
		await step("the user turn's Bash call open, one input queued", {
			reasons: [{ kind: "run", origin: "input", queued: 1 }],
			tools: [bash],
		});
		await Effect.runPromise(
			browser.rpc["input.cancel"]({ sessionId, inputId: queuedId }),
		);
		await step("the queued input cancelled", {
			reasons: [{ kind: "run", origin: "input", queued: 0 }],
			tools: [bash],
		});
		await holdAt(84);
		await step("the shell started beside the user turn, the Bash call done", {
			reasons: [{ kind: "run", origin: "input", queued: 0 }, shell],
			tools: [],
		});
		await holdAt(85);
		await step("after the turn's result, only the shell running", {
			reasons: [shell],
			tools: [],
		});
		await holdAt(153);
		await step("Claude's wake turn, woken by the shell", {
			reasons: [{ kind: "run", origin: "wake", task: "sleep 8", queued: 0 }],
			tools: [],
		});
		rmSync(hold);
		// The wake turn replays its last 65 lines once released, then the row settles idle.
		await step("after the wake", null, 15_000);

		for (const { label, expected, shell, family } of steps)
			expect({ shell, family }, String(label)).toEqual({
				shell: expected,
				family: expected,
			});
	});
});
