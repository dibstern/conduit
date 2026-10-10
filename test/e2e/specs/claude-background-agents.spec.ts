// A Claude turn that launches background agents and shells must keep each
// agent's work in that agent's Child Session, also after the parent's result,
// and keep the shells an agent starts out of the parent.
// Spec: conduit-test-i7fy (tickets .2 reproduce, .3/.4 fix).
//
// Replays a captured trace (no model call): a 40s top-level shell, agent A
// (with a nested 15s shell) and agent B, all in the background; the parent's
// result; then each finish and its wake-up turn. A second turn runs in a
// restarted Claude process that resumes the session. Agent transcript reads
// are served from the capture as the transcript poller would see them live.
// The replay holds after the parent's result, and again with agent A's steps
// played but its finish not yet, so "parent idle, agent working" is a state
// the test holds rather than races.
//
// The report lists, per step, where each of agent A's late steps and each
// nested shell landed, with a screenshot.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

const TRACE = "concurrent-background-work-turn";
const AGENT_A_TOOL = "toolu_01U3biseGLup5XHSnDHKQqtC";
// The trace line of agent A's finish (its task_updated).
const AGENT_A_FINISH_LINE = 113;
// Agent A's nested shells: their task ids and Bash tool_use ids.
const NESTED_SHELL_IDS = [
	"b1oikywh4",
	"toolu_012sQbH5FcjhYqyWS6bnMUHo",
	"bpdadyngc",
	"toolu_01SZbHfa5rA1Ad32n4TCCjpQ",
];

type TraceLine = {
	type: string;
	subtype?: string;
	task_id?: string;
	task_type?: string;
	parent_tool_use_id?: string | null;
	message?: { content?: { type: string; id?: string }[] };
};
const traceLines = readFileSync(
	join(process.cwd(), "test/fixtures/claude-sdk-traces", `${TRACE}.jsonl`),
	"utf8",
)
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line) as TraceLine);
const toolIds = (lines: TraceLine[], issued: (line: TraceLine) => boolean) =>
	lines
		.filter((line) => line.type === "assistant" && issued(line))
		.flatMap((line) =>
			(line.message?.content ?? []).flatMap((block) =>
				block.type === "tool_use" && block.id ? [block.id] : [],
			),
		);
// The parent issued these tool calls itself; every other tool call in the
// trace was issued by an agent.
const PARENT_TOOL_IDS = toolIds(traceLines, (line) => !line.parent_tool_use_id);
const AGENT_TOOL_IDS = toolIds(traceLines, (line) => !!line.parent_tool_use_id);
// Only agents get a Child Session; background shells do not (.9).
const AGENT_TASK_IDS = traceLines
	.filter(
		(line) =>
			line.subtype === "task_started" && line.task_type !== "local_bash",
	)
	.map((line) => String(line.task_id));
// Agent A's tool calls streamed after the parent's result ("launched.").
const AGENT_A_LATE_TOOL_IDS = toolIds(
	traceLines.slice(traceLines.findIndex((line) => line.type === "result") + 1),
	(line) => line.parent_tool_use_id === AGENT_A_TOOL,
);

