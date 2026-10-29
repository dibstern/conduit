import { expect, type Page } from "@playwright/test";
import {
	type SessionDiffBase,
	SessionDiffError,
	type SessionDiffFile,
	type SessionDiffScope,
} from "../../../src/lib/contracts/session-diff.js";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

interface DiffFixture {
	readonly files: SessionDiffFile[];
	/** What the daemon resolves when no override is set. */
	base: SessionDiffBase;
	/** Every listing's scope, in order. */
	readonly scopes: SessionDiffScope[];
	/** Every SetSessionDiffBase payload's base, in order. */
	readonly setBases: (string | null)[];
	readonly requested: string[];
	/** Gone answers left per path. */
	readonly gone: Map<string, number>;
	/** Patch requests whose revision another session listed. */
	readonly foreign: string[];
	lists: number;
	holdList: boolean;
	holdPatch: string | null;
	release: (() => void) | null;
	replied: Promise<void> | null;
}

const fixtures = new WeakMap<Page, DiffFixture>();

/** Row observer callbacks a step parks, and the paths each one saw come into view. */
interface DiffObservations {
	hold: boolean;
	held: { seen: string[]; run: () => void }[];
}

/** Parks a stub until a step releases it. */
async function held(fixture: DiffFixture): Promise<void> {
	const reply = new Promise<void>((resolve) => {
		fixture.release = resolve;
	});
	fixture.replied = reply;
	await reply;
}

const frames = (page: Page, count: number) =>
	page.evaluate(async (count) => {
		for (let frame = 0; frame < count; frame += 1)
			await new Promise((resolve) => requestAnimationFrame(resolve));
	}, count);

/** Lets a reply the page already has go out and come back, so a count can be read as final. */
async function settle(page: Page): Promise<void> {
	await frames(page, 2);
	await new Promise<void>((resolve) => setImmediate(resolve));
	await frames(page, 2);
}

