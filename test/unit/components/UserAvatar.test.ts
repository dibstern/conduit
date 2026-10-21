import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Avatar } from "../../../src/lib/contracts/user-avatar.js";
import UserAvatar from "../../../src/lib/frontend/components/ui/UserAvatar.svelte";
import {
	avatarState,
	loadAvatar,
	saveAvatar,
} from "../../../src/lib/frontend/stores/avatar.svelte.js";
import { rpc } from "../../../src/lib/frontend/transport/ws-rpc-client.js";

vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	rpc: vi.fn(),
}));

const initial: Avatar = {
	choice: { kind: "initial" },
	name: "David",
	macPicture: null,
};

describe("UserAvatar", () => {
	beforeEach(() => {
		vi.mocked(rpc).mockReset();
		Object.assign(avatarState, {
			current: { choice: null, name: "", macPicture: null },
			loaded: false,
			saving: false,
			error: "",
		});
	});

	afterEach(cleanup);

	it("updates an already mounted avatar after loading and reloading", async () => {
		const { getByTestId } = render(UserAvatar);
		const avatar = getByTestId("user-avatar");
		expect(avatar.textContent).toBe("");

		vi.mocked(rpc).mockResolvedValueOnce(initial);
		await loadAvatar();
		await tick();
		expect(avatar.textContent).toBe("D");

		vi.mocked(rpc).mockResolvedValueOnce({ ...initial, name: "Alex" });
		await loadAvatar();
		await tick();
		expect(avatar.textContent).toBe("A");
		expect(getByTestId("user-avatar")).toBe(avatar);
	});

	it("updates the rendered choice and shape seed after saving", async () => {
		avatarState.current = initial;
		const { getByTestId } = render(UserAvatar);
		const avatar = getByTestId("user-avatar");
		expect(avatar.textContent).toBe("D");

		vi.mocked(rpc).mockResolvedValueOnce({
			...initial,
			choice: { kind: "preset", id: "fox" },
		});
		expect(await saveAvatar({ kind: "preset", id: "fox" })).toBe(true);
		await tick();
		expect(avatar.getAttribute("data-kind")).toBe("preset");
		expect(avatar.textContent).toBe("🦊");

		for (const seed of [12, 34]) {
			const previousDrawing = avatar.innerHTML;
			vi.mocked(rpc).mockResolvedValueOnce({
				...initial,
				choice: { kind: "shape", seed },
			});
			expect(await saveAvatar({ kind: "shape", seed })).toBe(true);
			await tick();
			expect(avatar.getAttribute("data-kind")).toBe("shape");
			expect(avatar.getAttribute("data-seed")).toBe(String(seed));
			expect(avatar.querySelector("svg")).not.toBeNull();
			expect(avatar.innerHTML).not.toBe(previousDrawing);
		}
		expect(getByTestId("user-avatar")).toBe(avatar);
	});

	it("keeps an explicit avatar until the prop is removed", async () => {
		const { getByTestId, rerender } = render(UserAvatar, {
			props: { avatar: { ...initial, name: "Alex" } },
		});
		const avatar = getByTestId("user-avatar");
		vi.mocked(rpc).mockResolvedValueOnce(initial);
		await loadAvatar();
		await tick();
		expect(avatar.textContent).toBe("A");

		await rerender({ avatar: undefined });
		expect(avatar.textContent).toBe("D");
	});
});
