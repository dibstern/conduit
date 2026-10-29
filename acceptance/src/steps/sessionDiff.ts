import { expect, type Page } from "@playwright/test";
import {
	SessionDiffError,
	type SessionDiffFile,
} from "../../../src/lib/contracts/session-diff.js";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

interface DiffFixture {
	readonly files: SessionDiffFile[];
	readonly requested: string[];
	readonly gone: Set<string>;
	/** Patch requests whose revision another session listed. */
	readonly foreign: string[];
	lists: number;
	holdNext: boolean;
	release: (() => void) | null;
	replied: Promise<void> | null;
}

const fixtures = new WeakMap<Page, DiffFixture>();

/** A patch whose first added line names its file, so a step can find it. */
function patchFor(path: string, added = 1, removed = 1): string {
	return [
		`diff --git a/${path} b/${path}`,
		"index 1111111..2222222 100644",
		`--- a/${path}`,
		`+++ b/${path}`,
		`@@ -1,${removed + 1} +1,${added + 1} @@`,
		` // ${path}`,
		...Array.from({ length: removed }, (_, index) => `-old line ${index + 1}`),
		`+// changed ${path}`,
		...Array.from(
			{ length: added - 1 },
			(_, index) => `+new line ${index + 2}`,
		),
		"",
	].join("\n");
}

const changed = (path: string, insertions = 1, deletions = 1) =>
	({
		path,
		status: "modified",
		before: "1111111111111111111111111111111111111111",
		after: "2222222222222222222222222222222222222222",
		bytes: 2048,
		tier: insertions + deletions > 500 ? "onDemand" : "auto",
		insertions,
		deletions,
		binary: false,
	}) satisfies SessionDiffFile;

function seed(page: Page, files: SessionDiffFile[]): DiffFixture {
	const fixture: DiffFixture = {
		files,
		requested: [],
		gone: new Set(),
		foreign: [],
		lists: 0,
		holdNext: false,
		release: null,
		replied: null,
	};
	fixtures.set(page, fixture);
	requireRpcControl(page).setStubs({
		SessionDiffList: async ({ sessionId }) => {
			fixture.lists += 1;
			if (fixture.holdNext) {
				fixture.holdNext = false;
				const held = new Promise<void>((resolve) => {
					fixture.release = resolve;
				});
				fixture.replied = held;
				await held;
			}
			// The revision hashes the snapshot, so an unchanged folder re-lists the same one.
			return {
				revision: `rev-${sessionId}`,
				folders: [{ folder: "/workspace/myapp", files: fixture.files }],
			};
		},
		SessionDiffFile: ({ path, sessionId, revision }) => {
			fixture.requested.push(path);
			if (revision !== `rev-${sessionId}`) {
				fixture.foreign.push(`${sessionId} ${revision} ${path}`);
				throw new SessionDiffError({
					reason: "not-listed",
					message: "That file was not in this listing",
				});
			}
			if (fixture.gone.delete(path))
				throw new SessionDiffError({
					reason: "gone",
					message: "The listing is no longer available",
				});
			const file = fixture.files.find((entry) => entry.path === path);
			return {
				patch:
					file && "insertions" in file
						? patchFor(path, file.insertions, file.deletions)
						: "",
			};
		},
	});
	return fixture;
}

function requireFixture(page: Page): DiffFixture {
	const fixture = fixtures.get(page);
	if (!fixture) throw new Error("No session diff fixture was seeded");
	return fixture;
}

const row = (page: Page, path: string) =>
	page.locator(`[data-testid="session-diff-file"][data-path="${path}"]`);

