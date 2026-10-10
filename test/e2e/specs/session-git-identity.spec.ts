import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { ProjectInfo } from "../../../src/lib/shared-types.js";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";

// The pill labels the main folder's basename; a long one stresses the phone bar.
const folderName = "conduit-project-with-a-long-name";
const project: ProjectInfo = {
	slug: "e2e-replay",
	title: "Conduit",
	folders: [`/work/${folderName}`],
};

// Keep the replay relay for the session; replace only its project-list RPC response.
async function supplyProject(
	page: Page,
	git?: ProjectInfo["git"],
): Promise<void> {
	await page.routeWebSocket(/\/rpc$/, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((message) => {
			if (typeof message !== "string") {
				server.send(message);
				return;
			}
			let frame: unknown;
			try {
				frame = JSON.parse(message);
			} catch {
				server.send(message);
				return;
			}
			if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
				server.send(message);
				return;
			}
			const request = frame as {
				_tag?: string;
				tag?: string;
				id?: string;
			};
			if (
				request._tag !== "Request" ||
				request.tag !== "GetProjects" ||
				!request.id
			) {
				server.send(message);
				return;
			}
			ws.send(
				JSON.stringify({
					_tag: "Exit",
					requestId: request.id,
					exit: {
						_tag: "Success",
						value: {
							projectSlug: project.slug,
							projects: [{ ...project, ...(git ? { git } : {}) }],
							current: project.slug,
						},
					},
				}),
			);
		});
	});
}

// The relay reads real git for its folder; a non-git folder keeps the mocked project git in charge.
test.use({
	recording: "chat-simple",
	screenshot: "off",
	projectDir: mkdtempSync(join(tmpdir(), "git-identity-")),
});

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 320, height: 640 },
]) {
	test(`git identity fits the phone bar at ${viewport.width}px`, async ({
		page,
		relayUrl,
	}) => {
		await page.setViewportSize(viewport);
		await supplyProject(page, {
			branch: "feature/git",
			worktree: "linked-17xt",
			dirty: true,
		});
		await gotoRelay(page, relayUrl);

		const identity = page.getByTestId("session-bar-identity");
		await expect(identity.locator('[data-part="project"]')).toHaveText(
			folderName,
		);
		await expect(identity).toContainText("feature/git");
		// A linked worktree shows its icon; the name lives in the checkout details.
		await expect(
			identity.locator('[data-part="worktree"][data-icon="worktree"] svg'),
		).toBeVisible();
		await expect(identity).not.toContainText("linked-17xt");
		const back = page.getByTestId("session-bar-back");
		const identityBox = await identity.boundingBox();
		const backBox = await back.boundingBox();
		expect(identityBox).not.toBeNull();
		expect(backBox).not.toBeNull();
		if (!identityBox || !backBox) return;
		expect(identityBox.x).toBeGreaterThanOrEqual(backBox.x + backBox.width);
		// The pill is a fixed-height segment, so check its labels stay on one line.
		for (const part of ["project", "branch"]) {
			const height = await identity
				.locator(`[data-part="${part}"]`)
				.evaluate((element) => ({
					actual: element.getBoundingClientRect().height,
					line: Number.parseFloat(getComputedStyle(element).lineHeight),
				}));
			expect(height.actual).toBeLessThanOrEqual(height.line + 1);
		}
		const branch = identity.locator('[title="Branch: feature/git"]');
		await expect(branch).toBeVisible();
		// Phones cap the pill at 150px; the long folder name gives up its room
		// before the branch does.
		expect(identityBox.width).toBeLessThanOrEqual(150);
		const projectWidth = await identity
			.locator('[data-part="project"]')
			.evaluate((element) => element.clientWidth);
		const branchWidth = await branch.evaluate((element) => element.clientWidth);
		expect(branchWidth).toBeGreaterThan(projectWidth);
		const dirty = identity.locator('[title="Uncommitted changes"]');
		await expect(dirty).toBeVisible();
		await expect(dirty).toHaveText("Uncommitted changes");
		await expect(dirty.locator(".sr-only")).toHaveText("Uncommitted changes");
	});
}

test("a project without git shows only its folder name", async ({
	page,
	relayUrl,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await supplyProject(page);
	await gotoRelay(page, relayUrl);
	const identity = page.getByTestId("session-bar-identity");
	await expect(identity).toHaveText(folderName);
	await expect(identity.locator('[data-icon="folder"] svg')).toBeVisible();
	await expect(identity.locator('[title="Uncommitted changes"]')).toHaveCount(
		0,
	);
});
