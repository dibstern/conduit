// OpenCode pollers keyed by demand end to end (82tn.12), over the process harness and its managed
// fake OpenCode with the instance stream silenced, so only the pollers can see progress. How it
// could fail (the lane's catalogue numbers):
// 1. two tabs on one session make two message pollers;
// 2. the last tab leaves, the message poller keeps reading;
// 3. a busy session nobody views starts a message poller;
// 4. the last tab leaves mid-turn and the run end is never seen;
// 5, 14. the completion never reaches a tab on another project;
// 13. the done is notified twice.
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../src/lib/contracts/account.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const instanceId = MANAGED_OPENCODE_ACCOUNT_ID;
// The reconnect grace (PollerDemand) plus slack for one poll interval.
const AFTER_GRACE_MS = 7_000;

describe("OpenCode pollers keyed by demand", () => {
	let harness: ProcessHarness | undefined;
	const proofs: Record<string, unknown>[] = [];
	afterEach(async () => {
		await harness?.dispose();
		harness = undefined;
	});
	afterAll(() => {
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/82tn-12-poller-demand.json",
			JSON.stringify({ ticket: "conduit-test-82tn.12", proofs }, null, 2),
		);
	});

	const start = async () => {
		harness = ProcessHarness.create({
			managedOpenCode: true,
			managedOpenCodeId: instanceId,
			autoStartOpenCode: true,
			managedOpenCodeStopGraceMs: 100,
		});
		// Reduce every half second, so a stale stream starts a poller within one window.
		await harness.restart({
			serviceEnvironment: { CONDUIT_STATUS_RECONCILIATION_INTERVAL_MS: "500" },
		});
		return harness;
	};
	const reads = (fixture: ProcessHarness, path: string, since: number) =>
		fixture
			.opencodeRequests()
			.filter(
				(request) =>
					request.method === "GET" &&
					request.at >= since &&
					new URL(request.url, "http://fake").pathname === path,
			).length;
	const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
	const runEnds = (fixture: ProcessHarness, sessionId: string) => {
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			return db
				.prepare(
					"SELECT json_extract(entry_json, '$.reason.tag') AS reason FROM run_ledger_entries WHERE session_id = ? AND json_extract(entry_json, '$.kind') = 'end' ORDER BY entry_seq",
				)
				.all(sessionId) as { reason: string }[];
		} finally {
			db.close();
		}
	};
	const runStatus = (fixture: ProcessHarness, sessionId: string) => {
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			return (
				db
					.prepare(
						"SELECT status FROM provider_runs WHERE session_id = ? ORDER BY rowid DESC LIMIT 1",
					)
					.get(sessionId) as { status: string } | undefined
			)?.status;
		} finally {
			db.close();
		}
	};
	/** Sends a held turn and waits until the ledger's run is running. */
	const hold = async (
		fixture: ProcessHarness,
		browser: ProcessBrowser,
		sessionId: string,
	) => {
		const held = join(fixture.configDir, "fake-opencode-hold-turn");
		const prompts = fixture
			.opencodeRequestBodies()
			.filter(({ path }) => path === `/session/${sessionId}/prompt_async`);
		writeFileSync(held, "hold");
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId: randomUUID(),
				delivery: "queue",
				text: "held",
			}),
		);
		let messageId: string | undefined;
		await vi.waitFor(
			() => {
				messageId = (
					JSON.parse(
						fixture
							.opencodeRequestBodies()
							.filter(
								({ path }) => path === `/session/${sessionId}/prompt_async`,
							)
							.at(prompts.length)?.body ?? "{}",
					) as { messageID?: string }
				).messageID;
				expect(messageId).toBeTruthy();
			},
			{ timeout: 15_000 },
		);
		unlinkSync(held);
		await fixture.emitOpenCodeEvent({
			directory: realpathSync(fixture.projectDir),
			payload: {
				id: randomUUID(),
				type: "message.updated",
				properties: {
					info: {
						id: messageId,
						sessionID: sessionId,
						role: "user",
						time: { created: Date.now() },
					},
				},
			},
		});
		await vi.waitFor(
			() => expect(runStatus(fixture, sessionId)).toBe("running"),
			{ timeout: 15_000 },
		);
	};
	/** Grows one assistant message every 400 ms, so a running poller never goes idle by itself. */
	const ticker = (fixture: ProcessHarness, sessionId: string) => {
		const file = join(fixture.configDir, "fake-opencode-history.json");
		const id = `msg_${randomUUID()}`;
		const created = Date.now();
		let ticks = 0;
		const write = () => {
			const history = existsSync(file)
				? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)
				: {};
			history[sessionId] = [
				{
					info: {
						id,
						sessionID: sessionId,
						role: "assistant",
						time: { created },
						parentID: `${id}_parent`,
						modelID: "fake-model",
						providerID: "fake",
						mode: "build",
						path: { cwd: "/", root: "/" },
						cost: 0,
						tokens: {
							input: 1,
							output: ticks,
							reasoning: 0,
							cache: { read: 0, write: 0 },
						},
					},
					parts: [
						{
							id: `prt_${id}`,
							messageID: id,
							sessionID: sessionId,
							type: "text",
							// The poller sees content only when the text grows.
							text: "tick ".repeat(++ticks),
						},
					],
				},
			];
			writeFileSync(`${file}.next`, JSON.stringify(history));
			renameSync(`${file}.next`, file);
		};
		write();
		const timer = setInterval(write, 400);
		return () => clearInterval(timer);
	};
	const busy = (fixture: ProcessHarness, sessionId: string) =>
		fixture.setOpenCodeStatus(fixture.projectDir, sessionId, { type: "busy" });
	const idle = (fixture: ProcessHarness, sessionId: string) =>
		fixture.setOpenCodeStatus(fixture.projectDir, sessionId, { type: "idle" });
	const addProject = async (fixture: ProcessHarness, directory: string) => {
		mkdirSync(directory, { recursive: true });
		const result = await sendRpcRequest(join(fixture.configDir, "relay.sock"), {
			_tag: "SaveProject",
			folders: [directory],
		});
		return result.savedSlug as string;
	};

	it("a busy session no tab views completes, and a tab on another project gets one done alert", async () => {
		const fixture = await start();
		const author = await fixture.connect(
			undefined,
			undefined,
			"process-test",
			false,
		);
		const sessionId = await author.createSession(
			"Background",
			instanceId,
			"opencode",
		);
		await hold(fixture, author, sessionId);
		await busy(fixture, sessionId);
		const slugB = await addProject(fixture, join(fixture.root, "project-b"));
		const elsewhere = await fixture.connect(undefined, undefined, slugB, false);
		// A tab on the session's own project that views something else.
		const nearby = await fixture.connect(
			undefined,
			undefined,
			"process-test",
			false,
		);
		await Promise.all([elsewhere.followAlerts(), nearby.followAlerts()]);
		await author.close();
		await pause(AFTER_GRACE_MS);
		const stopTicker = ticker(fixture, sessionId);
		const silenced = Date.now();
		// The turn's final step never reaches the stream; only its run end can name it.
		await fixture.closeOpenCodeStreams({ silenceReconnect: true });
		await pause(AFTER_GRACE_MS);
		const unviewed = reads(fixture, `/session/${sessionId}/message`, silenced);
		stopTicker();
		await idle(fixture, sessionId);
		await vi.waitFor(
			() => expect(runEnds(fixture, sessionId)).toHaveLength(1),
			{
				timeout: 15_000,
			},
		);
		const alertsOf = (browser: ProcessBrowser) =>
			browser.frames
				.map(({ message }) => message)
				.filter(
					(message) =>
						message["type"] === "alert" && message["sessionId"] === sessionId,
				)
				.map((message) => ({
					kind: message["kind"],
					alertId: message["alertId"],
				}));
		await vi.waitFor(
			() => {
				expect(alertsOf(nearby)).toHaveLength(1);
				expect(alertsOf(elsewhere)).toHaveLength(1);
			},
			{ timeout: 15_000 },
		);
		// Long enough for a second done (the stream's idle, the status loop's) to land.
		await pause(3_000);
		proofs.push({
			test: "background",
			messageReadsUnviewed: unviewed,
			runEnds: runEnds(fixture, sessionId),
			alertsOnProject: alertsOf(nearby),
			alertsOnOtherProject: alertsOf(elsewhere),
		});
		expect(unviewed).toBe(0);
		expect(alertsOf(nearby)).toEqual([
			{ kind: "done", alertId: expect.any(String) },
		]);
		expect(alertsOf(elsewhere)).toEqual(alertsOf(nearby));
	}, 120_000);
});
