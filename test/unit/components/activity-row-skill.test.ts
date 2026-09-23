// Expanding a Skill row in the turn activity log reads the skill's SKILL.md
// off disk over RPC, since the tool result itself is only "Launching skill".

import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSkillContentRpc = vi.hoisted(() =>
	vi.fn(async (_input: { projectSlug: string; name: string }) => ({
		name: "brainstorm",
		path: "/skills/brainstorm/SKILL.md",
		content: "# Brainstorm skill body",
	})),
);

vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	getSkillContentRpc,
}));
vi.mock("../../../src/lib/frontend/stores/router.svelte.js", () => ({
	getCurrentSlug: () => "conduit",
}));

import ActivityRow from "../../../src/lib/frontend/components/chat/ActivityRow.svelte";
import type { ActivityPart } from "../../../src/lib/frontend/utils/turns.js";

const skillPart = {
	type: "tool",
	uuid: "skill-1",
	id: "skill-1",
	name: "Skill",
	input: { tool: "Skill", name: "brainstorm" },
	status: "completed",
	result: "Launching skill: brainstorm",
} as ActivityPart;

const row = () => screen.getByRole("button", { name: /brainstorm/ });

describe("ActivityRow skill content", () => {
	beforeEach(() => {
		getSkillContentRpc.mockClear();
	});
	afterEach(cleanup);

	it("shows the skill file when the row is expanded", async () => {
		render(ActivityRow, { props: { part: skillPart } });
		await fireEvent.click(row());

		expect(await screen.findByText("Brainstorm skill body")).toBeTruthy();
		expect(getSkillContentRpc).toHaveBeenCalledWith({
			projectSlug: "conduit",
			name: "brainstorm",
		});
	});

	it("renders YAML frontmatter as a highlighted yaml block, not markdown", async () => {
		getSkillContentRpc.mockResolvedValueOnce({
			name: "brainstorm",
			path: "/skills/brainstorm/SKILL.md",
			content:
				"---\nname: brainstorm\ndescription: Explore ideas\n---\n\n# Body",
		});
		const { container } = render(ActivityRow, { props: { part: skillPart } });
		await fireEvent.click(row());
		await screen.findByText("Body");

		const code = container.querySelector("pre code.language-yaml.hljs");
		expect(code?.textContent?.trim()).toBe(
			"name: brainstorm\ndescription: Explore ideas",
		);
		expect(container.querySelector("hr")).toBeNull();
	});

	it("retries on the next expand after a failed load", async () => {
		getSkillContentRpc.mockRejectedValueOnce(new Error("socket closed"));
		render(ActivityRow, { props: { part: skillPart } });

		await fireEvent.click(row());
		await screen.findByText("This skill's file could not be found on disk.");
		await fireEvent.click(row());
		await fireEvent.click(row());

		expect(await screen.findByText("Brainstorm skill body")).toBeTruthy();
		expect(getSkillContentRpc).toHaveBeenCalledTimes(2);
	});
});
