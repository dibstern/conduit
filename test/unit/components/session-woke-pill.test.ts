import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import SessionItem from "../../../src/lib/frontend/components/session/SessionItem.svelte";
import type { SessionInfo } from "../../../src/lib/frontend/types.js";

afterEach(cleanup);

describe("SessionItem wake marker", () => {
	it.each([
		["time", "Woke", "text-accent"],
		["approval", "Woke · approval", "text-warning"],
		["question", "Woke · question", "text-brand-b"],
		["error", "Woke · failed", "text-error"],
		["turn", "Woke · done", "text-success"],
	] as const)("shows %s in the existing meta line", (reason, label, colour) => {
		const session: SessionInfo = {
			id: reason,
			title: "Work",
			attention: "idle",
			wokenAt: 1,
			wokeBecause: reason,
		};
		render(SessionItem, { props: { session, now: 2 } });
		const pill = screen.getByTestId("session-woke-pill");
		expect(pill.textContent).toBe(label);
		expect(pill.className).toContain(colour);
		expect(
			pill.parentElement?.querySelector(".session-item-meta"),
		).not.toBeNull();
		expect(screen.getByText("Work").closest("a")?.className).not.toContain(
			"opacity-[0.62]",
		);
	});
});
