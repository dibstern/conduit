// The multi-folder project flow end to end, once per provider, against the
// built server with replayed providers: add a project from a New folder plus
// an existing folder, promote the existing one to main, reload, add a second
// New folder from Edit, then read the marker through a session.
//
// Recordings, re-captured when the wire format or the provider wiring changes:
// - OpenCode: SCENARIO=multi-folder-project pnpm test:record-snapshots
// - Claude: test/e2e/provider/claude-extra-folder-trace-capture.test.ts
// Recorded responses carry record-time paths, so assertions use the marker's
// fixed string and the replay-time paths the providers received.
//
// Failure cases: the pencil is unreachable on touch, shows in select mode, or
// opens an empty dialog; Save is enabled before a change or drops the slug;
// a New folder from Edit is not created; the project or its storage does not
// persist, or a .conduit folder lands in a project folder; the session runs
// outside the main folder or the provider never learns the extra folders.

import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { Effect } from "effect";
import { projectStorageDir } from "../../../src/lib/persistence/project-storage.js";
import type { ProcessHarness } from "../../helpers/process-harness.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

const MARKER = "CONDUIT-EXTRA-FOLDER-MARKER-7f3a";

const providers = [
	{
		driver: "opencode",
		harnessOptions: { opencodeRecording: "multi-folder-project" },
		prompt: () =>
			"Use the Read tool to read marker.txt in the additional project folder, then reply with its contents.",
	},
	{
		driver: "claude",
		harnessOptions: { claudeReplay: { turns: ["extra-folder-read-turn"] } },
		prompt: (markerPath: string) =>
			`Use the Read tool to read the file at the absolute path ${markerPath}, then reply with its contents.`,
	},
] as const;

function persistedProject(harness: ProcessHarness, slug: string) {
	const config: {
		projects: { slug: string; title?: string; folders: string[] }[];
	} = JSON.parse(readFileSync(join(harness.configDir, "daemon.json"), "utf8"));
	return config.projects.find((project) => project.slug === slug);
}

async function openScopeMenu(page: Page): Promise<void> {
	await page.getByTestId("session-scope-chip").click();
	await expect(page.getByRole("menu", { name: "Project scope" })).toBeVisible();
}

function projectRow(page: Page, slug: string): Locator {
	return page.getByRole("menuitemradio").filter({ hasText: `project:${slug}` });
}

