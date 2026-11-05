import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// Failure modes (audit.md, lane f02e9-12): a running session is evicted (2);
// the newest settled session goes before the oldest, or eviction overshoots
// 90% of the budget (14); an evicted turn diff loses its files or counts, or
// is not marked Pruned (Pruned listing); a pruned session's new turn does not
// capture, or reads as Pruned (9); unsettling brings content back (10);
// eviction deletes session events (13); nothing eligible evicts something or
// raises no warning naming the largest sessions (12); a store left behind by
// a crash after the eviction event survives a restart (3, 4), and recovery
// deletes a store captured after the eviction (11); a second pass at the same
// budget evicts more (5); an unsettled, shared-folder-only session goes (6,
// 15); disk use is missing from diagnostics.
const GIT_KEYS = [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
];
const gitEnv = { ...process.env };
for (const key of GIT_KEYS) delete gitEnv[key];
const git = (directory: string, ...args: string[]) =>
	execFileSync("git", ["-C", directory, ...args], {
		env: gitEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

const bytesOf = (path: string): number => {
	if (!existsSync(path)) return 0;
	const stat = statSync(path);
	return stat.isDirectory()
		? readdirSync(path).reduce(
				(sum, name) => sum + bytesOf(join(path, name)),
				0,
			)
		: stat.size;
};

describe("Folder Timeline eviction through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	const evidence: Record<string, unknown> = {};

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		evidence["errors"] =
			task.result?.errors?.map(({ message }) => message) ?? [];
		if (task.result?.errors?.length) evidence["logs"] = fixture.logTail;
		const root = realpathSync(fixture.root);
		writeFileSync(join(fixture.root, "claude-replay-release"), "release\n");
		try {
			await fixture.dispose();
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/f02e9-12-eviction.json",
				`${JSON.stringify(evidence, null, 2).replaceAll(root, "<root>").replaceAll(fixture.root, "<root>")}\n`,
			);
			harness = undefined;
			vi.unstubAllEnvs();
		}
	});

	it("evicts the oldest settled sessions to 90% of the budget, keeps the running one, and lists pruned turns", async () => {
		for (const key of GIT_KEYS) vi.stubEnv(key, undefined);
		harness = ProcessHarness.create({
			claudeReplay: {
				turns: Array.from({ length: 8 }, () => "pong-thinking-text-turn"),
				delayMs: 0,
				holdBeforeResult: true,
			},
		});
		const fixture = harness;
		const repo = fixture.projectDir;
		const release = join(fixture.root, "claude-replay-release");
		mkdirSync(repo, { recursive: true });
		git(repo, "init", "-q", "-b", "main");
		writeFileSync(join(repo, "tracked.txt"), "one\ntwo\nthree\n");
		git(repo, "add", ".");
		git(
			repo,
			"-c",
			"user.name=Eviction test",
			"-c",
			"user.email=evict@example.test",
			"commit",
			"-q",
			"-m",
			"Initial",
		);
		await fixture.restart();
		const socket = join(fixture.configDir, "relay.sock");
		await sendRpcRequest(socket, {
			_tag: "SaveProject",
			slug: "process-test",
			folders: [repo],
		});
		const sessionsDir = join(fixture.configDir, "folder-timeline", "sessions");
		const storeOf = (sessionId: string) =>
			join(
				sessionsDir,
				`${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}.git`,
			);
		const query = <Row>(statement: string, ...params: string[]) => {
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				return db.prepare(statement).all(...params) as Row[];
			} finally {
				db.close();
			}
		};
		const turnsOf = (sessionId: string) =>
			query<{ id: string }>(
				"SELECT id FROM turns WHERE session_id = ? ORDER BY requested_at",
				sessionId,
			).map(({ id }) => id);
		const evicted = () =>
			query<{ session_id: string; data: string }>(
				"SELECT session_id, data FROM events WHERE type = 'folder_timeline.evicted' ORDER BY sequence",
			).map(({ session_id, data }) => ({
				sessionId: session_id,
				reason: (JSON.parse(data) as { reason: string }).reason,
			}));
		// The settled sessions' own events; the running one keeps streaming.
		const eventCount = (sessionIds: readonly string[]) =>
			sessionIds.map(
				(sessionId) =>
					query<{ count: number }>(
						"SELECT COUNT(*) AS count FROM events WHERE session_id = ? AND type != 'folder_timeline.evicted'",
						sessionId,
					)[0]?.count,
			);
		const list = (sessionId: string, turnId: string) =>
			sendRpcRequest(socket, {
				_tag: "SessionDiffList",
				sessionId,
				scope: { kind: "turn", turnId },
			});
		const setBudget = (budgetBytes: number, alertBytes = budgetBytes) =>
			sendRpcRequest(socket, {
				_tag: "SetSnapshotBudgetSetting",
				budgetBytes,
				alertBytes,
			});

		const browser = await fixture.connect();
		const started = (sessionId: string, cursor: number) =>
			browser.waitFor(
				(frame) =>
					frame["type"] === "transcript_message" &&
					frame["sessionId"] === sessionId &&
					frame["role"] === "assistant",
				cursor,
			);
		/** One turn that writes `name` (about 150 KB) and edits tracked.txt while its run is open. */
		const editingTurn = async (sessionId: string, name: string) => {
			evidence["step"] = `turn ${name}`;
			const cursor = browser.frames.length;
			const sending = browser.send(sessionId, `Write ${name}.`);
			void sending.catch(() => {});
			await started(sessionId, cursor);
			writeFileSync(
				join(repo, name),
				randomBytes(110_000)
					.toString("base64")
					.replace(/(.{76})/g, "$1\n"),
			);
			writeFileSync(join(repo, "tracked.txt"), `one\n${name}\nthree\n`);
			// Wrapped: an async function returning the promise would wait for it.
			return { sending };
		};

		const names = ["oldest", "middle", "newest"] as const;
		const settled: Record<(typeof names)[number], string> = {
			oldest: "",
			middle: "",
			newest: "",
		};
		for (const name of names) {
			const sessionId = await browser.createSession(`Settled ${name}`);
			settled[name] = sessionId;
			const { sending } = await editingTurn(sessionId, `${name}.txt`);
			writeFileSync(release, "release\n");
			await sending;
			rmSync(release, { force: true });
			// Listing a turn waits for its run's capture.
			await list(sessionId, turnsOf(sessionId)[0] ?? "");
			expect(existsSync(storeOf(sessionId))).toBe(true);
			await browser.setSettled(sessionId, true);
		}
		// Settled in age order, a whole turn apart, so eligibility follows it.
		const settledTimes = names.map(
			(name) =>
				query<{ settled_at: number }>(
					"SELECT settled_at FROM sessions WHERE id = ?",
					settled[name],
				)[0]?.settled_at ?? 0,
		);
		expect(settledTimes).toEqual(
			[...new Set(settledTimes)].sort((a, b) => a - b),
		);
		const running = await browser.createSession("Still running");
		const { sending: runningSend } = await editingTurn(running, "running.txt");

		const sizes = Object.fromEntries(
			names.map((name) => [name, bytesOf(storeOf(settled[name]))]),
		);
		evidence["storeBytes"] = sizes;
		const total = names.reduce((sum, name) => sum + (sizes[name] ?? 0), 0);
		// Disk use also counts the whole-folder checkpoints, which the newest
		// session's checkpoint mostly shares with the others.
		const kept =
			((await sendRpcRequest(socket, { _tag: "GetStatus" })).snapshotBytes ??
				0) - bytesOf(sessionsDir);
		evidence["keptBefore"] = kept;
		expect(kept).toBeGreaterThan(sizes["newest"] ?? 0);
		// 90% of this budget fits one store, not two: the two oldest go.
		const budget = Math.floor(
			((sizes["newest"] ?? 0) + (sizes["middle"] ?? 0) * 0.5 + kept) / 0.9,
		);
		evidence["budget"] = budget;
		evidence["totalBefore"] = total;
		const pruned = turnsOf(settled.oldest)[0] ?? "";
		const before = await list(settled.oldest, pruned);
		evidence["listingBefore"] = before;
		const preserved = join(fixture.root, "preserved-middle.git");
		cpSync(storeOf(settled.middle), preserved, { recursive: true });
		const eventsBefore = eventCount(Object.values(settled));

		await setBudget(budget);
		// The reply follows the pass. A second pass at the same budget finds
		// nothing more to do.
		await setBudget(budget);
		evidence["evicted"] = evicted();
		expect(evicted()).toEqual([
			{ sessionId: settled.oldest, reason: "settled" },
			{ sessionId: settled.middle, reason: "settled" },
		]);
		expect(existsSync(storeOf(settled.oldest))).toBe(false);
		expect(existsSync(storeOf(settled.middle))).toBe(false);
		expect(existsSync(storeOf(settled.newest))).toBe(true);
		const remaining = bytesOf(sessionsDir);
		evidence["bytesAfter"] = remaining;
		expect(remaining).toBeLessThanOrEqual(budget * 0.9);
		expect(eventCount(Object.values(settled))).toEqual(eventsBefore);

		const status = await sendRpcRequest(socket, { _tag: "GetStatus" });
		evidence["statusSnapshotBytes"] = status.snapshotBytes;
		expect(status.snapshotBytes).toBeGreaterThan(remaining);
		expect(status.snapshotBytes).toBeLessThanOrEqual(budget * 0.9);

		// The pruned turn keeps its files and counts, marked Pruned.
		const after = await list(settled.oldest, pruned);
		evidence["prunedListing"] = after;
		expect(after.pruned).toBe(true);
		const summary = (listing: typeof after) =>
			listing.folders.flatMap((folder) =>
				"files" in folder
					? folder.files.map((file) => ({
							path: file.path,
							status: file.status,
							insertions: "insertions" in file ? file.insertions : undefined,
							deletions: "deletions" in file ? file.deletions : undefined,
						}))
					: [],
			);
		expect(summary(after)).toEqual(summary(before));
		expect(
			after.folders.flatMap((folder) =>
				"files" in folder ? folder.files.map(({ tier }) => tier) : [],
			),
		).toEqual(["pruned", "pruned"]);

		// Unsettling does not restore content.
		await browser.setSettled(settled.middle, false);
		const middleTurn = turnsOf(settled.middle)[0] ?? "";
		expect((await list(settled.middle, middleTurn)).pruned).toBe(true);

		// A pruned session's next turn captures normally.
		const { sending: again } = await editingTurn(
			settled.oldest,
			"oldest-again.txt",
		);
		writeFileSync(release, "release\n");
		await Promise.all([again, runningSend]);
		await list(running, turnsOf(running)[0] ?? "");
		const [, next = ""] = turnsOf(settled.oldest);
		const fresh = await list(settled.oldest, next);
		expect(existsSync(storeOf(settled.oldest))).toBe(true);
		evidence["newTurnListing"] = fresh;
		expect(fresh.pruned).toBeUndefined();
		expect(summary(fresh).map(({ path }) => path)).toEqual([
			"oldest-again.txt",
			"tracked.txt",
		]);
		expect((await list(settled.oldest, pruned)).pruned).toBe(true);
		// The running session was never a candidate.
		expect(evicted().map(({ sessionId }) => sessionId)).not.toContain(running);
		expect(existsSync(storeOf(running))).toBe(true);

		// Nothing eligible: the unsettled stores stay and the warning names them.
		await browser.setSettled(settled.oldest, false);
		await browser.followAlerts();
		const cursor = browser.frames.length;
		const settledCount = evicted().length;
		await setBudget(1, 1);
		expect(evicted().length).toBe(settledCount + 1);
		const alert = await browser.waitFor(
			(frame) => frame["type"] === "alert" && frame["kind"] === "warning",
			cursor,
		);
		evidence["alert"] = alert;
		expect(String(alert["message"])).toContain("Still running");
		expect(evicted().at(-1)).toEqual({
			sessionId: settled.newest,
			reason: "settled",
		});
		for (const sessionId of [running, settled.oldest])
			expect(existsSync(storeOf(sessionId))).toBe(true);

		// A store left by a crash after its eviction event goes on restart;
		// a store captured after its session's eviction stays.
		await setBudget(1024 * 1024 * 1024);
		await fixture.kill();
		cpSync(preserved, storeOf(settled.middle), { recursive: true });
		// Recovery runs while the daemon starts, before it answers.
		await fixture.restart();
		expect(existsSync(storeOf(settled.middle))).toBe(false);
		expect(existsSync(storeOf(settled.oldest))).toBe(true);
		evidence["recovered"] = true;
	});
});
