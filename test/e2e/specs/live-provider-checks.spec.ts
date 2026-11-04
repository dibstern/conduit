// Live checks of provider behaviour the Run Ledger relies on (82tn.32.2.9).
// Each test drives a real provider CLI with the user's existing login, using
// the probe scripts in ../live-probes, and asserts what the provider does.
// Opt in with CONDUIT_LIVE_PROVIDER_CHECKS=1; Cursor also needs CURSOR_API_KEY.
// Models: CURSOR_LIVE_MODEL (default grok-4.5), CODEX_LIVE_MODEL (default gpt-5.6-luna).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

type Note = { t: number; kind: string; data: Record<string, unknown> | null };

const enabled = process.env["CONDUIT_LIVE_PROVIDER_CHECKS"] === "1";
const probes = resolve(import.meta.dirname, "../live-probes");
const worktree = resolve(import.meta.dirname, "../../..");
const out = mkdtempSync(join(tmpdir(), "conduit-live-provider-checks-"));

const probe = (script: string, args: string[]): Note[] => {
	const file = join(
		out,
		`${script}-${args.join("-").replace(/\W+/g, "_")}.json`,
	);
	execFileSync(
		process.execPath,
		[join(probes, script), ...args.map((a) => (a === "$OUT" ? file : a))],
		{
			stdio: ["ignore", "ignore", "inherit"],
			timeout: 180_000,
		},
	);
	test.info().annotations.push({ type: "evidence", description: file });
	return JSON.parse(readFileSync(file, "utf8")) as Note[];
};
const find = (notes: Note[], kind: string) =>
	notes.find((n) => n.kind === kind)?.data;
const frames = (notes: Note[]) =>
	notes.filter((n) => n.kind === "frame").map((n) => n.data ?? {});

test.describe("Live provider checks", () => {
	test.skip(!enabled, "set CONDUIT_LIVE_PROVIDER_CHECKS=1 to run");
	// test-waits-allow timeout-override: each test drives a real provider for up to a few minutes.
	test.setTimeout(240_000);

	test("Claude: session state frames are opt-in; an interrupt names the queued inputs and they run next", () => {
		const quiet = frames(
			probe("claude-probe.mjs", [worktree, "$OUT", "0", "interrupt"]),
		);
		expect(quiet.some((f) => f["subtype"] === "session_state_changed")).toBe(
			false,
		);

		const notes = probe("claude-probe.mjs", [
			worktree,
			"$OUT",
			"1",
			"interrupt",
		]);
		expect(
			frames(notes).some((f) => f["subtype"] === "session_state_changed"),
		).toBe(true);
		expect(find(notes, "interrupt_receipt")).toEqual({
			still_queued: ["ub", "uc"],
		});
		const results = frames(notes).filter((f) => f["type"] === "result");
		expect(results[0]?.["user_message_uuids"]).toEqual(["ua"]);
		expect(results.at(-1)?.["user_message_uuids"]).toEqual(["ub", "uc"]);
	});

	test("Claude: a wake turn's result names no input", () => {
		const results = frames(
			probe("claude-probe.mjs", [worktree, "$OUT", "1", "wake"]),
		).filter((f) => f["type"] === "result");
		expect(results.length).toBeGreaterThanOrEqual(2);
		expect(results.at(-1)?.["user_message_uuid"]).toBeUndefined();
		expect(results.at(-1)?.["user_message_uuids"]).toBeUndefined();
	});

	test.describe("Cursor", () => {
		test.skip(!process.env["CURSOR_API_KEY"], "needs CURSOR_API_KEY");
		const model = process.env["CURSOR_LIVE_MODEL"] ?? "grok-4.5";

		test("a steer resolves before wait() settles, and one after it is declined", () => {
			const notes = probe("cursor-probe.mjs", [
				worktree,
				"$OUT",
				"steer",
				model,
			]);
			const at = (kind: string) =>
				notes.find((n) => n.kind === kind)?.t ?? Number.NaN;
			expect(at("steer1_outcome")).toBeLessThan(at("wait_settled"));
			expect(find(notes, "steer2_outcome")?.["outcome"]).toBe(
				"revert_to_followup",
			);
			expect(find(notes, "after")?.["activeRunId"]).toBeNull();
		});

		test("killing the SDK host's process group does not stop a running shell command", () => {
			const notes = probe("cursor-kill.mjs", [
				worktree,
				"$OUT",
				model,
				"group",
			]);
			expect(find(notes, "after_kill_15s")?.["markerExists"]).toBe(true);
		});
	});

	test("Codex: turn/start beside a goal successor", () => {
		const notes = probe("codex-probe.mjs", [
			"$OUT",
			process.env["CODEX_LIVE_MODEL"] ?? "gpt-5.6-luna",
		]);
		const turnFor = (client: string) => {
			const id = notes.find(
				(n) =>
					n.kind === "request" &&
					(n.data?.["params"] as { clientUserMessageId?: string } | undefined)
						?.clientUserMessageId === client,
			)?.data?.["id"];
			const response = notes.find(
				(n) => n.kind === "response" && n.data?.["id"] === id,
			)?.data;
			return (response?.["result"] as { turn?: { id: string } } | undefined)
				?.turn?.id;
		};
		const native = notes.find(
			(n) => n.kind === "probe" && n.data?.["nativeTurn"],
		)?.data?.["nativeTurn"];
		// While the successor is only pending, the start opens its own turn.
		expect(turnFor("u-pong")).toBeTruthy();
		expect(turnFor("u-pong")).not.toBe(native);
		// While a server-started turn runs, the start joins that turn.
		expect(native).toBeTruthy();
		expect(turnFor("u-ping")).toBe(native);
	});

	test("OpenCode: prompt_async and abort still run after the client drops the request", () => {
		const notes = probe("opencode-probe.mjs", ["$OUT"]);
		const early = notes
			.filter((n) => n.kind === "early_probe_a")
			.map((n) => n.data);
		test.info().annotations.push({
			type: "early probes",
			description: JSON.stringify(early),
		});
		type Msg = { role?: string; error?: string; finished?: boolean };
		const msgs = (kind: string) =>
			notes
				.filter((n) => n.kind === kind)
				.flatMap((n) => (n.data?.["msgs"] ?? []) as Msg[]);
		expect(
			msgs("poll_a").some((m) => m.role === "assistant" && m.finished),
		).toBe(true);
		expect(msgs("poll_b").some((m) => m.error === "MessageAbortedError")).toBe(
			true,
		);
	});
});
