// One recorded turn joins typed skills, Skill tool activity, and the session
// chip. Replay keeps the real SDK input and tool ids; no live provider is used.

import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test as replayTest } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

const test = replayTest.extend({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructuring even for a fixture with no dependencies.
	projectDir: async ({}, use) => {
		const projectDir = mkdtempSync(join(tmpdir(), "e2e-session-skills-"));
		try {
			const skillsDir = join(projectDir, ".claude", "skills");
			mkdirSync(skillsDir, { recursive: true });
			cpSync(
				join(
					import.meta.dirname,
					"../../fixtures/claude-sdk-traces/skill-loads-turn-skills",
				),
				skillsDir,
				{ recursive: true },
			);
			await use(projectDir);
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	},
});

test.describe("Session skills chip", () => {
	test.use({
		claudeReplay: { turns: ["skill-loads-turn"], delayMs: 1_000 },
	});
	test.describe.configure({ timeout: 90_000 });

	test.beforeEach(({ page }) => {
		const viewport = page.viewportSize();
		test.skip(
			!viewport || viewport.width < 1440,
			"Claude replay chat tests run on desktop viewport only",
		);
	});

	test("counts typed and agent-loaded skills and jumps to the Skill step", async ({
		page,
		relayUrl,
		harness,
	}, testInfo) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(relayUrl);
		await app.sendMessage("/release-notes");
		await expect(chat.userMessages.locator(".skill-pill")).toHaveText(
			"/release-notes",
		);

		const chip = page.getByTestId("session-skills-chip");
		const pulse = page.getByTestId("session-skills-chip-pulse");
		// The Skill is in flight for exactly one replay gap: from its tool_use
		// block closing to its tool_result. The activity row can't witness that
		// window (conduit-test-17vy renders live tools as
		// completed), so the pulse and the mid-turn count are the evidence.
		await expect(pulse).toBeVisible({ timeout: 45_000 });
		await expect(chip).toHaveAccessibleName("2 skills used");

		await chat.waitForAssistantMessage();
		await chat.waitForStreamingComplete();
		await expect(chat.assistantMessages.last()).toContainText("notes ready");
		await expect(chip).toHaveAccessibleName("2 skills used");
		await expect(pulse).toHaveCount(0);
		await chip.click();

		const rows = page.getByTestId("session-skills-row");
		const typedRow = page.locator(
			'[data-testid="session-skills-row"][data-skill="release-notes"]',
		);
		const agentRow = page.locator(
			'[data-testid="session-skills-row"][data-skill="changelog-style"]',
		);
		await expect(rows).toHaveCount(2);
		await expect(typedRow).toBeVisible();
		await expect(agentRow).toBeVisible();
		await expect(typedRow.getByTestId("session-skills-row-meta")).toHaveText(
			/^you · turn 1 ·/,
		);
		await expect(agentRow.getByTestId("session-skills-row-meta")).toHaveText(
			/^agent · turn 1 ·/,
		);
		await testInfo.attach("session-skills-list.png", {
			body: await page.screenshot({ animations: "disabled" }),
			contentType: "image/png",
		});
		await page.keyboard.press("Escape");
		await expect(rows).toHaveCount(0);

		const activity = page.locator(".turn-activity").filter({
			has: page.locator(".skills-toggle"),
		});
		await expect(activity).toHaveCount(1);
		const activityToggle = activity.locator(".turn-activity-toggle");
		if ((await activityToggle.getAttribute("aria-expanded")) !== "true")
			await activityToggle.click();
		const skillStep = activity
			.locator(".tool-item[data-part]")
			.filter({ hasText: "changelog-style" });
		await expect(skillStep).toHaveCount(1);
		await expect(skillStep).toContainText("changelog-style");
		const part = await skillStep.getAttribute("data-part");
		if (!part) throw new Error("Skill step has no data-part anchor");
		const anchoredStep = activity.locator(
			`.tool-item[data-part=${JSON.stringify(part)}]`,
		);

		const skillsToggle = activity.locator(".skills-toggle");
		await skillsToggle.click();
		await expect(skillsToggle).toHaveAttribute("aria-expanded", "true");
		const turnSkills = activity.getByRole("list", {
			name: "Skills in this turn",
		});
		await expect(turnSkills).toBeVisible();
		await expect(turnSkills).toContainText("changelog-style");

		const sessionId = decodeURIComponent(
			harness.projectUrl.slice("/s/".length),
		);
		const db = new DatabaseSync(harness.eventsDbPath, { readOnly: true });
		try {
			// The prompt lives in text.delta, separate from message.created.
			// Select both and only the tool lifecycle for the anchor read above.
			const events = db
				.prepare(
					`WITH typed_message AS (
						SELECT json_extract(data, '$.messageId') AS id FROM events
						WHERE session_id = ? AND type = 'text.delta'
							AND json_extract(data, '$.text') = '/release-notes'
					)
					SELECT sequence, type,
						substr(json_extract(data, '$.messageId'), 1, 256) AS messageId,
						substr(json_extract(data, '$.partId'), 1, 256) AS partId,
						json_extract(data, '$.role') AS role,
						substr(json_extract(data, '$.text'), 1, 300) AS text,
						substr(json_extract(data, '$.toolName'), 1, 80) AS toolName,
						substr(json_extract(data, '$.input'), 1, 300) AS input,
						substr(json_extract(data, '$.result'), 1, 300) AS result
					FROM events WHERE session_id = ? AND (
						(type IN ('message.created', 'text.delta')
							AND json_extract(data, '$.messageId') IN (SELECT id FROM typed_message))
						OR (type IN ('tool.started', 'tool.running', 'tool.completed')
							AND json_extract(data, '$.messageId') || '/' || json_extract(data, '$.partId') = ?)
					) ORDER BY sequence`,
				)
				.all(sessionId, sessionId, part);
			await testInfo.attach("session-skills-events.json", {
				body: Buffer.from(JSON.stringify({ sessionId, part, events }, null, 2)),
				contentType: "application/json",
			});
		} finally {
			db.close();
		}

		await skillsToggle.click();
		await activityToggle.click();
		await expect(activityToggle).toHaveAttribute("aria-expanded", "false");
		await expect(anchoredStep).toHaveCount(0);
		await chip.click();
		await agentRow.click();
		await expect(activityToggle).toHaveAttribute("aria-expanded", "true");
		await expect(anchoredStep).toBeInViewport();
	});
});
