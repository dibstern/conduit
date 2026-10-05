import type { Page } from "@playwright/test";
import type { ProjectInfo } from "../../../src/lib/shared-types.js";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";

const project: ProjectInfo = {
	slug: "e2e-replay",
	title: "Conduit Project With A Long Name",
	folders: ["/work/conduit"],
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

test.use({ recording: "chat-simple", screenshot: "off" });

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
		await expect(identity).toContainText("feature/git");
		await expect(identity).toContainText("linked-17xt");
		const back = page.getByTestId("session-bar-back");
		const identityBox = await identity.boundingBox();
		const backBox = await back.boundingBox();
		expect(identityBox).not.toBeNull();
		expect(backBox).not.toBeNull();
		if (!identityBox || !backBox) return;
		expect(identityBox.x).toBeGreaterThanOrEqual(backBox.x + backBox.width);
		const height = await identity.evaluate((element) => ({
			actual: element.getBoundingClientRect().height,
			line: Number.parseFloat(getComputedStyle(element).lineHeight),
		}));
		expect(height.actual).toBeLessThanOrEqual(height.line + 1);
		const branch = identity.locator('[title="Branch: feature/git"]');
		await expect(branch).toBeVisible();
		if (viewport.width === 390) {
			const widths = await branch.evaluate((element) => ({
				scroll: element.scrollWidth,
				client: element.clientWidth,
			}));
			expect(widths.scroll).toBe(widths.client);
		}
		const dirty = identity.locator('[title="Uncommitted changes"]');
		await expect(dirty).toHaveText("●Uncommitted changes");
		await expect(dirty.locator(".sr-only")).toHaveText("Uncommitted changes");
	});
}

test("a project without git shows only its name", async ({
	page,
	relayUrl,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await supplyProject(page);
	await gotoRelay(page, relayUrl);
	const identity = page.getByTestId("session-bar-identity");
	await expect(identity).toHaveText(project.title);
	await expect(identity.locator('[title="Uncommitted changes"]')).toHaveCount(
		0,
	);
});
