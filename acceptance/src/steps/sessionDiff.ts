import { expect, type Page } from "@playwright/test";
import { Effect, Stream } from "effect";
import {
	type SessionDiffBase,
	type SessionDiffEdit,
	SessionDiffEditError,
	SessionDiffError,
	type SessionDiffFile,
	type SessionDiffFolder,
	type SessionDiffListing,
	type SessionDiffPatch,
	type SessionDiffScope,
} from "../../../src/lib/contracts/session-diff.js";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

interface DiffFixture {
	/** The first folder's files, listed under `folder`; `others` list after it. */
	readonly files: SessionDiffFile[];
	/** Each folder lists every file. */
	readonly folders: readonly string[];
	/** What the daemon resolves when no override is set. */
	base: SessionDiffBase;
	/** Every listing's scope, in order. */
	readonly scopes: SessionDiffScope[];
	/** Every SetSessionDiffBase payload's base, in order. */
	readonly setBases: (string | null)[];
	/** Folders listed as given, after those that list every file. */
	readonly others: readonly SessionDiffFolder[];
	readonly notes: ReadonlyMap<string, SessionDiffPatch["notes"]>;
	readonly requested: string[];
	/** Gone answers left per path. */
	readonly gone: Map<string, number>;
	/** Patch requests whose revision another session listed. */
	readonly foreign: string[];
	lists: number;
	/** The revision each listing asked for, if any. */
	readonly asked: (string | undefined)[];
	/** Bumped by a pair change, so the listing's revision follows its content. */
	version: number;
	/** Live subscriptions opened, and the session the latest one is for. */
	subscriptions: number;
	live: string;
	/** Every discard and stage request, in order. */
	readonly edits: (Omit<SessionDiffEdit, "sessionId"> & {
		action: "discard" | "stage";
	})[];
	/** The session's agent is running, so every edit answers Busy. */
	busy: boolean;
	holdList: boolean;
	holdPatch: string | null;
	release: (() => void) | null;
	replied: Promise<void> | null;
}

const fixtures = new WeakMap<Page, DiffFixture>();
/** Lands a seeded turn's capture that is still recording. */
const captureLandings = new WeakMap<Page, () => void>();

