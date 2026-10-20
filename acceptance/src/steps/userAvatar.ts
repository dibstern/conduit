import { expect, type Locator, type Page } from "@playwright/test";
import type {
	Avatar,
	AvatarChoice,
} from "../../../src/lib/contracts/user-avatar.js";
import { WsRpcError } from "../../../src/lib/contracts/ws-rpc.js";
import { setMockAvatar } from "../../../test/e2e/helpers/rpc-mock.js";
import { avatarPicture } from "../../../test/fixtures/avatar-picture.js";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

function choiceFromText(text: string): AvatarChoice | null {
	if (text === "unchosen") return null;
	if (text === "initial" || text === "mac") return { kind: text };
	if (text === "preset fox") return { kind: "preset", id: "fox" };
	if (/^shape \d+$/.test(text))
		return { kind: "shape", seed: Number(text.slice(6)) };
	throw new Error(`Unsupported avatar fixture: ${text}`);
}

const picker = (page: Page) => page.getByTestId("avatar-picker");
const transcriptAvatar = (page: Page) =>
	page.locator("#messages").getByTestId("user-avatar").last();

async function expectFace(avatar: Locator, choice: AvatarChoice | null) {
	await expect(avatar).toHaveAttribute(
		"data-kind",
		choice?.kind === "mac"
			? "image"
			: choice?.kind === "preset" || choice?.kind === "shape"
				? choice.kind
				: "letter",
	);
	if (choice?.kind === "shape")
		await expect(avatar).toHaveAttribute("data-seed", String(choice.seed));
	if (!choice || choice.kind === "initial")
		await expect(avatar).toHaveText("D");
	if (choice?.kind === "mac") {
		const image = avatar.locator("img");
		await expect(image).toHaveAttribute("src", avatarPicture);
		await expect
			.poll(() =>
				image.evaluate(
					(element) =>
						element instanceof HTMLImageElement &&
						element.complete &&
						element.naturalWidth > 0,
				),
			)
			.toBe(true);
	}
}