for (const provider of providers) {
	test.describe(provider.driver, () => {
		test.use({ harnessOptions: provider.harnessOptions });

		test("adds, edits and reads across a multi-folder project", async ({
			page,
			harness,
		}, testInfo) => {
			test.setTimeout(180_000);
			const startupLog = harness.logTail;
			const shot = (name: string) =>
				page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
			const root = realpathSync(harness.root);
			const created = join(root, "edit-notes");
			const existing = join(root, "edit-app");
			const createdFromEdit = join(root, "edit-docs");
			const markerPath = join(existing, "marker.txt");
			mkdirSync(existing);
			writeFileSync(markerPath, MARKER);
			const app = new AppPage(page);
			const chat = new ChatPage(page);

			// 1. A New folder (git init) plus an existing folder holding the marker.
			await app.goto(harness.baseUrl);
			await openScopeMenu(page);
			await page.getByRole("menuitem", { name: "Add a project…" }).click();
			const addDialog = page.getByRole("dialog", {
				name: "Add project",
				exact: true,
			});
			await expect(addDialog).toBeVisible();
			const addInput = addDialog.getByRole("combobox", { name: "Add folder" });
			await addInput.fill(created);
			await expect(
				addDialog.getByRole("checkbox", { name: "git init" }),
			).toBeChecked();
			await addDialog.getByRole("option", { name: /New folder/ }).click();
			await addInput.fill(existing);
			await addDialog
				.getByRole("option", { name: existing, exact: true })
				.click();
			await expect(addDialog.getByTestId("project-folder-row")).toHaveCount(2);
			await shot("1-add-folders");

			// 2. The existing folder becomes main, and the name follows it.
			await addDialog
				.getByRole("button", { name: `Make main: ${existing}` })
				.click();
			await expect(
				addDialog.getByTestId("project-folder-row").first(),
			).toHaveAttribute("aria-label", `Main folder: ${existing}`);
			await expect(addDialog.getByLabel("Project name")).toHaveValue(
				"edit-app",
			);
			await shot("2-make-main");
			await addDialog.getByRole("button", { name: /^Add project/ }).click();
			await expect(addDialog).toBeHidden();
			await expect(page.getByTestId("session-scope-chip")).toHaveText(
				"edit-app",
			);
			const slug = new URL(page.url()).searchParams.get("p");
			if (!slug) throw new Error("The saved project did not become the scope");
			expect(existsSync(join(created, ".git"))).toBe(true);

			// 3. Reload: the project and its folder order persisted.
			await page.reload();
			await app.connectOverlay.waitFor({ state: "detached", timeout: 30_000 });
			await expect(page.getByTestId("session-scope-chip")).toHaveText(
				"edit-app",
			);
			await expect
				.poll(() => persistedProject(harness, slug))
				.toMatchObject({ title: "edit-app", folders: [existing, created] });
			await shot("3-reloaded");

			// 4. Edit from the pencil, adding a second New folder.
			await openScopeMenu(page);
			const row = projectRow(page, slug);
			const pencil = row.getByTestId("session-scope-edit");
			if (testInfo.project.name === "mobile") {
				await expect(pencil).toBeVisible();
				const hitArea = await pencil.evaluate((element) => {
					const before = getComputedStyle(element, "::before");
					return Math.min(
						Number.parseFloat(before.height),
						Number.parseFloat(before.width),
					);
				});
				expect(hitArea).toBeGreaterThanOrEqual(44);
			} else {
				await page.mouse.move(0, 0);
				await expect(pencil).toBeHidden();
				await row.hover();
				await expect(pencil).toBeVisible();
			}
			await page.getByTestId("session-scope-select").click();
			await expect(
				page.getByTestId("session-scope-select-item"),
			).not.toHaveCount(0);
			await expect(page.getByTestId("session-scope-edit")).toHaveCount(0);
			await page.getByRole("menuitem", { name: "Cancel" }).click();
			const editDialog = page.getByRole("dialog", {
				name: "Edit project",
				exact: true,
			});
			if (testInfo.project.name !== "mobile") {
				// Keyboard route: the pencil is pointer-only, F2 on the row opens Edit.
				await row.hover();
				await expect(row).toBeFocused();
				await page.keyboard.press("F2");
				await expect(editDialog).toBeVisible();
				await page.keyboard.press("Escape");
				await expect(editDialog).toBeHidden();
				await openScopeMenu(page);
				await row.hover();
			}
			await shot("4-pencil");
			await pencil.click();
			await expect(editDialog).toBeVisible();
			await expect(editDialog.getByLabel("Project name")).toHaveValue(
				"edit-app",
			);
			await expect(editDialog.getByTestId("project-folder-row")).toHaveCount(2);
			await expect(
				editDialog.getByTestId("project-folder-row").first(),
			).toHaveAttribute("aria-label", `Main folder: ${existing}`);
			const save = editDialog.getByRole("button", { name: /^Save/ });
			await expect(save).toBeDisabled();
			await editDialog
				.getByRole("combobox", { name: "Add folder" })
				.fill(createdFromEdit);
			await expect(
				editDialog.getByRole("checkbox", { name: "git init" }),
			).toBeChecked();
			await editDialog.getByRole("option", { name: /New folder/ }).click();
			await expect(save).toBeEnabled();
			expect(existsSync(createdFromEdit)).toBe(false);
			await shot("4-edit");
			await save.click();
			await expect(editDialog).toBeHidden();
			expect(existsSync(join(createdFromEdit, ".git"))).toBe(true);
			const folders = [existing, created, createdFromEdit];
			await expect
				.poll(() => persistedProject(harness, slug))
				.toMatchObject({ title: "edit-app", folders });
			const rpc = await harness.connect();
			const listed = await Effect.runPromise(rpc.rpc.GetProjects({}));
			expect(listed.projects).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ slug, title: "edit-app", folders }),
				]),
			);

			// 5. History lives in conduit's config dir, never in a project folder.
			const storage = projectStorageDir(harness.configDir, slug);
			await expect.poll(() => existsSync(storage)).toBe(true);
			for (const folder of folders)
				expect(existsSync(join(folder, ".conduit"))).toBe(false);
			await shot("5-storage");

			// 6. A session runs in main and reads the marker; the provider was
			// told about both extra folders.
			await page.locator("#new-session-btn:visible").click();
			await expect(page).toHaveURL(/\/new\?/);
			expect(new URL(page.url()).searchParams.get("project")).toBe(slug);
			const picker = page.locator(
				'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible',
			);
			await picker.click();
			await page.getByTestId("picker-row-harness").click();
			await page.getByTestId(`picker-instance-${provider.driver}`).click();
			await page.keyboard.press("Escape");
			await expect(page.getByTestId("model-picker")).toBeHidden();
			await expect(picker).toHaveAttribute("data-instance-id", provider.driver);
			await app.sendMessage(provider.prompt(markerPath));
			await expect(page).toHaveURL(/\/s\/[^/?]+/);
			await expect(chat.assistantMessages.last()).toContainText(MARKER, {
				timeout: 60_000,
			});
			await chat.waitForStreamingComplete();
			await shot("6-session");

			const extras = [created, createdFromEdit];
			let providerCapture: unknown;
			if (provider.driver === "claude") {
				const runnerPids = harness.runnerPids();
				const turns = harness
					.claudeOptions()
					.filter(
						({ pid, options }) =>
							runnerPids.includes(pid) && options["maxTurns"] !== 0,
					);
				providerCapture = turns;
				expect(turns).not.toHaveLength(0);
				for (const { options } of turns) {
					expect(options["cwd"]).toBe(existing);
					expect(options["additionalDirectories"]).toEqual(extras);
				}
			} else {
				const requests = harness.opencodeRequestBodies();
				const permissions = requests
					.filter(
						({ method, path }) =>
							method === "PATCH" && /^\/session\/[^/]+$/.test(path),
					)
					.map(({ body }) => JSON.parse(body) as Record<string, unknown>)
					.filter((body) => "permission" in body);
				const prompts = requests
					.filter(
						({ method, path }) =>
							method === "POST" && path.endsWith("/prompt_async"),
					)
					.map(({ body }) => JSON.parse(body) as Record<string, unknown>);
				providerCapture = { permissions, prompts };
				expect(permissions).toEqual([
					{
						permission: extras.map((extra) => ({
							permission: "external_directory",
							pattern: `${extra}/*`,
							action: "allow",
						})),
					},
				]);
				for (const extra of extras)
					expect(String(prompts.at(-1)?.["system"])).toContain(extra);
			}

			writeFileSync(
				testInfo.outputPath("evidence.json"),
				JSON.stringify(
					{
						provider: provider.driver,
						folders: { main: existing, extras },
						persistedProject: persistedProject(harness, slug),
						listedProject: listed.projects.find(
							(project) => project.slug === slug,
						),
						projectStorage: storage,
						providerCapture,
						startupMigrationLog: startupLog
							.split("\n")
							.filter((line) => /migrat/i.test(line)),
						startupLog,
					},
					null,
					2,
				),
			);
		});
	});
}

test.afterEach(async ({ harness }, testInfo) => {
	writeFileSync(testInfo.outputPath("daemon.log"), harness.logTail);
});
