/*
 * 82tn.13 acceptance: browser audiences without attaching a project.
 * Failure catalogue (lane audit): 1-4, 6, 9, 13-15, 17, 18.
 * Tabs name what they want in each request; nothing attaches a project to the
 * connection. Approvals and ask alerts go to every tab, whatever project it
 * shows; a terminal's output goes only to tabs following that project's
 * terminals.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import {
	type ProcessBrowser,
	ProcessHarness,
	ptyEnvelope,
} from "../../helpers/process-harness.js";

const gitOverrides = [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
];
const gitEnv = { ...process.env };
for (const key of gitOverrides) delete gitEnv[key];

function seedRepository(directory: string): void {
	mkdirSync(directory, { recursive: true });
	for (const args of [
		["init", "-b", "main", directory],
		[
			"-C",
			directory,
			"-c",
			"user.name=Browser audiences test",
			"-c",
			"user.email=audiences@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"--allow-empty",
			"-m",
			"Fixture",
		],
	])
		execFileSync("git", args, { env: gitEnv, stdio: "pipe" });
}

const startup = { startupTimeoutMs: 120_000, runnerStartupTimeoutMs: 90_000 };

const card = (browser: ProcessBrowser, sessionId: string, cursor = 0) =>
	browser.waitFor(
		(message) =>
			(message["type"] === "permission_pending" ||
				message["type"] === "question_pending") &&
			message["sessionId"] === sessionId,
		cursor,
		60_000,
	);

const removed = (browser: ProcessBrowser, id: string, cursor = 0) =>
	browser.waitFor(
		(message) => message["type"] === "approval_removed" && message["id"] === id,
		cursor,
		60_000,
	);

const cards = (browser: ProcessBrowser, sessionId: string) =>
	browser.frames.filter(
		({ message }) =>
			(message["type"] === "permission_pending" ||
				message["type"] === "question_pending") &&
			message["sessionId"] === sessionId,
	).length;

const output = (browser: ProcessBrowser, ptyId: string, cursor = 0) =>
	browser.frames
		.slice(cursor)
		.map(({ message }) => {
			const envelope = ptyEnvelope(message);
			return envelope?._tag === "output" && envelope.ptyId === ptyId
				? envelope.data
				: "";
		})
		.join("");

/** Any terminal frame that names this PTY: its row, output or removal. */
const ptyFrames = (browser: ProcessBrowser, ptyId: string) =>
	browser.frames.filter(({ message }) => {
		const envelope = ptyEnvelope(message);
		if (envelope === undefined) return false;
		if (envelope._tag === "output") return envelope.ptyId === ptyId;
		if (envelope._tag === "upsert") return envelope.item.id === ptyId;
		if (envelope._tag === "remove") return envelope.id === ptyId;
		if (envelope._tag === "snapshot")
			return envelope.rows.some((row) => row.pty.id === ptyId);
		return false;
	}).length;

const waitForOutput = (
	browser: ProcessBrowser,
	ptyId: string,
	marker: string,
	cursor = 0,
) =>
	browser.waitFor(
		() => output(browser, ptyId, cursor).includes(marker),
		cursor,
		30_000,
	);

// The shell would echo the marker as typed; print it split so only the
// command's output can contain it whole.
const printMarker = (marker: string) =>
	`printf '%s%s\\n' '${marker.slice(0, 4)}' '${marker.slice(4)}'\n`;