export const userAvatarHandlers: StepHandler[] = [
	{
		name: "seed daemon avatar before connecting",
		match: /^the daemon avatar is (.+) with (a|no) Mac picture$/,
		run: ({ world, match }) => {
			const avatar: Avatar = {
				choice: choiceFromText(match[1] ?? ""),
				name: "David",
				macPicture: match[2] === "a" ? avatarPicture : null,
			};
			setMockAvatar(world.page, avatar);
		},
	},
	{
		name: "set avatar acceptance theme",
		match: /^the avatar theme is (dark|light)$/,
		run: async ({ world, match }) => {
			const theme = match[1] === "light" ? "light" : "dark";
			await world.page.emulateMedia({ colorScheme: theme });
			await world.page.addInitScript((mode) => {
				localStorage.setItem("conduit-theme", mode);
			}, theme);
		},
	},
	{
		name: "assert avatar first run",
		match: /^the avatar first run is (visible|absent)$/,
		run: async ({ world, match }) => {
			const dialog = world.page.getByTestId("avatar-first-run");
			if (match[1] === "visible") {
				await expect(dialog).toBeVisible();
				await expect(
					world.page.getByRole("dialog", {
						name: "How should you look in chats?",
						exact: true,
					}),
				).toBeVisible();
			} else await expect(dialog).toHaveCount(0);
		},
	},
	{
		name: "continue with initial avatar",
		match: /^I continue with my initial avatar$/,
		run: async ({ world }) => {
			const dialog = world.page.getByTestId("avatar-first-run");
			await dialog.getByRole("radio", { name: "Initial", exact: true }).click();
			await dialog
				.getByRole("button", { name: "Continue", exact: true })
				.click();
		},
	},
	{
		name: "open avatar picker",
		match: /^I open the avatar picker from (chat|General)$/,
		run: async ({ world, match }) => {
			if (match[1] === "General")
				await world.page.getByTestId("avatar-change").click();
			else
				await world.page
					.locator("#messages")
					.getByRole("button", { name: "Change your avatar", exact: true })
					.last()
					.click();
			await expect(picker(world.page)).toBeVisible();
			await expect(
				world.page.getByRole("dialog", { name: "Your avatar", exact: true }),
			).toBeVisible();
		},
	},
	{
		name: "assert avatar picker options",
		match: /^the avatar picker (offers|hides) Mac$/,
		run: async ({ world, match }) => {
			const mac = picker(world.page).getByRole("radio", {
				name: "Mac",
				exact: true,
			});
			if (match[1] === "offers") await expect(mac).toBeVisible();
			else await expect(mac).toHaveCount(0);
			for (const name of ["Initial", "Preset", "Shape"])
				await expect(
					picker(world.page).getByRole("radio", { name, exact: true }),
				).toBeVisible();
		},
	},
	{
		name: "choose draft avatar",
		match: /^I choose the (initial|mac|preset fox|shape \d+) avatar$/,
		run: async ({ world, match }) => {
			const choice = choiceFromText(match[1] ?? "");
			if (!choice) throw new Error("An avatar choice is required");
			const label =
				choice.kind === "mac"
					? "Mac"
					: choice.kind[0]?.toUpperCase() + choice.kind.slice(1);
			await picker(world.page)
				.getByRole("radio", { name: label, exact: true })
				.click();
			if (choice.kind === "preset" || choice.kind === "shape")
				await picker(world.page)
					.getByRole("radio", {
						name: choice.kind === "preset" ? "Fox" : `Shape ${choice.seed}`,
						exact: true,
					})
					.locator("..")
					.click();
			await expectFace(
				picker(world.page)
					.getByTestId("avatar-preview")
					.getByTestId("user-avatar"),
				choice,
			);
		},
	},
	{
		name: "assert twelve avatar presets",
		match: /^the avatar picker has all twelve presets$/,
		run: async ({ world }) => {
			await picker(world.page)
				.getByRole("radio", { name: "Preset", exact: true })
				.click();
			await expect(
				picker(world.page)
					.getByRole("group", { name: "Preset pictures", exact: true })
					.getByRole("radio"),
			).toHaveCount(12);
			for (const name of [
				"Fox",
				"Octopus",
				"Saturn",
				"Cactus",
				"Lemon",
				"Whale",
				"Violet orb",
				"Sunset orb",
				"Ocean orb",
				"Amber orb",
				"Mint orb",
				"Pink orb",
			])
				await expect(
					picker(world.page).getByRole("radio", { name, exact: true }),
				).toBeVisible();
		},
	},
	{
		name: "save avatar choice",
		match: /^I save my avatar$/,
		run: async ({ world }) => {
			await picker(world.page)
				.getByRole("button", { name: "Done", exact: true })
				.click();
		},
	},
	{
		name: "assert persisted avatar choice",
		match: /^the daemon stores the (initial|mac|preset fox|shape \d+) avatar$/,
		run: async ({ world, match }) => {
			const choice = choiceFromText(match[1] ?? "");
			const rpc = requireRpcControl(world.page);
			await expect
				.poll(
					() =>
						rpc
							.getRequests()
							.filter((request) => request.tag === "SetAvatar")
							.at(-1)?.payload,
				)
				.toEqual({ _tag: "SetAvatar", choice });
			await expect.poll(() => rpc.avatar.choice).toEqual(choice);
		},
	},
	{
		name: "assert transcript avatar",
		match: /^the transcript avatar is (initial|mac|preset fox|shape \d+)$/,
		run: async ({ world, match }) => {
			await expectFace(
				transcriptAvatar(world.page),
				choiceFromText(match[1] ?? ""),
			);
		},
	},
	{
		name: "reload and re-read daemon avatar",
		match: /^I reconnect to the daemon avatar$/,
		run: async ({ world }) => {
			const rpc = requireRpcControl(world.page);
			const reads = () =>
				rpc.getRequests().filter((request) => request.tag === "GetAvatar")
					.length;
			const before = reads();
			await world.page.reload();
			await expect.poll(reads).toBeGreaterThan(before);
			await expect(world.page.locator("#connect-overlay")).toBeHidden();
		},
	},
	{
		name: "shuffle draft shape without saving",
		match: /^I shuffle the avatar shapes$/,
		run: async ({ world }) => {
			const preview = picker(world.page)
				.getByTestId("avatar-preview")
				.getByTestId("user-avatar");
			const before = await preview.getAttribute("data-seed");
			await picker(world.page)
				.getByRole("button", { name: "Shuffle", exact: true })
				.click();
			await expect(preview).toHaveAttribute("data-kind", "shape");
			await expect(preview).not.toHaveAttribute("data-seed", before ?? "");
		},
	},
	{
		name: "cancel avatar choice",
		match: /^I cancel my avatar change$/,
		run: async ({ world }) => {
			await world.page.keyboard.press("Escape");
			await expect(picker(world.page)).toHaveCount(0);
		},
	},
	{
		name: "assert no avatar write",
		match: /^the daemon has received no avatar changes$/,
		run: ({ world }) => {
			expect(
				requireRpcControl(world.page)
					.getRequests()
					.filter((request) => request.tag === "SetAvatar"),
			).toEqual([]);
		},
	},
	{
		name: "fail avatar save",
		match: /^the daemon cannot save the avatar$/,
		run: ({ world }) => {
			requireRpcControl(world.page).setStubs({
				SetAvatar: () => {
					throw new WsRpcError({ message: "Avatar save failed" });
				},
			});
		},
	},
	{
		name: "assert avatar save error preserves draft",
		match: /^the avatar picker keeps its draft after the save error$/,
		run: async ({ world }) => {
			await expect(picker(world.page)).toBeVisible();
			await expect(picker(world.page).getByRole("alert")).toHaveText(
				"Couldn't save your avatar. Try again.",
			);
			await expectFace(
				picker(world.page)
					.getByTestId("avatar-preview")
					.getByTestId("user-avatar"),
				{ kind: "preset", id: "fox" },
			);
			expect(requireRpcControl(world.page).avatar.choice).toEqual({
				kind: "initial",
			});
		},
	},
];
