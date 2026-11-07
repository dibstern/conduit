import { expect, type Page } from "@playwright/test";
import {
	FilesRefused,
	SessionBusy,
} from "../../../src/lib/contracts/limit-recovery.js";
import type {
	HeadLogEntry,
	MoveIntent,
	ResumePlan,
} from "../../../src/lib/contracts/ws-rpc.js";
import type { HistoryMessage } from "../../../src/lib/shared-types.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import {
	openSessionRoute,
	requireRelayControl,
	requireRpcControl,
} from "./shared.js";

const sessionId = "sess-head-moves";
const at = PINNED_CLOCK_MS - 600_000;

/** What the mock server answers for this page's head moves. */
type Scene = {
	pruned: boolean;
	image: boolean;
	/** The paths a rewind with files would change. */
	changes: string[];
	/** Another session that ran in a folder since, which keeps the files. */
	other: { title: string; folder: string } | undefined;
	log: HeadLogEntry[];
};
const scenes = new WeakMap<Page, Scene>();
const scene = (page: Page): Scene => {
	const existing = scenes.get(page);
	if (existing) return existing;
	const fresh: Scene = {
		pruned: false,
		image: false,
		changes: [],
		other: undefined,
		log: [
			{
				moveId: "move-2",
				kind: "rewind",
				at: at + 60_000,
				messageId: "hm-user-2",
				resend: "Add a FAQ section",
				landed: true,
			},
			{
				moveId: "move-1",
				kind: "rewind",
				at,
				messageId: "hm-user-2",
				landed: true,
			},
		],
	};
	scenes.set(page, fresh);
	return fresh;
};

const exchange = (
	n: number,
	prompt: string,
	reply: string,
	image: boolean,
): HistoryMessage[] => [
	{
		id: `hm-user-${n}`,
		role: "user",
		time: { created: at + n * 10_000 },
		parts: [
			{ id: `hm-user-${n}-text`, type: "text", text: prompt },
			...(image
				? [
						{
							id: `hm-user-${n}-image`,
							type: "file" as const,
							mime: "image/png",
							filename: "notes.png",
							source: { url: "/missing-notes.png" },
						},
					]
				: []),
		],
	},
	{
		id: `hm-reply-${n}`,
		parentID: `hm-user-${n}`,
		role: "assistant",
		time: {
			created: at + n * 10_000 + 1_000,
			completed: at + n * 10_000 + 2_000,
		},
		parts: [{ id: `hm-reply-${n}-text`, type: "text", text: reply }],
	},
];

const reply = (page: Page, n: number) =>
	page.locator("#messages .msg-assistant").nth(n - 1);

async function openMessageMenu(page: Page, n: number): Promise<void> {
	const target = reply(page, n);
	await target.hover();
	await target.getByRole("button", { name: "More message actions" }).click();
}

async function expectMove(page: Page, intent: MoveIntent): Promise<void> {
	const rpc = requireRpcControl(page);
	const commit = await rpc.waitForRequest(
		(request) => request.tag === "CommitHeadMove",
	);
	expect(commit.payload).toMatchObject({ sessionId, intent });
	const preview = rpc
		.getRequests()
		.find((request) => request.tag === "PreviewHeadMove");
	expect(preview?.payload).toMatchObject({ sessionId, intent });
	// The commit carries the id the preview answered, which both devices share.
	expect(commit.payload["moveId"]).toBe(`preview-${JSON.stringify(intent)}`);
}

const headLog = (page: Page) => page.getByTestId("head-log");
const rewindDialog = (page: Page) =>
	page.getByRole("dialog", { name: "Rewind to this point?" });
const entry = (page: Page, text: string) =>
	headLog(page).getByTestId("head-log-entry").filter({ hasText: text });

