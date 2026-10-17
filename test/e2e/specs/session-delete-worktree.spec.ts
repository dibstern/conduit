/*
 * Prompt failure cases, written before the UI implementation:
 * - With onDelete on, ordinary confirmation leaves removal to background cleanup.
 * - With onDelete off or unreadable, clean worktrees default to Remove and unfinished work to Keep.
 * - Explicit Keep/Remove reaches DeleteSession, including bulk and foreign rows.
 * - In-use checkouts say they are kept and cannot be selected for removal.
 * - Existing/non-worktree sessions retain the ordinary confirmation.
 * - Cancel or failed inspection never sends DeleteSession.
 * - Cleanup warnings describe kept folders after a successful session deletion.
 */
import { writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { DEFAULT_WORKTREE_CLEANUP } from "../../../src/lib/contracts/worktree.js";
import { WsRpcError } from "../../../src/lib/contracts/ws-rpc.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc, type RpcMockControl } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

test.use({ recording: "chat-simple" });

const folder = "/workspace/app";
const worktree = "/conduit/worktrees/e2e-replay/delete-session/app";
const controls = new WeakMap<Page, RpcMockControl>();
type Inspection = {
	worktrees: {
		folder: string;
		path: string;
		reasons: string[];
		inUse: boolean;
	}[];
	removeWorktrees: boolean;
};

const clean: Inspection = {
	worktrees: [{ folder, path: worktree, reasons: [], inUse: false }],
	removeWorktrees: true,
};

async function setup(
	page: Page,
	baseUrl: string,
	inspection: Inspection,
	options: {
		failInspection?: boolean;
		onDelete?: boolean;
		failCleanupSetting?: boolean;
		warnings?: string[];
		bulk?: boolean;
		foreign?: boolean;
		inspectionDelay?: Promise<void>;
	} = {},
) {
	const projectSlug = options.foreign ? "second-project" : "e2e-replay";
	const projects = [
		{ slug: "e2e-replay", title: "App", folders: [folder] },
		...(options.foreign
			? [{ slug: projectSlug, title: "Second", folders: ["/workspace/second"] }]
			: []),
	];
	let sessions = [
		{
			accountId: null,
			id: "delete-session",
			title: "Delete this session",
			status: "idle" as const,
			projectSlug,
			...(inspection.worktrees.length > 0
				? {
						workspace: {
							cause: "launch" as const,
							origin: "conduit" as const,
							worktrees: { [folder]: worktree },
						},
						git: { branch: "conduit/session-delete", worktree: "app" },
					}
				: {}),
		},
		...(options.bulk
			? [
					{
						accountId: null,
						id: "local-session",
						title: "Local session",
						status: "idle" as const,
						projectSlug,
					},
				]
			: []),
	];
	const rpc = await mockWsRpc(page, {
		stubs: {
			InspectSessionWorktrees: async ({ sessionId }) => {
				await options.inspectionDelay;
				if (options.failInspection)
					throw new WsRpcError({ message: "Could not inspect worktrees" });
				return sessionId === "local-session"
					? { worktrees: [], removeWorktrees: false }
					: inspection;
			},
			ListDaemonSessions: () => ({
				sessions: options.foreign ? sessions : [],
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
			DeleteSession: ({ sessionId }) => {
				sessions = sessions.filter(({ id }) => id !== sessionId);
				rpc.setShellRows(options.foreign ? [] : sessions);
				return { ok: true, worktreeWarnings: options.warnings ?? [] };
			},
			GetModels: (input) => ({
				defaultOpenCodeInstanceId: "opencode",
				projectSlug: "projectSlug" in input ? input.projectSlug : projectSlug,
				providers: [],
			}),
		},
		handlers: {
			GetProjects: () => ({ projects, current: "e2e-replay" }),
			GetWorktreeCleanupSetting: () => {
				if (options.failCleanupSetting)
					throw new WsRpcError({ message: "Could not read cleanup setting" });
				return {
					worktreeCleanup: {
						...DEFAULT_WORKTREE_CLEANUP,
						onDelete: options.onDelete ?? false,
					},
				};
			},
		},
	});
	await mockRelayWebSocket(page, {
		initMessages: [
			{ type: "project_list", projects, current: "e2e-replay" },
			{
				type: "shell_snapshot",
				roots: true,
				sessions: options.foreign ? [] : sessions,
			},
		],
		responses: new Map(),
	});
	rpc.setShellRows(options.foreign ? [] : sessions);
	controls.set(page, rpc);
	await page.goto(`${baseUrl}/?p=e2e-replay`);
	if (options.foreign)
		await page.getByRole("button", { name: "Clear project scope" }).click();
	await expect(
		page.locator('#session-list [data-session-id="delete-session"]'),
	).toBeVisible();
	return rpc;
}

async function openDelete(page: Page, mobile: boolean, bulk = false) {
	const row = page.locator('#session-list [data-session-id="delete-session"]');
	if (mobile || bulk) {
		if (mobile) {
			await page.getByTestId("list-bar-select").click();
		} else {
			await page.getByRole("button", { name: "Select sessions" }).click();
		}
		await row.getByRole("checkbox").click();
		if (bulk)
			await page
				.locator('#session-list [data-session-id="local-session"]')
				.getByRole("checkbox")
				.click();
		await page.getByTestId("select-bar-delete").click();
	} else {
		await row.click({ button: "right" });
		await page.getByTestId("session-ctx-delete").click();
	}
	const prompt = page.locator("#confirm-modal");
	await expect(prompt).toBeVisible();
	return prompt;
}

test.afterEach(async ({ page }, info) => {
	const requests =
		controls
			.get(page)
			?.getRequests()
			.filter(({ tag }) =>
				["InspectSessionWorktrees", "DeleteSession"].includes(tag),
			)
			.map(({ tag, payload }) => ({
				tag,
				payload: {
					_tag: tag,
					...Object.fromEntries(
						Object.entries(payload).filter(([key]) => key !== "originId"),
					),
				},
			})) ?? [];
	const artifact = info.outputPath("session-delete-worktree.json");
	writeFileSync(artifact, `${JSON.stringify({ requests }, null, 2)}\n`);
	await info.attach("session-delete-worktree", {
		path: artifact,
		contentType: "application/json",
	});
});

test("a pending inspection cannot replace another deletion confirmation", async ({
	page,
	harness,
}) => {
	let releaseInspection: () => void = () => {};
	const inspectionDelay = new Promise<void>((resolve) => {
		releaseInspection = resolve;
	});
	const rpc = await setup(page, harness.relayBaseUrl, clean, {
		inspectionDelay,
	});
	const row = page.locator('#session-list [data-session-id="delete-session"]');
	await row.click({ button: "right" });
	await page.getByTestId("session-ctx-delete").click();
	await expect
		.poll(
			() =>
				rpc.getRequests().filter(({ tag }) => tag === "InspectSessionWorktrees")
					.length,
		)
		.toBe(1);
	await row.click({ button: "right" });
	await page.getByTestId("session-ctx-delete").click();
	releaseInspection();
	await expect(page.locator("#confirm-modal")).toBeVisible();
	await page.getByTestId("confirm-modal-cancel").click();
	expect(
		rpc.getRequests().filter(({ tag }) => tag === "InspectSessionWorktrees"),
	).toHaveLength(1);
	expect(
		rpc.getRequests().filter(({ tag }) => tag === "DeleteSession"),
	).toHaveLength(0);
	await openDelete(page, false);
	await page.getByTestId("confirm-modal-cancel").click();
});

for (const mode of [
	{ name: "desktop", viewport: { width: 1440, height: 900 }, mobile: false },
	{ name: "phone", viewport: { width: 390, height: 844 }, mobile: true },
]) {
	test.describe(mode.name, () => {
		test.use({ viewport: mode.viewport, hasTouch: mode.mobile });

		test("onDelete uses ordinary confirmation and leaves removal to background cleanup", async ({
			page,
			harness,
		}) => {
			const rpc = await setup(page, harness.relayBaseUrl, clean, {
				onDelete: true,
			});
			const prompt = await openDelete(page, mode.mobile);
			await expect(prompt).toContainText(
				"history will be permanently removed.",
			);
			await expect(prompt.getByRole("radio")).toHaveCount(0);
			await expect(prompt).not.toContainText(worktree);
			await page.screenshot({
				path: test.info().outputPath("automatic-cleanup-prompt.png"),
				animations: "disabled",
			});
			await page.getByTestId("confirm-modal-action").click();
			await expect
				.poll(() =>
					rpc
						.getRequests()
						.filter(({ tag }) => tag === "DeleteSession")
						.map(({ payload }) => payload["removeWorktrees"]),
				)
				.toEqual([false]);
		});

		test("an unreadable cleanup setting keeps the worktree choice and inspection default", async ({
			page,
			harness,
		}) => {
			const rpc = await setup(page, harness.relayBaseUrl, clean, {
				failCleanupSetting: true,
			});
			const prompt = await openDelete(page, mode.mobile);
			await expect(
				prompt.getByRole("radio", { name: "Remove worktrees", exact: true }),
			).toBeChecked();
			await page.getByTestId("confirm-modal-action").click();
			await expect
				.poll(() =>
					rpc
						.getRequests()
						.filter(({ tag }) => tag === "DeleteSession")
						.map(({ payload }) => payload["removeWorktrees"]),
				)
				.toEqual([true]);
		});

		test("clean worktrees default to Remove and send the chosen flag", async ({
			page,
			harness,
		}) => {
			const rpc = await setup(page, harness.relayBaseUrl, clean);
			const prompt = await openDelete(page, mode.mobile);
			await expect(prompt).toContainText(folder);
			await expect(prompt).toContainText(worktree);
			await expect(
				prompt.getByRole("radio", { name: "Remove worktrees", exact: true }),
			).toBeChecked();
			await page.screenshot({
				path: test.info().outputPath("clean-prompt.png"),
				animations: "disabled",
			});
			await page.getByTestId("confirm-modal-action").click();
			await expect
				.poll(() =>
					rpc
						.getRequests()
						.filter(({ tag }) => tag === "DeleteSession")
						.map(({ payload }) => payload["removeWorktrees"]),
				)
				.toEqual([true]);
		});

		for (const reason of [
			"Uncommitted changes",
			"Unpushed commits",
			"Commits not merged into main",
		]) {
			test(`${reason} names the folder and defaults to Keep`, async ({
				page,
				harness,
			}) => {
				const rpc = await setup(page, harness.relayBaseUrl, {
					worktrees: [
						{ folder, path: worktree, reasons: [reason], inUse: false },
					],
					removeWorktrees: false,
				});
				const prompt = await openDelete(page, mode.mobile);
				await expect(prompt).toContainText(folder);
				await expect(prompt).toContainText(reason);
				await expect(
					prompt.getByRole("radio", { name: "Keep worktrees", exact: true }),
				).toBeChecked();
				await page.getByTestId("confirm-modal-action").click();
				await expect
					.poll(() =>
						rpc
							.getRequests()
							.filter(({ tag }) => tag === "DeleteSession")
							.map(({ payload }) => payload["removeWorktrees"]),
					)
					.toEqual([false]);
			});
		}

		test("explicit Remove preserves all folder reasons and reports cleanup warnings", async ({
			page,
			harness,
		}) => {
			const warning = `${worktree}: kept because it has uncommitted changes`;
			const rpc = await setup(
				page,
				harness.relayBaseUrl,
				{
					worktrees: [
						{
							folder,
							path: worktree,
							reasons: ["Uncommitted changes", "Unpushed commits"],
							inUse: false,
						},
						{
							folder: "/workspace/api",
							path: "/conduit/worktrees/delete-session/api",
							reasons: ["Commits not merged into main"],
							inUse: false,
						},
					],
					removeWorktrees: false,
				},
				{ warnings: [warning] },
			);
			const prompt = await openDelete(page, mode.mobile);
			for (const text of [
				folder,
				"/workspace/api",
				"Uncommitted changes",
				"Unpushed commits",
				"Commits not merged into main",
			])
				await expect(prompt).toContainText(text);
			await page.screenshot({
				path: test.info().outputPath("unfinished-prompt.png"),
				animations: "disabled",
			});
			await prompt
				.getByRole("radio", { name: "Remove worktrees", exact: true })
				.click();
			await page.getByTestId("confirm-modal-action").click();
			await expect
				.poll(() =>
					rpc
						.getRequests()
						.filter(({ tag }) => tag === "DeleteSession")
						.map(({ payload }) => payload["removeWorktrees"]),
				)
				.toEqual([true]);
			await expect(
				page.getByRole("status").filter({ hasText: warning }),
			).toBeVisible();
		});

		test("explicit Keep overrides the clean default for a foreign session", async ({
			page,
			harness,
		}) => {
			const rpc = await setup(page, harness.relayBaseUrl, clean, {
				foreign: true,
			});
			const prompt = await openDelete(page, mode.mobile);
			await prompt
				.getByRole("radio", { name: "Keep worktrees", exact: true })
				.click();
			await page.getByTestId("confirm-modal-action").click();
			await expect
				.poll(() =>
					rpc
						.getRequests()
						.filter(({ tag }) => tag === "DeleteSession")
						.map(({ payload }) => ({
							sessionId: payload["sessionId"],
							removeWorktrees: payload["removeWorktrees"],
						})),
				)
				.toEqual([{ sessionId: "delete-session", removeWorktrees: false }]);
			expect(
				rpc.getRequests().find(({ tag }) => tag === "InspectSessionWorktrees")
					?.payload["sessionId"],
			).toBe("delete-session");
		});

		test("in-use worktrees say they are kept and disable Remove", async ({
			page,
			harness,
		}) => {
			const rpc = await setup(page, harness.relayBaseUrl, {
				worktrees: [{ folder, path: worktree, reasons: [], inUse: true }],
				removeWorktrees: false,
			});
			const prompt = await openDelete(page, mode.mobile);
			await expect(prompt).toContainText("another session");
			await expect(
				prompt.getByRole("radio", { name: "Keep worktrees", exact: true }),
			).toBeChecked();
			await expect(
				prompt.getByRole("radio", { name: "Remove worktrees", exact: true }),
			).toBeDisabled();
			await page.screenshot({
				path: test.info().outputPath("in-use-prompt.png"),
				animations: "disabled",
			});
			await page.getByTestId("confirm-modal-action").click();
			await expect
				.poll(() =>
					rpc
						.getRequests()
						.filter(({ tag }) => tag === "DeleteSession")
						.map(({ payload }) => payload["removeWorktrees"]),
				)
				.toEqual([false]);
		});

		test("non-worktree sessions keep the ordinary confirmation and omit the flag", async ({
			page,
			harness,
		}) => {
			const rpc = await setup(page, harness.relayBaseUrl, {
				worktrees: [],
				removeWorktrees: false,
			});
			const prompt = await openDelete(page, mode.mobile);
			await expect(prompt).toContainText(
				"history will be permanently removed.",
			);
			await expect(prompt.getByRole("radio")).toHaveCount(0);
			await page.getByTestId("confirm-modal-action").click();
			await expect
				.poll(
					() =>
						rpc.getRequests().filter(({ tag }) => tag === "DeleteSession")
							.length,
				)
				.toBe(1);
			expect(
				rpc.getRequests().find(({ tag }) => tag === "DeleteSession")?.payload,
			).not.toHaveProperty("removeWorktrees");
		});

		test("cancel never sends DeleteSession", async ({ page, harness }) => {
			const rpc = await setup(page, harness.relayBaseUrl, clean);
			await openDelete(page, mode.mobile);
			await page.getByTestId("confirm-modal-cancel").click();
			await expect(page.locator("#confirm-modal")).not.toBeVisible();
			expect(
				rpc.getRequests().filter(({ tag }) => tag === "DeleteSession"),
			).toEqual([]);
		});

		test("bulk deletion inspects every target and keeps unfinished work", async ({
			page,
			harness,
		}) => {
			const rpc = await setup(
				page,
				harness.relayBaseUrl,
				{
					worktrees: [
						{
							folder,
							path: worktree,
							reasons: ["Uncommitted changes"],
							inUse: false,
						},
					],
					removeWorktrees: false,
				},
				{ bulk: true },
			);
			const prompt = await openDelete(page, mode.mobile, true);
			await expect(
				prompt.getByRole("radio", { name: "Keep worktrees", exact: true }),
			).toBeChecked();
			await page.getByTestId("confirm-modal-action").click();
			await expect
				.poll(
					() =>
						rpc.getRequests().filter(({ tag }) => tag === "DeleteSession")
							.length,
				)
				.toBe(2);
			expect(
				rpc
					.getRequests()
					.filter(({ tag }) => tag === "InspectSessionWorktrees")
					.map(({ payload }) => payload["sessionId"])
					.sort(),
			).toEqual(["delete-session", "local-session"]);
			expect(
				rpc
					.getRequests()
					.find(
						({ tag, payload }) =>
							tag === "DeleteSession" &&
							payload["sessionId"] === "delete-session",
					)?.payload["removeWorktrees"],
			).toBe(false);
			expect(
				rpc
					.getRequests()
					.find(
						({ tag, payload }) =>
							tag === "DeleteSession" &&
							payload["sessionId"] === "local-session",
					)?.payload,
			).not.toHaveProperty("removeWorktrees");
		});

		test("failed inspection leaves the session intact", async ({
			page,
			harness,
		}) => {
			const rpc = await setup(page, harness.relayBaseUrl, clean, {
				failInspection: true,
			});
			if (mode.mobile) {
				await page.getByTestId("list-bar-select").click();
				await page
					.locator('#session-list [data-session-id="delete-session"]')
					.getByRole("checkbox")
					.click();
				await page.getByTestId("select-bar-delete").click();
			} else {
				await page
					.locator('#session-list [data-session-id="delete-session"]')
					.click({ button: "right" });
				await page.getByTestId("session-ctx-delete").click();
			}
			await expect(
				page.getByRole("status").filter({ hasText: "inspect" }),
			).toBeVisible();
			await expect(page.locator("#confirm-modal")).not.toBeVisible();
			expect(
				rpc.getRequests().filter(({ tag }) => tag === "DeleteSession"),
			).toEqual([]);
		});
	});
}