/** How many RPC requests the page had sent when the last reveal was clicked. */
const revealMarks = new WeakMap<Page, number>();

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
export function patchFor(path: string, added = 1, removed = 1): string {
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

export const changed = (path: string, insertions = 1, deletions = 1) =>
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

const revisionOf = (fixture: DiffFixture, sessionId: string) =>
	`rev-${sessionId}#${fixture.version}`;

function seed(
	page: Page,
	files: SessionDiffFile[],
	{
		folders = ["/workspace/myapp"],
		others = [],
		notes = new Map(),
	}: Partial<Pick<DiffFixture, "folders" | "others" | "notes">> = {},
): DiffFixture {
	const fixture: DiffFixture = {
		files,
		folders,
		base: { ref: "main", source: "default", kind: "branch" },
		scopes: [],
		setBases: [],
		others,
		notes,
		requested: [],
		gone: new Map(),
		foreign: [],
		lists: 0,
		asked: [],
		version: 0,
		subscriptions: 0,
		live: "",
		edits: [],
		busy: false,
		holdList: false,
		holdPatch: null,
		release: null,
		replied: null,
	};
	fixtures.set(page, fixture);
	requireRpcControl(page).setStubs({
		SessionDiffList: async ({ sessionId, revision, scope }) => {
			// Settled turns in the transcript list their own scope; these steps count the pane's.
			if (scope.kind === "turn") return { revision: "turn", folders: [] };
			fixture.lists += 1;
			fixture.asked.push(revision);
			fixture.scopes.push(scope);
			// The revision hashes the snapshot, so an unchanged folder re-lists the same one.
			// A held listing answers with the snapshot taken when it was asked.
			const listing = {
				revision: revisionOf(fixture, sessionId),
				folders: [
					...fixture.folders.map((folder) => ({
						folder,
						files: [...fixture.files],
						...(scope.kind === "branch"
							? {
									base:
										scope.base === null
											? fixture.base
											: {
													ref: scope.base,
													source: "override" as const,
													kind: "branch" as const,
												},
								}
							: {}),
					})),
					...fixture.others,
				],
			};
			if (fixture.holdList) {
				fixture.holdList = false;
				await held(fixture);
			}
			return listing;
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
			if (!revision.startsWith(`rev-${sessionId}#`)) {
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
			const file = [
				fixture.files,
				...others.map((entry) => ("files" in entry ? entry.files : [])),
			]
				.flat()
				.find((entry) => entry.path === path);
			const patch =
				file && "insertions" in file
					? patchFor(path, file.insertions, file.deletions)
					: "";
			const fileNotes = notes.get(path);
			return fileNotes ? { patch, notes: fileNotes } : { patch };
		},
		SessionDiffDiscard: (request) => edit(page, fixture, "discard", request),
		SessionDiffStage: (request) => edit(page, fixture, "stage", request),
		// The server opens a live scope with its current revision.
		SubscribeSessionDiff: ({ sessionId }) => {
			fixture.subscriptions += 1;
			fixture.live = sessionId;
			return Stream.concat(
				Stream.succeed({ revision: revisionOf(fixture, sessionId) }),
				Stream.never,
			);
		},
	});
	return fixture;
}

/**
 * As the daemon: refuses while the agent runs or when the file is no longer
 * the blob the user saw; otherwise the file leaves the unstaged listing and
 * the new revision is pushed to the live scope.
 */
async function edit(
	page: Page,
	fixture: DiffFixture,
	action: "discard" | "stage",
	{
		sessionId: _,
		_tag: __,
		...request
	}: SessionDiffEdit & { readonly _tag: string },
) {
	fixture.edits.push({ action, ...request });
	if (fixture.busy)
		throw new SessionDiffEditError({
			reason: "busy",
			message: "The agent is running; wait for it to finish",
		});
	const index = fixture.files.findIndex(({ path }) => path === request.path);
	if (fixture.files[index]?.after !== request.expected)
		throw new SessionDiffEditError({
			reason: "stale",
			message: `${request.path} changed since it was listed`,
		});
	fixture.files.splice(index, 1);
	fixture.version += 1;
	requireRpcControl(page).sendChunk(
		"SubscribeSessionDiff",
		[{ revision: revisionOf(fixture, fixture.live) }],
		fixture.live,
	);
	return { ok: true as const };
}

function requireFixture(page: Page): DiffFixture {
	const fixture = fixtures.get(page);
	if (!fixture) throw new Error("No session diff fixture was seeded");
	return fixture;
}

/** Answers one turn's listing; every other turn and the pane list nothing. */
function seedTurn(
	page: Page,
	turnId: string,
	listing: Omit<SessionDiffListing, "revision">,
): void {
	requireRpcControl(page).setStubs({
		SessionDiffList: ({ scope }) => ({
			revision: "turn",
			folders: [],
			...(scope.kind === "turn" && scope.turnId === turnId && listing),
		}),
		SessionDiffFile: ({ path }) => ({ patch: patchFor(path) }),
	});
}

const turnFooter = (page: Page) =>
	page.locator("#messages .turn-activity").last().getByTestId("turn-show-bar");

const row = (page: Page, path: string) =>
	page.locator(`[data-testid="session-diff-file"][data-path="${path}"]`);

/** A row's header, which sits in the pane's view only while the row is scrolled to. */
const rowHeader = (page: Page, path: string) =>
	row(page, path).locator("header");

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
				kind: ref === "HEAD" ? "commit" : "branch",
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
		match:
			/^the session has ([0-9]+) (small|long) unstaged files(?: in each of (\S+) and (\S+))?$/,
		run: async ({ world, match }) => {
			const [, count = "", size, ...folders] = match;
			const lines = size === "long" ? 600 : 1;
			seed(
				world.page,
				Array.from({ length: Number(count) }, (_, index) =>
					changed(`file-${String(index + 1).padStart(2, "0")}.ts`, lines),
				),
				folders[0] && folders[1] ? { folders: [folders[0], folders[1]] } : {},
			);
		},
	},
	{
		name: "seed diff folders",
		match:
			/^the session diff has folders (\S+) with (\S+), (\S+) with (\S+), and (\S+) unavailable$/,
		run: async ({ world, match }) => {
			const [
				,
				first = "",
				firstPath = "",
				second = "",
				secondPath = "",
				gone = "",
			] = match;
			seed(world.page, [changed(firstPath)], {
				folders: [first],
				others: [
					{ folder: second, files: [changed(secondPath)] },
					{
						folder: gone,
						error: "unavailable",
						message: `Folder is missing: ${gone}`,
					},
				],
			});
		},
	},
	{
		name: "seed diff edge cases",
		match:
			/^the session has unstaged edge cases: submodule (\S+), LFS (\S+), symlink (\S+), mode change (\S+) from ([0-7]+) to ([0-7]+), rename (\S+) to (\S+), CRLF (\S+) and Latin-1 (\S+)$/,
		run: async ({ world, match }) => {
			const [
				,
				submodule = "",
				lfs = "",
				symlink = "",
				script = "",
				modeBefore = "",
				modeAfter = "",
				oldPath = "",
				moved = "",
				crlf = "",
				latin1 = "",
			] = match;
			const same = "7777777777777777777777777777777777777777";
			seed(
				world.page,
				(
					[
						{
							...changed(submodule),
							kind: "submodule",
							before: "5555555555555555555555555555555555555555",
							after: "6666666666666666666666666666666666666666",
							bytes: 0,
						},
						{ ...changed(lfs, 2, 2), kind: "lfs" },
						{ ...changed(symlink), kind: "symlink" },
						{
							...changed(script, 0, 0),
							before: same,
							after: same,
							mode: { before: modeBefore, after: modeAfter },
						},
						{
							...changed(moved, 0, 0),
							status: "renamed",
							oldPath,
							before: same,
							after: same,
						},
						changed(crlf),
						changed(latin1),
					] satisfies SessionDiffFile[]
				).sort((left, right) => left.path.localeCompare(right.path)),
				{
					notes: new Map([
						[crlf, ["crlf"]],
						[latin1, ["latin1"]],
					]),
				},
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
			fixture.version += 1;
		},
	},
	{
		name: "diff mode changes",
		match: /^the (\S+) mode changes from ([0-7]+) to ([0-7]+)$/,
		run: async ({ world, match }) => {
			const fixture = requireFixture(world.page);
			const index = fixture.files.findIndex((file) => file.path === match[1]);
			const file = fixture.files[index];
			if (!file) throw new Error(`No diff fixture file ${match[1]}`);
			fixture.files[index] = {
				...file,
				mode: { before: match[2] ?? "", after: match[3] ?? "" },
			};
			fixture.version += 1;
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
		name: "held diff listing asked",
		match: /^the held diff listing has been asked for$/,
		run: async ({ world }) => {
			const fixture = requireFixture(world.page);
			await expect.poll(() => fixture.release !== null).toBe(true);
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
		name: "seed a turn's captured changes",
		match:
			/^the (\S+) turn changed (\S+) and (\S+) in a (shared|private) folder$/,
		run: async ({ world, match }) => {
			const [, turnId = "", first = "", second = "", sharing] = match;
			seedTurn(world.page, turnId, {
				folders: [
					{
						folder: "/workspace/myapp",
						files: [changed(first, 3, 1), changed(second)],
						...(sharing === "shared" && { shared: true }),
					},
				],
			});
		},
	},
	{
		name: "seed an uncaptured turn",
		match: /^the (\S+) turn was not captured$/,
		run: async ({ world, match }) => {
			seedTurn(world.page, match[1] ?? "", { folders: [], notCaptured: true });
		},
	},
	{
		name: "seed a turn still being captured",
		match:
			/^the (\S+) turn is still being captured, then changes (\S+) and (\S+)$/,
		run: async ({ world, match }) => {
			const [, turnId = "", first = "", second = ""] = match;
			let landed = false;
			const landing = new Promise<void>((resolve) =>
				captureLandings.set(world.page, () => {
					landed = true;
					resolve();
				}),
			);
			const own = (scope: SessionDiffScope) =>
				scope.kind === "turn" && scope.turnId === turnId;
			// As the daemon: the turn lists pending, then its live scope pushes
			// the landed revision once the capture is recorded.
			requireRpcControl(world.page).setStubs({
				SessionDiffList: ({ scope }) =>
					!own(scope)
						? { revision: "turn", folders: [] }
						: landed
							? {
									revision: "landed",
									folders: [
										{
											folder: "/workspace/myapp",
											files: [changed(first, 3, 1), changed(second)],
										},
									],
								}
							: { revision: "pending", folders: [], pending: true },
				SessionDiffFile: ({ path }) => ({ patch: patchFor(path) }),
				SubscribeSessionDiff: ({ scope }) =>
					Stream.concat(
						own(scope)
							? Stream.concat(
									Stream.succeed({ revision: "pending" }),
									Stream.fromEffect(
										Effect.promise(() => landing).pipe(
											Effect.as({ revision: "landed" }),
										),
									),
								)
							: Stream.succeed({ revision: "turn" }),
						Stream.never,
					),
			});
		},
	},
	{
		name: "turn capture lands",
		match: /^the turn's capture lands$/,
		run: async ({ world }) => {
			const land = captureLandings.get(world.page);
			if (!land) throw new Error("No turn capture was seeded as pending");
			land();
		},
	},
	{
		name: "turn capture pending",
		match: /^the turn footer says its changes are being captured$/,
		run: async ({ world }) => {
			const footer = turnFooter(world.page);
			await expect(footer.getByTestId("turn-diff-pending")).toHaveText(
				"Capturing changes…",
			);
			await expect(footer.getByTestId("turn-diff-not-captured")).toHaveCount(0);
			await expect(footer.getByTestId("turn-diff-toggle")).toHaveCount(0);
		},
	},
	{
		name: "turn capture no longer pending",
		match: /^the turn footer has no pending note$/,
		run: async ({ world }) => {
			await expect(
				turnFooter(world.page).getByTestId("turn-diff-pending"),
			).toHaveCount(0);
		},
	},
	{
		name: "turn footer entry",
		match: /^the turn footer shows "([^"]+)"$/,
		run: async ({ world, match }) => {
			await expect(
				turnFooter(world.page).getByTestId("turn-diff-toggle"),
			).toHaveText(match[1] ?? "");
		},
	},
	{
		name: "open a turn's changed files",
		match: /^I open the turn's changed files$/,
		run: async ({ world }) => {
			const toggle = turnFooter(world.page).getByTestId("turn-diff-toggle");
			await toggle.click();
			await expect(toggle).toHaveAttribute("aria-expanded", "true");
		},
	},
	{
		name: "turn diff rows",
		match: /^the turn diff lists (\S+) and (\S+)$/,
		run: async ({ world, match }) => {
			const rows = turnFooter(world.page)
				.getByTestId("turn-diff")
				.getByTestId("session-diff-file");
			await expect(rows).toHaveCount(2);
			await expect(rows.first()).toHaveAttribute("data-path", match[1] ?? "");
			await expect(rows.last()).toHaveAttribute("data-path", match[2] ?? "");
			// A patch paints plain first and its highlighting lands later from a
			// worker, so wait for the highlighted tokens of each code file (a
			// pruned file has no patch).
			for (const [index, path] of [match[1], match[2]].entries())
				if (!path?.endsWith(".txt"))
					await expect(
						rows
							.nth(index)
							.locator(
								"span[style*='--diffs-token'], [data-testid='session-diff-pruned']",
							)
							.first(),
					).toBeVisible();
		},
	},
	{
		name: "turn diff shared label",
		match: /^the turn diff (is|is not) labelled as shared with other sessions$/,
		run: async ({ world, match }) => {
			const label = turnFooter(world.page).getByTestId("turn-diff-shared");
			await expect(label).toHaveCount(match[1] === "is" ? 1 : 0);
			if (match[1] === "is")
				await expect(label).toHaveText(
					"May include changes from other sessions",
				);
		},
	},
	{
		name: "turn not captured",
		match: /^the turn footer says Not captured$/,
		run: async ({ world }) => {
			const footer = turnFooter(world.page);
			await expect(footer.getByTestId("turn-diff-not-captured")).toContainText(
				"Not captured",
			);
			await expect(footer.getByTestId("turn-diff-toggle")).toHaveCount(0);
		},
	},
	{
		name: "seed a pruned turn",
		match:
			/^the (\S+) turn changed (\S+) by (\d+) and (\d+) lines and (\S+), then was pruned$/,
		run: async ({ world, match }) => {
			const [, turnId = "", first = "", insertions, deletions, second = ""] =
				match;
			const pruned = (path: string, counts: number[]) => {
				const { bytes: _bytes, binary: _binary, ...file } = changed(path);
				return {
					...file,
					tier: "pruned" as const,
					insertions: counts[0],
					deletions: counts[1],
				};
			};
			seedTurn(world.page, turnId, {
				folders: [
					{
						folder: "/workspace/myapp",
						files: [
							pruned(first, [Number(insertions), Number(deletions)]),
							pruned(second, [1, 1]),
						],
					},
				],
				pruned: true,
			});
		},
	},
	{
		name: "turn pruned",
		match: /^the turn footer says Pruned$/,
		run: async ({ world }) => {
			await expect(
				turnFooter(world.page).getByTestId("turn-diff-pruned"),
			).toHaveText("Pruned");
		},
	},
	{
		name: "pruned turn row",
		match: /^the (\S+) diff is marked Pruned with \+(\d+) −(\d+) and no patch$/,
		run: async ({ world, match }) => {
			const [, path = "", insertions, deletions] = match;
			const file = turnFooter(world.page)
				.getByTestId("turn-diff")
				.locator(`[data-testid="session-diff-file"][data-path="${path}"]`);
			await expect(file.getByTestId("session-diff-pruned")).toHaveText(
				"Pruned",
			);
			for (const count of [`+${insertions}`, `−${deletions}`])
				await expect(file.locator("header")).toContainText(count);
			await expect(file).toContainText("removed to keep snapshots");
			await expect(file.getByText(`changed ${path}`)).toHaveCount(0);
		},
	},
	{
		name: "open the branch diff from a turn",
		match: /^I open the branch diff from the turn footer$/,
		run: async ({ world }) => {
			await turnFooter(world.page)
				.getByRole("button", { name: "Branch diff", exact: true })
				.click();
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
		name: "diff live",
		match: /^the diff is (live|not live)$/,
		run: async ({ world, match }) => {
			const fixture = requireFixture(world.page);
			const rpc = requireRpcControl(world.page);
			await expect
				.poll(() => rpc.hasStream("SubscribeSessionDiff", fixture.live))
				.toBe(match[1] === "live");
		},
	},
	{
		name: "push diff revision",
		match: /^the diff's current revision is pushed$/,
		run: async ({ world }) => {
			const fixture = requireFixture(world.page);
			requireRpcControl(world.page).sendChunk(
				"SubscribeSessionDiff",
				[{ revision: revisionOf(fixture, fixture.live) }],
				fixture.live,
			);
		},
	},
	{
		name: "listing pinned to pushed revision",
		match: /^the last diff listing asked for the pushed revision$/,
		run: async ({ world }) => {
			const fixture = requireFixture(world.page);
			expect(fixture.asked.at(-1)).toBe(revisionOf(fixture, fixture.live));
		},
	},
	{
		name: "reconnect diff subscription",
		match: /^the connection drops and the diff subscribes again$/,
		run: async ({ world }) => {
			const fixture = requireFixture(world.page);
			const opened = fixture.subscriptions;
			requireRpcControl(world.page).closeSockets();
			await expect.poll(() => fixture.subscriptions).toBe(opened + 1);
		},
	},
	{
		name: "diff folder group",
		match:
			/^the (\S+) diff group is headed (\S+) and (?:lists (\S+)|shows "([^"]+)")$/,
		run: async ({ world, match }) => {
			const [, folder = "", name = "", path, error] = match;
			const group = world.page.locator(
				`[data-testid="session-diff-folder"][data-folder="${folder}"]`,
			);
			const rows = group.locator('[data-testid="session-diff-file"]');
			const errors = group.locator('[data-testid="session-diff-error"]');
			await expect(group.getByRole("heading")).toHaveText(name);
			if (path === undefined) {
				await expect(errors).toHaveText(error ?? "");
				await expect(rows).toHaveCount(0);
			} else {
				await expect(rows).toHaveAttribute("data-path", path);
				await expect(errors).toHaveCount(0);
			}
		},
	},
	{
		name: "diff row label",
		match: /^the (\S+) diff is labelled "([^"]+)"$/,
		run: async ({ world, match }) => {
			await expect(
				row(world.page, match[1] ?? "").getByTestId("session-diff-label"),
			).toHaveText(match[2] ?? "");
		},
	},
	{
		name: "patchless diff row",
		match: /^the (\S+) diff reads "([^"]+)" without a patch$/,
		run: async ({ world, match }) => {
			const path = match[1] ?? "";
			await expect(row(world.page, path)).toContainText(match[2] ?? "");
			await settle(world.page);
			expect(requireFixture(world.page).requested).not.toContain(path);
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
	{
		name: "preview diff file in files",
		match: /^I preview (\S+) in Files$/,
		run: async ({ world, match }) => {
			const { page } = world;
			const entries = requireFixture(page).files.map(({ path }) => path);
			requireRpcControl(page).setStubs({
				GetFileTree: () => ({ projectSlug: "myapp", entries }),
				GetFileList: ({ path = "." }) => ({
					projectSlug: "myapp",
					path,
					entries: entries.map((name) => ({ name, type: "file", size: 12 })),
				}),
				GetFileContent: ({ path = "" }) => ({
					projectSlug: "myapp",
					path,
					content: `// ${path}\n`,
				}),
			});
			const pane = page.locator("#right-pane");
			if (await pane.isVisible())
				await pane.getByRole("tab", { name: "Files", exact: true }).click();
			else await page.getByTestId("views-rail-files").click();
			const browser = pane.getByRole("button", { name: "File browser" });
			if (await browser.isVisible()) await browser.click();
			await pane.locator(".fb-entry", { hasText: match[1] ?? "" }).click();
			await expect(page.locator("#file-viewer-path")).toHaveText(
				match[1] ?? "",
			);
		},
	},
	{
		name: "reveal previewed file diff",
		match: /^I open the previewed file's diff$/,
		run: async ({ world }) => {
			const { page } = world;
			revealMarks.set(page, requireRpcControl(page).getRequests().length);
			await page
				.locator("#file-viewer")
				.getByRole("button", { name: "Show diff" })
				.click();
		},
	},
	{
		name: "open diff link",
		match: /^I open the diff link for (\S+) in (?:the (\S+) scope|(\S+))$/,
		run: async ({ world, match }) => {
			const [, path = "", scope, folder] = match;
			const url = new URL(world.page.url());
			url.searchParams.set("diffPath", path);
			url.searchParams.set("diffReveal", "link");
			if (scope) url.searchParams.set("diff", scope);
			if (folder) url.searchParams.set("diffFolder", folder);
			await world.page.goto(url.toString());
		},
	},
	{
		name: "diff revealed",
		match: /^the (\S+) diff is revealed$/,
		run: async ({ world, match }) => {
			await expect(rowHeader(world.page, match[1] ?? "")).toBeInViewport();
		},
	},
	{
		name: "diff revealed in folder",
		match: /^the (\S+) diff in (\S+) is (revealed|out of view)$/,
		run: async ({ world, match }) => {
			const [, path = "", folder = "", seen] = match;
			const header = row(world.page, path)
				.and(world.page.locator(`[data-folder="${folder}"]`))
				.locator("header");
			if (seen === "revealed") await expect(header).toBeInViewport();
			else await expect(header).not.toBeInViewport();
		},
	},
	{
		name: "diff out of view",
		match: /^the (\S+) diff is out of view$/,
		run: async ({ world, match }) => {
			await expect(rowHeader(world.page, match[1] ?? "")).not.toBeInViewport();
		},
	},
	{
		name: "diff selection in url",
		match: /^the URL holds the (\S+) diff selection$/,
		run: async ({ world, match }) => {
			await expect
				.poll(() => {
					const params = new URL(world.page.url()).searchParams;
					return {
						path: params.get("diffPath"),
						reveal: Boolean(params.get("diffReveal")),
						scope: params.get("diff"),
					};
				})
				.toEqual({ path: match[1], reveal: true, scope: null });
		},
	},
	{
		name: "reveal stays on this device",
		match: /^revealing the diff sent the daemon only diff reads$/,
		run: async ({ world }) => {
			const { page } = world;
			await settle(page);
			const tags = requireRpcControl(page)
				.getRequests()
				.slice(revealMarks.get(page))
				.map(({ tag }) => tag);
			expect(
				tags.filter(
					(tag) =>
						tag !== "SessionDiffList" &&
						tag !== "SessionDiffFile" &&
						tag !== "SubscribeSessionDiff",
				),
			).toEqual([]);
		},
	},
	{
		name: "agent running for diff edits",
		match: /^the agent is running in the session whose diff is shown$/,
		run: async ({ world }) => {
			requireFixture(world.page).busy = true;
		},
	},
	{
		name: "diff offers edits",
		match: /^the (\S+) diff offers Stage and Discard$/,
		run: async ({ world, match }) => {
			const actions = rowHeader(world.page, match[1] ?? "");
			for (const name of ["Stage", "Discard"])
				await expect(
					actions.getByRole("button", { name, exact: true }),
				).toBeVisible();
			await expect(
				actions.getByRole("button", { name: "Confirm discard" }),
			).toHaveCount(0);
		},
	},
	{
		name: "press diff edit",
		match:
			/^I press (Stage|Discard|Stage hunk|Discard hunk|Confirm discard|Cancel) on the (\S+) diff$/,
		run: async ({ world, match }) => {
			await row(world.page, match[2] ?? "")
				.getByRole("button", { name: match[1] ?? "", exact: true })
				.first()
				.click();
		},
	},
	{
		name: "diff discard confirms",
		match: /^the (\S+) diff asks to confirm the discard$/,
		run: async ({ world, match }) => {
			const header = rowHeader(world.page, match[1] ?? "");
			await expect(
				header.getByRole("button", { name: "Confirm discard" }),
			).toBeVisible();
			await expect(
				header.getByRole("button", { name: "Discard", exact: true }),
			).toHaveCount(0);
		},
	},
	{
		name: "no diff edit",
		match: /^no diff edit was sent( after the first)?$/,
		run: async ({ world, match }) => {
			await settle(world.page);
			expect(requireFixture(world.page).edits).toHaveLength(match[1] ? 1 : 0);
		},
	},
	{
		name: "diff edit sent",
		match:
			/^the daemon was asked to (discard|stage) (?:hunk ([0-9]+) of )?(\S+) as the blob it listed$/,
		run: async ({ world, match }) => {
			const [, action, hunk, path] = match;
			const fixture = requireFixture(world.page);
			await expect.poll(() => fixture.edits.at(-1)?.path).toBe(path);
			const listed = changed(path ?? "");
			expect(fixture.edits.at(-1)).toEqual({
				action,
				folder: "/workspace/myapp",
				path,
				expected: listed.after,
				...(hunk === undefined
					? {}
					: {
							hunk: {
								revision: revisionOf(fixture, fixture.live).replace(
									/#[0-9]+$/,
									`#${fixture.version - 1}`,
								),
								before: listed.before,
								index: Number(hunk),
							},
						}),
			});
		},
	},
	{
		name: "diff no longer listed",
		match: /^the (\S+) diff is no longer listed$/,
		run: async ({ world, match }) => {
			await expect(row(world.page, match[1] ?? "")).toHaveCount(0);
		},
	},
	{
		name: "browser back",
		match: /^I go back in the browser$/,
		run: async ({ world }) => {
			await world.page.goBack();
		},
	},
];