export const headMovesHandlers: StepHandler[] = [
	{
		name: "a conversation that branched at its second message is open",
		match: /^a branched conversation is open$/,
		run: async ({ world }) => {
			const page = world.page;
			const state = scene(page);
			const rpc = requireRpcControl(page);
			const row = {
				id: sessionId,
				title: "Release notes",
				accountId: "claude",
				model: { provider: "claude", model: "claude-sonnet-4-5" },
				status: "idle",
				messageCount: 4,
				updatedAt: PINNED_CLOCK_MS,
			};
			rpc.setStubs({
				GetHeadLog: () => ({ entries: state.log }),
				GetHeadBranches: () => ({
					forks: [
						{
							messageId: "hm-user-2",
							branches: [
								{
									tip: "node-migration",
									text: "Add a migration section",
									onHead: true,
									available: true,
								},
								{
									tip: "node-faq",
									text: "Add a FAQ section",
									onHead: false,
									available: true,
								},
								{
									tip: "node-changelog",
									text: "Add a changelog",
									onHead: false,
									available: false,
								},
							],
						},
					],
				}),
				PreviewHeadMove: ({ intent }) => {
					if (intent.withFiles && state.pruned)
						throw new FilesRefused({ sessionId, reason: "pruned" });
					if (intent.withFiles && state.other)
						throw new FilesRefused({
							sessionId,
							reason: "other_session",
							directory: state.other.folder,
							other: {
								sessionId: "sess-other",
								title: state.other.title,
								running: false,
							},
						});
					// The planner's landing: a rewind keeps up to the reply before its turn.
					const turn =
						intent._tag === "rewind"
							? Number(intent.messageId.replace(/^hm-\w+-/, ""))
							: 0;
					return {
						moveId: `preview-${JSON.stringify(intent)}`,
						files: state.pruned ? "pruned" : "available",
						...(turn > 1 ? { branchFrom: `hm-reply-${turn - 1}` } : {}),
						...(intent.withFiles
							? {
									restore: {
										folders: [
											{
												directory: "/work/notes",
												changes: state.changes.map((path) => ({
													path,
													change: "modified" as const,
												})),
											},
										],
									},
								}
							: {}),
					};
				},
				ForkSession: (payload) => ({
					projectSlug: "myapp",
					sessionId: `${sessionId}-fork`,
					forkedFrom: "sessionId" in payload ? payload.sessionId : "",
				}),
				CommitHeadMove: ({ intent, moveId }) => {
					if (intent._tag === "undo")
						state.log = [
							{
								moveId,
								kind: "undo",
								at: PINNED_CLOCK_MS,
								undoes: intent.moveId,
								landed: true,
							},
							...state.log,
						];
					return { moveId };
				},
			});
			rpc.upsertShellRow(row);
			rpc.setFamilyRows([row]);
			requireRelayControl(page).sendMessage({
				type: "mock_transcript_snapshot",
				sessionId,
				history: {
					hasMore: false,
					messages: [
						...exchange(
							1,
							"Draft the release notes",
							"Here is a first draft.",
							state.image,
						),
						...exchange(
							2,
							"Add a migration section",
							"Added a migration section.",
							false,
						),
					],
				},
			});
			await openSessionRoute(page, sessionId);
			await expect(page.locator("#messages .msg-assistant")).toHaveCount(2);
		},
	},
	{
		name: "a move is still landing",
		match: /^the newest head move is still landing$/,
		run: ({ world }) => {
			const state = scene(world.page);
			state.log = [
				{
					moveId: "move-3",
					kind: "switch",
					at: PINNED_CLOCK_MS,
					landed: false,
				},
				...state.log,
			];
		},
	},
	{
		name: "the files at the targets were pruned",
		match: /^the files at every move's target were pruned$/,
		run: ({ world }) => {
			scene(world.page).pruned = true;
		},
	},
	{
		// The page still shows the session idle; the server refuses the move (82tn.51).
		name: "a turn started on another device",
		match: /^another device has started a turn in the conversation$/,
		run: ({ world }) => {
			requireRpcControl(world.page).setStubs({
				PreviewHeadMove: () => {
					throw new SessionBusy({
						sessionId,
						command: "head_move",
						reason: "run_active",
					});
				},
			});
		},
	},
	{
		// The preview read the files kept; an eviction lands before the commit (f02e9.13).
		name: "the files are pruned before the commit",
		match: /^the files there are pruned before the move is confirmed$/,
		run: ({ world }) => {
			requireRpcControl(world.page).setStubs({
				CommitHeadMove: () => {
					throw new FilesRefused({ sessionId, reason: "pruned" });
				},
			});
		},
	},
	{
		name: "a rewind with files would change paths",
		match: /^a rewind there would change (.+) and (.+)$/,
		run: ({ world, match }) => {
			scene(world.page).changes = [match[1] ?? "", match[2] ?? ""];
		},
	},
	{
		name: "another session ran in the folder",
		match: /^the session (.+) has run in (.+) since$/,
		run: ({ world, match }) => {
			scene(world.page).other = {
				title: match[1] ?? "",
				folder: match[2] ?? "",
			};
		},
	},
	{
		name: "pick the message to rewind to",
		match: /^I pick the message (.+) to rewind to$/,
		run: async ({ world, match }) => {
			await expect(headLog(world.page)).toBeHidden();
			await world.page
				.locator("#messages .msg-user")
				.filter({ hasText: match[1] ?? "" })
				// The message text: its header holds the branch switcher.
				.getByText(match[1] ?? "", { exact: true })
				.click();
			await expect(rewindDialog(world.page)).toBeVisible();
		},
	},
	{
		name: "pick the reply to rewind to",
		match: /^I pick the reply (.+) to rewind to$/,
		run: async ({ world, match }) => {
			await expect(headLog(world.page)).toBeHidden();
			await world.page
				.locator("#messages .msg-assistant")
				.getByText(match[1] ?? "", { exact: true })
				.click();
			await expect(rewindDialog(world.page)).toBeVisible();
		},
	},
	{
		name: "the rewind dialog lists the paths that change",
		match: /^the rewind dialog lists (.+) and (.+) as changing$/,
		run: async ({ world, match }) => {
			const paths = rewindDialog(world.page).getByRole("list", {
				name: "Files that change",
			});
			await expect(paths.getByRole("listitem")).toHaveCount(2);
			await expect(paths).toContainText(match[1] ?? "");
			await expect(paths).toContainText(match[2] ?? "");
		},
	},
	{
		name: "rewinding the files is unavailable, with the reason",
		match: /^rewinding the files is unavailable because (.+)$/,
		run: async ({ world, match }) => {
			const files = rewindDialog(world.page).getByRole("button", {
				name: "Rewind conversation and files",
			});
			await expect(files).toBeDisabled();
			// A screen reader hears the reason with the control.
			await expect(files).toHaveAccessibleDescription(match[1] ?? "");
			await expect(rewindDialog(world.page).getByRole("status")).toHaveText(
				match[1] ?? "",
			);
		},
	},
	{
		name: "rewind the conversation and files",
		match: /^I choose to rewind the conversation and files$/,
		run: async ({ world }) => {
			await rewindDialog(world.page)
				.getByRole("button", { name: "Rewind conversation and files" })
				.click();
		},
	},
	{
		name: "rewind the conversation only",
		match: /^I choose to rewind the conversation only$/,
		run: async ({ world }) => {
			await rewindDialog(world.page)
				.getByRole("button", { name: "Conversation only" })
				.click();
		},
	},
	{
		name: "the conversation moves with a rewind with files",
		match: /^the conversation moves with a rewind before (\S+) with files$/,
		run: async ({ world, match }) => {
			await expectMove(world.page, {
				_tag: "rewind",
				messageId: match[1] ?? "",
				withFiles: true,
			});
		},
	},
	{
		name: "branch into a worktree",
		match: /^I choose to branch into a worktree$/,
		run: async ({ world }) => {
			await rewindDialog(world.page)
				.getByRole("button", { name: "Branch into a worktree" })
				.click();
		},
	},
	{
		name: "branching into a worktree is not offered",
		match: /^branching into a worktree is not offered$/,
		run: async ({ world }) => {
			await expect(
				rewindDialog(world.page).getByRole("button", {
					name: "Branch into a worktree",
				}),
			).toHaveCount(0);
		},
	},
	{
		// 82tn.54: the files go into a new worktree, and the conversation stays where it is.
		name: "one fork with files keeps the conversation up to a message",
		match: /^one fork with files keeps the conversation up to (\S+)$/,
		run: async ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			const fork = await rpc.waitForRequest(
				(request) => request.tag === "ForkSession",
			);
			expect(fork.payload).toMatchObject({
				sessionId,
				messageId: match[1] ?? "",
				files: true,
			});
			expect(
				rpc.getRequests().filter((request) => request.tag === "ForkSession"),
			).toHaveLength(1);
		},
	},
	{
		name: "the fork is open",
		match: /^the fork (\S+) is open$/,
		run: async ({ world, match }) => {
			await expect(world.page).toHaveURL(
				new RegExp(`/s/${match[1] ?? ""}(?:[/?]|$)`),
			);
		},
	},
	{
		name: "the conversation did not move",
		match: /^the conversation did not move$/,
		run: ({ world }) => {
			const tags = requireRpcControl(world.page)
				.getRequests()
				.map((request) => request.tag);
			expect(tags).toContain("PreviewHeadMove");
			expect(tags).not.toContain("CommitHeadMove");
		},
	},
	{
		name: "the conversation moves with a rewind",
		match: /^the conversation moves with a rewind before (\S+)$/,
		run: async ({ world, match }) => {
			await expectMove(world.page, {
				_tag: "rewind",
				messageId: match[1] ?? "",
			});
		},
	},
	{
		name: "the first message carried an image",
		match: /^the first message carried an image$/,
		run: ({ world }) => {
			scene(world.page).image = true;
		},
	},
	{
		name: "open the head log from a reply's message menu",
		match: /^I open the head log from the first reply's message menu$/,
		run: async ({ world }) => {
			await openMessageMenu(world.page, 1);
			await world.page
				.getByRole("menuitem", { name: "Rewind and undo…" })
				.click();
			await expect(headLog(world.page)).toBeVisible();
		},
	},
	{
		name: "the head log lists entries newest first",
		match: /^the head log lists (.+) then (.+)$/,
		run: async ({ world, match }) => {
			const entries = headLog(world.page).getByTestId("head-log-entry");
			await expect(entries.nth(0)).toContainText(match[1] ?? "");
			await expect(entries.nth(1)).toContainText(match[2] ?? "");
		},
	},
	{
		name: "undo a head log entry",
		match: /^I undo the head log entry (.+)$/,
		run: async ({ world, match }) => {
			await entry(world.page, match[1] ?? "")
				.getByRole("button", { name: "Undo" })
				.click();
		},
	},
	{
		name: "an entry still landing cannot be undone",
		match: /^the head log entry (.+) cannot be undone yet$/,
		run: async ({ world, match }) => {
			await expect(
				entry(world.page, match[1] ?? "").getByRole("button", { name: "Undo" }),
			).toBeDisabled();
		},
	},
	{
		name: "rewind from the head log",
		match: /^I choose to rewind to a message from the head log$/,
		run: async ({ world }) => {
			await headLog(world.page)
				.getByRole("button", { name: "Rewind to a message" })
				.click();
		},
	},
	{
		name: "the head log is closed",
		match: /^the head log is closed$/,
		run: async ({ world }) => {
			await expect(headLog(world.page)).toBeHidden();
		},
	},
	{
		name: "the rewind banner text",
		match: /^the rewind banner reads (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.locator(".rewind-banner-text")).toHaveText(
				match[1] ?? "",
			);
		},
	},
	{
		name: "the branch switcher sits only on the branched message",
		match: /^only the message (.+) carries a branch switcher reading (.+)$/,
		run: async ({ world, match }) => {
			const switchers = world.page.getByTestId("branch-switcher");
			await expect(switchers).toHaveCount(1);
			await expect(switchers).toHaveText(match[2] ?? "");
			await expect(
				world.page
					.locator("#messages .msg-user")
					.filter({ hasText: match[1] ?? "" })
					.getByTestId("branch-switcher"),
			).toHaveCount(1);
		},
	},
	{
		name: "open the branch switcher",
		match: /^I open the branch switcher$/,
		run: async ({ world }) => {
			await world.page.getByTestId("branch-switcher").click();
		},
	},
	{
		name: "an unavailable branch cannot be picked",
		match: /^the branch (.+) is unavailable and cannot be picked$/,
		run: async ({ world, match }) => {
			const item = world.page
				.getByRole("menuitem")
				.filter({ hasText: match[1] ?? "" });
			await expect(item).toContainText("unavailable");
			await expect(item).toHaveAttribute("aria-disabled", "true");
		},
	},
	{
		name: "pick a branch",
		match: /^I pick the branch (.+)$/,
		run: async ({ world, match }) => {
			await world.page
				.getByRole("menuitem")
				.filter({ hasText: match[1] ?? "" })
				// The message text: its header holds the branch switcher.
				.getByText(match[1] ?? "", { exact: true })
				.click();
		},
	},
	{
		name: "the conversation moves with an undo",
		match: /^the conversation moves with undo of (.+)$/,
		run: async ({ world, match }) => {
			await expectMove(world.page, { _tag: "undo", moveId: match[1] ?? "" });
		},
	},
	{
		name: "the conversation moves with a switch",
		match: /^the conversation moves with a switch to (.+)$/,
		run: async ({ world, match }) => {
			await expectMove(world.page, { _tag: "switch", nodeId: match[1] ?? "" });
		},
	},
	{
		name: "the conversation moves with a rewind and a resend",
		match: /^the conversation moves with a rewind before (\S+) resending (.+)$/,
		run: async ({ world, match }) => {
			await expectMove(world.page, {
				_tag: "rewind",
				messageId: match[1] ?? "",
				resend: match[2] ?? "",
			});
		},
	},
	{
		name: "edit and resend a message",
		match: /^I edit the message (.+) to (.+) and send it$/,
		run: async ({ world, match }) => {
			const message = world.page
				.locator("#messages .msg-user")
				.filter({ hasText: match[1] ?? "" });
			await message.hover();
			await message.getByRole("button", { name: "Edit message" }).click();
			// The message's text becomes the edit box's value, so find the box, not the text.
			const edit = world.page.getByTestId("user-message-edit");
			await edit
				.getByRole("textbox", { name: "Edit message" })
				.fill(match[2] ?? "");
			await edit.getByRole("button", { name: "Send" }).click();
		},
	},
	{
		name: "the edit box keeps the draft",
		match: /^the edit box still holds (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page
					.getByTestId("user-message-edit")
					.getByRole("textbox", { name: "Edit message" }),
			).toHaveValue(match[1] ?? "");
		},
	},
	{
		name: "no plain send",
		match: /^no message was sent outside the move$/,
		run: async ({ world }) => {
			const rpc = requireRpcControl(world.page);
			await rpc.waitForRequest((request) => request.tag === "CommitHeadMove");
			expect(
				rpc.getRequests().filter((request) => request.tag === "input.submit"),
			).toHaveLength(0);
		},
	},
	{
		name: "regenerate a reply",
		match: /^I regenerate the reply from the message menu of reply (\d+)$/,
		run: async ({ world, match }) => {
			await openMessageMenu(world.page, Number(match[1]));
			await world.page.getByRole("menuitem", { name: "Regenerate" }).click();
		},
	},
	{
		name: "the daemon plans how the next message continues",
		match: /^the next message continues by (native|catch_up|handoff|refused)$/,
		run: ({ world, match }) => {
			const plan = match[1] as ResumePlan;
			requireRpcControl(world.page).setStubs({
				GetResumePlan: () => ({ plan }),
			});
		},
	},
	{
		name: "the composer says how the next message continues",
		match: /^the composer says the next message (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("composer-resume-plan")).toHaveText(
				`Next message: ${match[1] ?? ""}`,
			);
		},
	},
	{
		name: "a notice toast says",
		match: /^a notice says (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId("toast").filter({ hasText: match[1] ?? "" }),
			).toBeVisible();
		},
	},
];