test.describe("Claude background agents", () => {
	test.use({
		claudeReplay: {
			turns: [TRACE, "concurrent-background-work-after-restart-turn"],
			holdAfterResult: true,
			holdBefore: { turn: 1, message: AGENT_A_FINISH_LINE },
		},
	});

	test("keeps each background agent's work in its Child Session", async ({
		page,
		relayUrl,
		harness,
	}, testInfo) => {
		test.setTimeout(120_000);
		const parentId = decodeURIComponent(harness.projectUrl.slice("/s/".length));
		// Which stored sessions mention each id: "parent", a child id, or none.
		const placement = () => {
			const db = new DatabaseSync(harness.eventsDbPath, { readOnly: true });
			try {
				const childRows = db
					.prepare(
						"SELECT id, title, provider_sid AS sid, (SELECT COUNT(*) FROM events WHERE session_id = s.id) AS events FROM sessions s WHERE parent_id = ? ORDER BY created_at",
					)
					.all(parentId)
					.map((row) => ({
						id: String(row["id"]),
						title: String(row["title"]),
						sid: row["sid"],
						events: Number(row["events"]),
					}));
				const children = childRows.map((row) => row.id);
				const mentions = (sessionId: string, id: string) =>
					Number(
						db
							.prepare(
								// The id as a whole JSON string value, not inside free text
								// such as a progress description.
								"SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND instr(data, '\"' || ? || '\"') > 0",
							)
							.get(sessionId, id)?.["n"],
					);
				const where = (id: string) =>
					[parentId, ...children]
						.filter((sessionId) => mentions(sessionId, id) > 0)
						.map((sessionId) =>
							sessionId === parentId ? "parent" : sessionId,
						);
				const parentTools = db
					.prepare(
						"SELECT DISTINCT json_extract(data, '$.partId') AS id FROM events WHERE session_id = ? AND type = 'tool.started' ORDER BY id",
					)
					.all(parentId)
					.map((row) => String(row["id"]));
				return {
					children: childRows,
					parentTools,
					agentToolsInParent: AGENT_TOOL_IDS.filter(
						(id) => mentions(parentId, id) > 0,
					),
					agentLateSteps: Object.fromEntries(
						AGENT_A_LATE_TOOL_IDS.map((id) => [id, where(id)]),
					),
					nestedShell: Object.fromEntries(
						NESTED_SHELL_IDS.map((id) => [id, where(id)]),
					),
				};
			} finally {
				db.close();
			}
		};
		const report: { step: string; placement: ReturnType<typeof placement> }[] =
			[];
		const record = async (step: string) => {
			report.push({ step, placement: placement() });
			const path = testInfo.outputPath(`${step}.png`);
			await page.screenshot({ path, animations: "disabled" });
			await testInfo.attach(`${step}.png`, { path, contentType: "image/png" });
		};

		// Exactly one Child Session holds each of agent A's late steps, and the
		// parent holds only its own tool calls.
		const expectAgentStepsInChild = (
			step: string,
			found: ReturnType<typeof placement>,
		) => {
			for (const id of AGENT_A_LATE_TOOL_IDS)
				expect
					.soft(
						found.agentLateSteps[id],
						`${step}: agent A's step ${id} after the parent's result is not in exactly one Child Session`,
					)
					.toEqual([expect.not.stringMatching(/^parent$/)]);
			// The parent shows only the tool calls it issued itself.
			expect
				.soft(found.parentTools, `${step}: parent tool parts`)
				.toEqual([...PARENT_TOOL_IDS].sort());
			expect
				.soft(found.agentToolsInParent, `${step}: agent tool ids in the parent`)
				.toEqual([]);
			expect
				.soft(
					found.children.map((child) => child.sid).sort(),
					`${step}: Child Sessions are exactly the agents'`,
				)
				.toEqual([...AGENT_TASK_IDS].sort());
		};

		const app = new AppPage(page);
		const chat = new ChatPage(page);
		const replayer = harness.claudeReplayer;
		if (!replayer) throw new Error("no Claude replayer");
		expect(AGENT_A_LATE_TOOL_IDS.length).toBeGreaterThan(0);
		try {
			await app.goto(relayUrl);
			await app.sendMessage("Launch the background work");
			await expect
				.poll(() => chat.getLastAssistantText(), { timeout: 30_000 })
				.toContain("launched.");
			await replayer.held();
			await record("parent-result");

			// Agent A's steps play while the parent is idle; hold before it ends.
			replayer.release();
			await replayer.held();
			await chat.waitForStreamingComplete();
			await expect
				.poll(() => placement().nestedShell["bpdadyngc"])
				.not.toEqual([]);
			await record("agent-a-working");
			expectAgentStepsInChild("agent A working", placement());

			replayer.release();
			await expect
				.poll(() => chat.getLastAssistantText(), { timeout: 60_000 })
				.toContain("The top-level 40-second shell finished.");
			await chat.waitForStreamingComplete();
			await record("background-work-finished");

			await harness.restart();
			await gotoRelay(page, relayUrl);
			await app.sendMessage("Reply with only: ok, still here.");
			await expect
				.poll(() => chat.getLastAssistantText(), { timeout: 30_000 })
				.toContain("ok, still here.");
			await record("after-restart");

			const final = placement();
			expectAgentStepsInChild("after restart", final);
			for (const id of NESTED_SHELL_IDS)
				expect
					.soft(
						final.nestedShell[id],
						`agent A's nested shell id ${id} leaked into the parent`,
					)
					.not.toContain("parent");
		} finally {
			const path = testInfo.outputPath("background-agents-report.json");
			writeFileSync(path, JSON.stringify({ parentId, report }, null, 2));
			await testInfo.attach("background-agents-report.json", {
				path,
				contentType: "application/json",
			});
		}
	});
});
