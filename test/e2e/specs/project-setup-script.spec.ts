import { writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import type { ProjectSetupState } from "../../../src/lib/contracts/project-setup.js";
import type { ProjectInfo } from "../../../src/lib/shared-types.js";
import { detailRowsOf } from "../../helpers/detail-rows.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc, type RpcMockControl } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

// Failure cases: setup disappears before the first turn or on reload; streamed
// updates create duplicate blocks; failure hides its exit code or output;
// timeout/invalid-file notices stay running; Edit loses the stored script;
// a script-only edit cannot save; whitespace clearing omits the explicit clear.
test.use({ recording: "chat-simple", viewport: { width: 1440, height: 900 } });

const slug = "e2e-replay";
const sessionId = "setup-session";
const controls = new WeakMap<Page, RpcMockControl>();
const storedScript = "printf 'Preparing workspace\\n'\npnpm install";

function setupRows(setup: ProjectSetupState, output = "") {
	return detailRowsOf({
		id: "session-setup",
		role: "assistant",
		time: { created: 1 },
		parts: [
			{
				id: "session-setup-part",
				type: "setup",
				text: output,
				setup,
				time: { start: 1 },
			},
		],
	});
}

async function openSession(
	page: Page,
	baseUrl: string,
	setup?: ProjectSetupState,
) {
	let project: ProjectInfo = {
		slug,
		title: "Setup project",
		folders: ["/workspace/app"],
		setupScript: storedScript,
	};
	const session = {
		accountId: null,
		id: sessionId,
		title: "New worktree",
		status: "idle" as const,
		projectSlug: slug,
		messageCount: setup ? 1 : 0,
	};
	const rpc = await mockWsRpc(page, {
		stubs: {
			FindFolders: () => ({ home: "/workspace", entries: [] }),
			ListDaemonSessions: () => ({
				sessions: [session],
				availability: [],
				hasMore: false,
				nextCursor: null,
			}),
		},
		handlers: {
			GetModels: ({ projectSlug }) => ({ projectSlug, providers: [] }),
			GetProjects: () => ({ projects: [project], current: slug }),
			SaveProject: ({ setupScript }) => {
				const { setupScript: _previous, ...rest } = project;
				project = {
					...rest,
					...(typeof setupScript === "string" && setupScript.trim()
						? { setupScript }
						: {}),
				};
				return { savedSlug: slug, projects: [project], warnings: [] };
			},
		},
	});
	await mockRelayWebSocket(page, {
		initMessages: [
			{ type: "project_list", projects: [project], current: slug },
			{ type: "shell_snapshot", roots: true, sessions: [session] },
		],
		responses: new Map(),
	});
	rpc.setDetailRows(sessionId, setup ? setupRows(setup) : []);
	controls.set(page, rpc);
	await page.goto(`${baseUrl}/s/${sessionId}`);
	await rpc.waitForRequest(
		({ tag, payload }) =>
			tag === "SubscribeSessionDetail" && payload["sessionId"] === sessionId,
	);
	return rpc;
}

async function openEdit(page: Page) {
	const back = page.getByTestId("session-bar-back");
	if (await back.isVisible()) await back.click();
	await page.getByTestId("session-scope-chip").click();
	const row = page
		.getByRole("menu", { name: "Project scope" })
		.getByRole("menuitemradio")
		.filter({ hasText: `project:${slug}` });
	await row.hover();
	await row.getByTestId("session-scope-edit").click();
	const dialog = page.getByRole("dialog", {
		name: "Edit project",
		exact: true,
	});
	await expect(dialog).toBeVisible();
	return dialog;
}

test.afterEach(async ({ page }, info) => {
	const requests =
		controls
			.get(page)
			?.getRequests()
			.filter(({ tag }) => tag === "SaveProject") ?? [];
	const blocks = await page
		.getByTestId("session-setup-block")
		.evaluateAll((elements) =>
			elements.map((element) => ({
				source: element.getAttribute("data-setup-source"),
				outcome: element.getAttribute("data-setup-status"),
				text: element.textContent,
			})),
		);
	const artifact = info.outputPath("project-setup-script.json");
	writeFileSync(artifact, `${JSON.stringify({ requests, blocks }, null, 2)}\n`);
	await info.attach("project-setup-script-state", {
		path: artifact,
		contentType: "application/json",
	});
	const screenshot = info.outputPath("project-setup-script.png");
	await page.screenshot({ path: screenshot, animations: "disabled" });
	await info.attach("project-setup-script", {
		path: screenshot,
		contentType: "image/png",
	});
});

test("setup streams in one block before a turn and survives reload", async ({
	page,
	harness,
}) => {
	const rpc = await openSession(page, harness.relayBaseUrl, {
		source: "daemon",
		status: "running",
	});
	const block = page.getByTestId("session-setup-block");
	await expect(block).toHaveCount(1);
	await expect(block).toHaveAttribute("data-setup-status", "running");
	await expect(block).toContainText("Setup script running");
	rpc.setDetailRows(sessionId, [
		...setupRows(
			{ source: "daemon", status: "running" },
			"Installing dependencies…\n",
		),
	]);
	await expect(block).toContainText("Installing dependencies…");
	rpc.setDetailRows(sessionId, [
		...setupRows(
			{ source: "daemon", status: "succeeded", exitCode: 0 },
			"Installing dependencies…\nWorkspace ready\n",
		),
	]);
	await expect(block).toHaveCount(1);
	await expect(block).toHaveAttribute("data-setup-status", "succeeded");
	await expect(block).toContainText("Setup script succeeded");
	await expect(block).toContainText("Workspace ready");
	await page.reload();
	await expect(block).toHaveCount(1);
	await expect(block).toHaveAttribute("data-setup-status", "succeeded");
	await expect(block).toContainText("Workspace ready");
});

for (const outcome of [
	{
		status: "failed",
		exitCode: 7,
		label: "Setup script failed (exit code 7)",
		output: "Dependency installation failed\n",
	},
	{
		status: "timed_out",
		label: "Setup script timed out",
		output: "Waiting for dependencies\n",
	},
	{
		status: "skipped",
		label: "Setup script skipped",
		message: "Invalid conduit.json: setupScript must be a string",
		output: "",
	},
] as const) {
	test(`setup ${outcome.status} shows a terminal notice`, async ({
		page,
		harness,
	}) => {
		const { label, output, ...setup } = outcome;
		const rpc = await openSession(page, harness.relayBaseUrl);
		rpc.setDetailRows(sessionId, [
			...setupRows({ source: "file", ...setup }, output),
		]);
		const block = page.getByTestId("session-setup-block");
		await expect(block).toHaveAttribute("data-setup-status", outcome.status);
		await expect(block).toContainText(label);
		if (output) await expect(block).toContainText(output.trim());
		if ("message" in outcome)
			await expect(block).toContainText(outcome.message);
	});
}

test("ProjectDialog edits and explicitly clears the stored setup script", async ({
	page,
	harness,
}) => {
	const rpc = await openSession(page, harness.relayBaseUrl);
	let dialog = await openEdit(page);
	const field = dialog.getByRole("textbox", {
		name: "Setup script",
		exact: true,
	});
	await expect(field).toHaveValue(storedScript);
	await expect(dialog).toContainText(
		"It runs in each new worktree before the agent starts.",
	);
	await expect(
		dialog.getByRole("button", { name: "Save", exact: true }),
	).toBeDisabled();
	const updated = "printf 'Ready\\n'\nprintf 'Marker' > setup-marker.txt";
	await field.fill(updated);
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect
		.poll(() => rpc.getRequests().filter(({ tag }) => tag === "SaveProject"))
		.toHaveLength(1);
	expect(
		rpc.getRequests().find(({ tag }) => tag === "SaveProject")?.payload,
	).toEqual({
		_tag: "SaveProject",
		slug,
		title: "Setup project",
		folders: ["/workspace/app"],
		setupScript: updated,
	});
	dialog = await openEdit(page);
	await expect(
		dialog.getByRole("textbox", { name: "Setup script", exact: true }),
	).toHaveValue(updated);
	await dialog
		.getByRole("textbox", { name: "Setup script", exact: true })
		.fill(" \n\t ");
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect
		.poll(() => rpc.getRequests().filter(({ tag }) => tag === "SaveProject"))
		.toHaveLength(2);
	expect(
		rpc
			.getRequests()
			.filter(({ tag }) => tag === "SaveProject")
			.at(-1)?.payload,
	).toEqual({
		_tag: "SaveProject",
		slug,
		title: "Setup project",
		folders: ["/workspace/app"],
		setupScript: "",
	});
	dialog = await openEdit(page);
	await expect(
		dialog.getByRole("textbox", { name: "Setup script", exact: true }),
	).toHaveValue("");
});