export const sessionDiffHandlers: StepHandler[] = [
	{
		name: "seed diff tiers",
		match:
			/^the session has unstaged changes: (\S+) small, (\S+) long, (\S+) binary and (\S+) of ([0-9]+) bytes$/,
		run: async ({ world, match }) => {
			const [, small = "", long = "", binary = "", large = "", bytes = ""] =
				match;
			seed(
				world.page,
				[
					{
						path: binary,
						status: "added",
						before: null,
						after: "3333333333333333333333333333333333333333",
						bytes: 5120,
						tier: "auto",
						insertions: 0,
						deletions: 0,
						binary: true,
					} satisfies SessionDiffFile,
					{
						path: large,
						status: "added",
						before: null,
						after: "4444444444444444444444444444444444444444",
						bytes: Number(bytes),
						tier: "tooLarge",
					} satisfies SessionDiffFile,
					changed(small, 3, 1),
					changed(long, 640, 12),
				].sort((left, right) => left.path.localeCompare(right.path)),
			);
		},
	},
	{
		name: "seed many small diffs",
		match: /^the session has ([0-9]+) small unstaged files$/,
		run: async ({ world, match }) => {
			const count = Number(match[1]);
			seed(
				world.page,
				Array.from({ length: count }, (_, index) =>
					changed(`file-${String(index + 1).padStart(2, "0")}.ts`),
				),
			);
		},
	},
	{
		name: "first patch is gone",
		match: /^the first (\S+) patch is gone$/,
		run: async ({ world, match }) => {
			requireFixture(world.page).gone.add(match[1] ?? "");
		},
	},
	{
		name: "diff row order",
		match: /^the diff lists (\S+), (\S+), (\S+) and (\S+)$/,
		run: async ({ world, match }) => {
			await expect
				.poll(() =>
					world.page
						.locator('[data-testid="session-diff-file"]')
						.evaluateAll((rows) =>
							rows.map((element) => element.getAttribute("data-path")),
						),
				)
				.toEqual(match.slice(1, 5));
		},
	},
	{
		name: "diff shows patch",
		match: /^the (\S+) diff shows its patch$/,
		run: async ({ world, match }) => {
			const path = match[1] ?? "";
			await expect(
				row(world.page, path).getByText(`changed ${path}`),
			).toBeVisible();
		},
	},
	{
		name: "binary diff",
		match: /^the (\S+) diff is marked binary without a patch$/,
		run: async ({ world, match }) => {
			const path = match[1] ?? "";
			await expect(row(world.page, path)).toContainText("Binary");
			expect(requireFixture(world.page).requested).not.toContain(path);
		},
	},
	{
		name: "on-demand diff waits",
		match: /^the (\S+) diff waits for a click$/,
		run: async ({ world, match }) => {
			const path = match[1] ?? "";
			await expect(
				row(world.page, path).getByRole("button", { name: "Load diff" }),
			).toBeVisible();
			expect(requireFixture(world.page).requested).not.toContain(path);
		},
	},
	{
		name: "too-large diff",
		match: /^the (\S+) diff shows (.+) without a patch$/,
		run: async ({ world, match }) => {
			const path = match[1] ?? "";
			await expect(row(world.page, path)).toContainText(match[2] ?? "");
			await expect(
				row(world.page, path).getByRole("button", { name: "Open in Files" }),
			).toBeVisible();
			expect(requireFixture(world.page).requested).not.toContain(path);
		},
	},
	{
		name: "load on-demand diff",
		match: /^I load the (\S+) diff$/,
		run: async ({ world, match }) => {
			await row(world.page, match[1] ?? "")
				.getByRole("button", { name: "Load diff" })
				.click();
		},
	},
	{
		name: "open too-large diff in files",
		match: /^I open the (\S+) diff in Files$/,
		run: async ({ world, match }) => {
			await row(world.page, match[1] ?? "")
				.getByRole("button", { name: "Open in Files" })
				.click();
		},
	},
	{
		name: "file preview path",
		match: /^the file preview shows (\S+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.locator("#file-viewer-path")).toHaveText(
				match[1] ?? "",
			);
		},
	},
	{
		name: "patch not requested",
		match: /^the (\S+) patch has not been requested$/,
		run: async ({ world, match }) => {
			await expect(row(world.page, match[1] ?? "")).toHaveCount(1);
			expect(requireFixture(world.page).requested).not.toContain(match[1]);
		},
	},
	{
		name: "scroll diff to file",
		match: /^I scroll the diff to (\S+)$/,
		run: async ({ world, match }) => {
			await row(world.page, match[1] ?? "").scrollIntoViewIfNeeded();
		},
	},
	{
		name: "diff list count",
		match: /^the diff was listed ([0-9]+) times$/,
		run: async ({ world, match }) => {
			await expect
				.poll(() => requireFixture(world.page).lists)
				.toBe(Number(match[1]));
		},
	},
	{
		name: "hold next diff listing",
		match: /^the next diff listing is held$/,
		run: async ({ world }) => {
			requireFixture(world.page).holdNext = true;
		},
	},
	{
		name: "release held diff listing",
		match: /^the held diff listing lands$/,
		run: async ({ world }) => {
			const fixture = requireFixture(world.page);
			const frames = (count: number) =>
				world.page.evaluate(async (count) => {
					for (let frame = 0; frame < count; frame += 1)
						await new Promise((resolve) => requestAnimationFrame(resolve));
				}, count);
			// Visible rows observe and request their patch before the reply lands.
			await frames(2);
			await expect.poll(() => fixture.release !== null).toBe(true);
			fixture.release?.();
			fixture.release = null;
			await fixture.replied;
			// The mock sends the reply after the stub returns; one turn lets it go.
			await new Promise<void>((resolve) => setImmediate(resolve));
			// Routed frames and evaluate share one channel, so this runs after the reply.
			await frames(1);
		},
	},
	{
		name: "open session from the sidebar",
		match: /^I open the "([^"]+)" session$/,
		run: async ({ world, match }) => {
			const before = world.page.url();
			await world.page
				.locator("#session-list .session-item-title", {
					hasText: match[1] ?? "",
				})
				.click({ position: { x: 8, y: 6 } });
			await expect(world.page).not.toHaveURL(before);
		},
	},
	{
		name: "patches use their session's revision",
		match: /^every diff patch was requested with its own session's revision$/,
		run: async ({ world }) => {
			expect(requireFixture(world.page).foreign).toEqual([]);
		},
	},
	{
		name: "diff without error",
		match: /^the diff shows no error$/,
		run: async ({ world }) => {
			await expect(
				world.page.locator('[data-testid="session-diff-error"]'),
			).toHaveCount(0);
		},
	},
];