describe("browser audiences without attaching a project (82tn.13)", () => {
	let harness: ProcessHarness | undefined;
	let evidence: Record<string, unknown> = {};

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const logs = fixture.logTail;
		try {
			await fixture.dispose();
		} finally {
			vi.unstubAllEnvs();
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				`test-results/82tn-13-${evidence["scenario"]}.json`,
				JSON.stringify(
					{
						bead: "conduit-test-82tn.13",
						result: task.result?.state,
						failures: task.result?.errors?.map(({ message }) => message),
						attachProjectInContract: WsRpcGroup.requests.has("AttachProject"),
						...evidence,
						...(task.result?.errors?.length ? { logs } : {}),
						cleanup: fixture.proof(),
						remainingRunnerPids: fixture.remainingRunnerPids(),
					},
					null,
					2,
				),
			);
			harness = undefined;
		}
	});

	/** Projects A (process-test) and B, with one session in each. */
	async function twoProjects(scenario: string, withSessions = true) {
		for (const key of gitOverrides) vi.stubEnv(key, undefined);
		evidence = { scenario };
		const fixture = ProcessHarness.create({
			runnerLifecycle: { idleTimeoutMs: null },
			logLevel: "info",
		});
		harness = fixture;
		const projectB = join(fixture.root, "project-b");
		seedRepository(fixture.projectDir);
		seedRepository(projectB);
		await fixture.restart(startup);
		const { savedSlug: slugB } = await fixture.requestRpc({
			_tag: "SaveProject",
			folders: [projectB],
		});
		const create = async (projectSlug: string, title: string) =>
			(
				await fixture.requestRpc({
					_tag: "CreateSession",
					projectSlug,
					originId: "browser-audiences",
					providerId: "claude",
					model: { providerId: "claude", modelId: "sonnet" },
					permissionMode: "ask",
					title,
				})
			).sessionId;
		const sessions = withSessions
			? {
					a: await create("process-test", "Asks in A"),
					b: await create(slugB, "Asks in B"),
				}
			: { a: "", b: "" };
		return { fixture, slugB, sessions };
	}

	it("sends an ask in A to tabs on A and on B, with no attach and no Open", async () => {
		const { fixture, slugB, sessions } = await twoProjects(
			"approval-other-project",
		);
		// 9: no tab can attach a project; navigation names its session or project.
		expect(WsRpcGroup.requests.has("AttachProject")).toBe(false);
		const onA = await fixture.connect(sessions.a, undefined, "process-test");
		const onB = await fixture.connect(sessions.b, undefined, slugB);
		await onB.followAlerts();

		// 1, 2: the ask reaches both tabs; B never opens A's session.
		void onA
			.send(sessions.a, "approval-audiences", 120_000)
			.catch(() => undefined);
		const [askA, askB] = await Promise.all([
			card(onA, sessions.a),
			card(onB, sessions.a),
		]);
		expect(askB["requestId"]).toBe(askA["requestId"]);
		// 18: the ask alert reaches B too, from the daemon-wide feed.
		const alert = await onB.waitFor(
			(message) =>
				message["type"] === "alert" &&
				message["kind"] === "permission" &&
				message["sessionId"] === sessions.a,
			0,
			30_000,
		);

		// 3: answered in A, the card leaves both tabs.
		const cursorA = onA.frames.length;
		const cursorB = onB.frames.length;
		await onA.answerApproval(askA, "allow");
		await Promise.all([
			removed(onA, String(askA["requestId"]), cursorA),
			removed(onB, String(askA["requestId"]), cursorB),
		]);
		await onA.waitForTurnEnd(sessions.a, cursorA, 60_000);

		// 6: B closes its feeds; A still gets the next ask.
		await onB.close();
		const next = onA.frames.length;
		void onA
			.send(sessions.a, "question-fixed-audiences", 120_000)
			.catch(() => undefined);
		const question = await card(onA, sessions.a, next);

		// 4: a fresh tab on B gets A's pending ask once, in its first snapshot.
		const reconnected = await fixture.connect(sessions.b, undefined, slugB);
		await card(reconnected, sessions.a);
		const cardsOnReconnect = cards(reconnected, sessions.a);
		expect(cardsOnReconnect).toBe(1);

		// 9: B answers A's question once it opens A's session.
		await reconnected.open(sessions.a);
		const end = reconnected.frames.length;
		await reconnected.answerQuestion(question, { "0": "Continue" });
		await reconnected.waitForTurnEnd(sessions.a, end, 60_000);

		evidence = {
			...evidence,
			sessions,
			cardOnB: { requestId: askB["requestId"], sessionId: askB["sessionId"] },
			alertOnB: { kind: alert["kind"], sessionId: alert["sessionId"] },
			removedOnBoth: true,
			questionAfterBClosed: question["toolId"],
			cardsOnReconnect,
		};
	});

	it("sends a project's terminal output to every tab on it and to no tab on another", async () => {
		const { fixture, slugB } = await twoProjects("shared-pty", false);
		const first = await fixture.connect(undefined, undefined, "process-test");
		const second = await fixture.connect(undefined, undefined, "process-test");
		const other = await fixture.connect(undefined, undefined, slugB);

		const pty = await first.createPty();
		const marker = `shared-${pty.id.slice(0, 8)}`;
		await first.inputPty(pty.id, printMarker(marker));
		// 13: both tabs on A get the output.
		await Promise.all([
			waitForOutput(first, pty.id, marker),
			waitForOutput(second, pty.id, marker),
		]);
		// 14: the tab on B gets nothing that names A's terminal.
		const framesOnB = ptyFrames(other, pty.id);
		expect(framesOnB).toBe(0);

		// 15: the second tab moves its terminal feed to B; A's later output stays away.
		await second.followPtys(slugB);
		const after = second.frames.length;
		const later = `later-${pty.id.slice(0, 8)}`;
		await first.inputPty(pty.id, printMarker(later));
		await waitForOutput(first, pty.id, later);
		const laterOnSecond = output(second, pty.id, after).includes(later);
		expect(laterOnSecond).toBe(false);
		expect(ptyFrames(other, pty.id)).toBe(0);

		await first.closePty(pty.id);
		evidence = {
			...evidence,
			ptyId: pty.id,
			outputOnBothTabsOfA: true,
			framesOnB,
			laterOutputAfterMovingToB: laterOnSecond,
		};
	});

	it("drops a removed project's asks from the daemon-wide feed", async () => {
		const { fixture, slugB, sessions } = await twoProjects("project-removed");
		const onB = await fixture.connect(sessions.b, undefined, slugB);
		void onB
			.send(sessions.b, "approval-audiences-removed", 120_000)
			.catch(() => undefined);
		const ask = await card(onB, sessions.b);
		await onB.close();

		await fixture.requestRpc({ _tag: "RemoveProject", slug: slugB });
		// 17: a tab opened after the removal holds no ask of B.
		const onA = await fixture.connect(sessions.a, undefined, "process-test");
		const cardsOfB = cards(onA, sessions.b);
		expect(cardsOfB).toBe(0);
		evidence = {
			...evidence,
			sessions,
			askInB: ask["requestId"],
			cardsOfRemovedProject: cardsOfB,
		};
	});
});