/** Polls a count to the expected value, then checks that it stays there. */
async function settledAt(page: Page, read: () => number, expected: number) {
	await expect.poll(read).toBe(expected);
	await settle(page);
	expect(read()).toBe(expected);
}

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
		base: { ref: "main", source: "default" },
		scopes: [],
		setBases: [],
		requested: [],
		gone: new Map(),
		foreign: [],
		lists: 0,
		holdList: false,
		holdPatch: null,
		release: null,
		replied: null,
	};
	fixtures.set(page, fixture);
	requireRpcControl(page).setStubs({
		SessionDiffList: async ({ sessionId, scope }) => {
			fixture.lists += 1;
			fixture.scopes.push(scope);
			if (fixture.holdList) {
				fixture.holdList = false;
				await held(fixture);
			}
			// The revision hashes the snapshot, so an unchanged folder re-lists the same one.
			return {
				revision: `rev-${sessionId}`,
				folders: [
					{
						folder: "/workspace/myapp",
						files: fixture.files,
						...(scope.kind === "branch"
							? {
									base:
										scope.base === null
											? fixture.base
											: { ref: scope.base, source: "override" as const },
								}
							: {}),
					},
				],
			};
		},
		// The daemon answers by publishing the session's row with its new base.
		SetSessionDiffBase: async ({ sessionId, base }) => {
			fixture.setBases.push(base);
			const rpc = requireRpcControl(page);
			const { diffBase: _, ...row } = (rpc.shellRows?.find(
				(candidate) => (candidate as { id?: string }).id === sessionId,
			) ?? {}) as Record<string, unknown>;
			rpc.upsertShellRow({
				...row,
				...(base === null ? {} : { diffBase: base }),
				id: sessionId,
			});
			return { ok: true };
		},
		SessionDiffFile: async ({ path, sessionId, revision }) => {
			fixture.requested.push(path);
			if (fixture.holdPatch === path) {
				fixture.holdPatch = null;
				await held(fixture);
			}
			if (revision !== `rev-${sessionId}`) {
				fixture.foreign.push(`${sessionId} ${revision} ${path}`);
				throw new SessionDiffError({
					reason: "not-listed",
					message: "That file was not in this listing",
				});
			}
			const gone = fixture.gone.get(path) ?? 0;
			fixture.gone.set(path, gone - 1);
			if (gone > 0)
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

const baseTrigger = (page: Page) =>
	page.locator('[data-testid="session-diff-base"]');

/** "automatic" names the null base: the launch base and its fallbacks. */
const named = (base: string) => (base === "automatic" ? null : base);

export const sessionDiffHandlers: StepHandler[] = [
	{
		name: "project branches",
		match: /^the project has branches (\S+) and (\S+)$/,
		run: async ({ world, match }) => {
			requireRpcControl(world.page).setStubs({
				ListBranches: async () => ({
					current: match[1] ?? "",
					branches: [match[1] ?? "", match[2] ?? ""],
				}),
			});
		},
	},
	{
		name: "diff base falls back",
		match:
			/^the diff base (\S+) is (missing|shallow|unrelated), so the diff falls back to (\S+)$/,
		run: async ({ world, match }) => {
			const [, wanted = "", reason, ref = ""] = match;
			requireFixture(world.page).base = {
				ref,
				source: ref === "HEAD" ? "head" : "default",
				fallback: {
					wanted,
					reason: reason as "missing" | "shallow" | "unrelated",
				},
			};
		},
	},
	{
		name: "pick diff base",
		match: /^I pick (\S+) as the diff base$/,
		run: async ({ world, match }) => {
			await baseTrigger(world.page).click();
			await world.page
				.getByRole("menuitemradio", { name: match[1] ?? "" })
				.click();
		},
	},
	{
		name: "diff compares against",
		match: /^the diff compares against (\S+)$/,
		run: async ({ world, match }) => {
			await expect(baseTrigger(world.page)).toHaveText(
				`against ${match[1] ?? ""}`,
			);
		},
	},
	{
		name: "diff base was set",
		match: /^the diff base was set to (\S+)$/,
		run: async ({ world, match }) => {
			await expect
				.poll(() => requireFixture(world.page).setBases.at(-1))
				.toBe(named(match[1] ?? ""));
		},
	},
	{
		name: "diff last listed against",
		match: /^the diff was last listed against (\S+)$/,
		run: async ({ world, match }) => {
			await expect
				.poll(() => requireFixture(world.page).scopes.at(-1))
				.toEqual({ kind: "branch", base: named(match[1] ?? "") });
		},
	},
	{
		name: "diff notice",
		match: /^the diff notice reads "(.+)"$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.locator('[data-testid="session-diff-base-notice"]'),
			).toHaveText(match[1] ?? "");
		},
	},
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
		name: "seed many diffs",
		// Long files wait for a click, so a shot of them never races highlighting.
		match: /^the session has ([0-9]+) (small|long) unstaged files$/,
		run: async ({ world, match }) => {
			const count = Number(match[1]);
			const lines = match[2] === "long" ? 600 : 1;
			seed(
				world.page,
				Array.from({ length: count }, (_, index) =>
					changed(`file-${String(index + 1).padStart(2, "0")}.ts`, lines),
				),
			);
		},
	},
	{
		name: "patch is gone",
		match: /^(the first|every) (\S+) patch is gone$/,
		run: async ({ world, match }) => {
			requireFixture(world.page).gone.set(
				match[2] ?? "",
				match[1] === "every" ? Number.POSITIVE_INFINITY : 1,
			);
		},
	},
	{
		name: "diff pair changes",
		match: /^the (\S+) pair changes$/,
		run: async ({ world, match }) => {
			const fixture = requireFixture(world.page);
			const index = fixture.files.findIndex((file) => file.path === match[1]);
			const file = fixture.files[index];
			if (!file) throw new Error(`No diff fixture file ${match[1]}`);
			fixture.files[index] = {
				...file,
				after: "5555555555555555555555555555555555555555",
			};
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
			const fixture = requireFixture(world.page);
			await settledAt(world.page, () => fixture.lists, Number(match[1]));
		},
	},
	{
		name: "patch request count",
		match: /^the (\S+) patch was requested ([0-9]+) times$/,
		run: async ({ world, match }) => {
			const fixture = requireFixture(world.page);
			const count = () =>
				fixture.requested.filter((path) => path === match[1]).length;
			await settledAt(world.page, count, Number(match[2]));
		},
	},
	{
		name: "diff row error",
		match: /^the (\S+) diff shows its error$/,
		run: async ({ world, match }) => {
			await expect(
				row(world.page, match[1] ?? "").getByTestId("session-diff-error"),
			).toHaveText("Could not load this diff.");
		},
	},
	{
		name: "hold next diff listing",
		match: /^the next diff listing is held$/,
		run: async ({ world }) => {
			requireFixture(world.page).holdList = true;
		},
	},
	{
		name: "hold next diff patch",
		match: /^the next (\S+) patch reply is held$/,
		run: async ({ world, match }) => {
			requireFixture(world.page).holdPatch = match[1] ?? "";
		},
	},
	{
		name: "release held diff reply",
		match: /^the held diff (?:listing|patch) lands$/,
		run: async ({ world }) => {
			const fixture = requireFixture(world.page);
			// Visible rows observe and request their patch before the reply lands.
			await frames(world.page, 2);
			await expect.poll(() => fixture.release !== null).toBe(true);
			fixture.release?.();
			fixture.release = null;
			await fixture.replied;
			// The mock sends the reply after the stub returns; one turn lets it go.
			await new Promise<void>((resolve) => setImmediate(resolve));
			// Routed frames and evaluate share one channel, so this runs after the reply.
			await frames(world.page, 1);
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
		name: "holdable row observations",
		match: /^row observations can be held$/,
		run: async ({ world }) => {
			// Rows build their observers when they mount, so this runs before the pane opens.
			await world.page.evaluate(() => {
				const native = window.IntersectionObserver;
				const observations: DiffObservations = { hold: false, held: [] };
				(
					window as unknown as { diffObservations: DiffObservations }
				).diffObservations = observations;
				window.IntersectionObserver = class extends native {
					constructor(
						callback: IntersectionObserverCallback,
						options?: IntersectionObserverInit,
					) {
						// No named arrows in here: tsx wraps them in a `__name` helper the page lacks.
						super((entries, observer) => {
							if (!observations.hold) return callback(entries, observer);
							observations.held.push({
								seen: entries
									.filter((entry) => entry.isIntersecting)
									.map((entry) => entry.target.getAttribute("data-path") ?? ""),
								run: callback.bind(undefined, entries, observer),
							});
						}, options);
					}
				};
			});
		},
	},
	{
		name: "hold row observations",
		match: /^row observations are held$/,
		run: async ({ world }) => {
			await world.page.evaluate(() => {
				(
					window as unknown as { diffObservations: DiffObservations }
				).diffObservations.hold = true;
			});
		},
	},
	{
		name: "row observation held",
		match: /^the (\S+) row was seen while observations are held$/,
		run: async ({ world, match }) => {
			await expect
				.poll(() =>
					world.page.evaluate(
						(path) =>
							(
								window as unknown as { diffObservations: DiffObservations }
							).diffObservations.held.some(({ seen }) => seen.includes(path)),
						match[1] ?? "",
					),
				)
				.toBe(true);
		},
	},
	{
		name: "release row observations",
		match: /^the held row observations land$/,
		run: async ({ world }) => {
			await world.page.evaluate(() => {
				const observations = (
					window as unknown as { diffObservations: DiffObservations }
				).diffObservations;
				observations.hold = false;
				for (const held of observations.held.splice(0)) held.run();
			});
			await settle(world.page);
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
