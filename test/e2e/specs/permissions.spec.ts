// Tests the permission approval flow: permission cards appear when the agent
// needs to use tools, and the user can Allow/Deny.
// Uses the advanced-diff recording which triggers external_directory permissions.

import { decodeOpenCodePendingPermissionListResponse } from "../../../src/lib/contracts/providers/opencode-sdk.js";
import { loadOpenCodeRecording } from "../helpers/recorded-loader.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { PermissionPage } from "../page-objects/permission.page.js";

test.use({ recording: "advanced-diff" });

test.describe("Permissions", () => {
	test.describe.configure({ timeout: 60_000 });
	// The recording answers each permission itself; wait for the browser's.
	test.beforeEach(({ mockServer }) => mockServer.holdRepliesUntilAnswered());

	test("permission card appears when agent uses a tool", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		const perm = new PermissionPage(page);
		await app.goto(relayUrl);

		// Send a prompt that triggers an external_directory permission
		await app.sendMessage(
			"Create a file called /tmp/e2e-test-diff.txt with the text 'hello world'",
		);

		// Wait for the permission card to appear
		await perm.waitForCard(30_000);

		// Permission card should be visible
		const cardCount = await perm.getCardCount();
		expect(cardCount).toBeGreaterThan(0);
	});

	test("permission card structure has expected elements", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		const perm = new PermissionPage(page);
		await app.goto(relayUrl);

		// Trigger a permission request
		await app.sendMessage(
			"Create a file called /tmp/e2e-test-diff.txt with the text 'hello world'",
		);

		// Wait for the permission card
		const card = await perm.waitForCard(30_000);

		// Card should have Allow button
		const allowBtn = card.getByRole("button", { name: "Allow", exact: true });
		await expect(allowBtn).toBeVisible();

		// Card should have Deny button
		const denyBtn = card.getByRole("button", { name: "Deny", exact: true });
		await expect(denyBtn).toBeVisible();
	});

	test("Always Allow appends session rules before replying once to OpenCode", async ({
		page,
		relayUrl,
		harness,
		mockServer,
	}) => {
		const app = new AppPage(page);
		const perm = new PermissionPage(page);
		const sessionId = decodeURIComponent(
			harness.projectUrl.slice("/s/".length),
		);
		const recordedPermission = loadOpenCodeRecording(
			"advanced-diff",
		).interactions.find(
			(interaction) =>
				interaction.kind === "sse" && interaction.type === "permission.asked",
		);
		if (recordedPermission?.kind !== "sse") {
			throw new Error("advanced-diff recording has no permission request");
		}
		const [request] = decodeOpenCodePendingPermissionListResponse([
			{ ...recordedPermission.properties, sessionID: sessionId },
		]);
		if (!request?.always?.length) {
			throw new Error("Recorded permission request has no always patterns");
		}

		await app.goto(relayUrl);
		await app.sendMessage(
			"Create a file called /tmp/e2e-test-diff.txt with the text 'hello world'",
		);
		await perm.waitForCard(30_000);
		await expect(
			page.locator(`[data-request-id="${request.id}"] .permission-card`),
		).toBeVisible();
		const updatePath = `/session/${sessionId}`;
		const replyPath = `/session/${sessionId}/permissions/${request.id}`;
		// The capture's list responses predate this pending request.
		mockServer.setExactResponse("GET", "/permission", 200, [request]);
		mockServer.setExactResponse("POST", replyPath, 200, true);
		const requestStart = mockServer.requestBodies.length;

		await perm.clickAlwaysAllow();

		await expect
			.poll(() =>
				mockServer.requestBodies
					.slice(requestStart)
					.filter(({ path }) => path === updatePath || path === replyPath)
					.map(({ method, path, body }) => ({
						method,
						path,
						body: JSON.parse(body),
					})),
			)
			.toEqual([
				{
					method: "PATCH",
					path: updatePath,
					body: {
						permission: request.always.map((pattern) => ({
							permission: request.permission,
							pattern,
							action: "allow",
						})),
					},
				},
				{ method: "POST", path: replyPath, body: { response: "once" } },
			]);
		mockServer.setExactResponse("GET", "/permission", 200, []);
	});
});
