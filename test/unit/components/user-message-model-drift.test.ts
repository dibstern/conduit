import { cleanup, render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import UserMessage from "../../../src/lib/frontend/components/chat/UserMessage.svelte";
import {
	clearDiscoveryState,
	discoveryState,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import type { UserMessage as UserMessageType } from "../../../src/lib/frontend/types.js";

describe("UserMessage model drift marker", () => {
	beforeEach(() => {
		clearDiscoveryState();
		discoveryState.providers = [
			{
				id: "claude",
				name: "Claude",
				configured: true,
				models: [
					{
						id: "sonnet",
						name: "Sonnet 5",
						provider: "claude",
					},
					{
						id: "fable",
						name: "Fable 5",
						provider: "claude",
					},
				],
			},
		];
	});

	afterEach(cleanup);

	it("shows the exact per-turn marker with catalog display names", () => {
		const message: UserMessageType = {
			type: "user",
			uuid: "user-1",
			text: "Use Sonnet",
			modelExecution: {
				requestedModel: "sonnet",
				expectedModel: "claude-sonnet-5",
				actualModel: "fable",
				drifted: true,
			},
		};

		const { getByText } = render(UserMessage, { props: { message } });

		expect(getByText("⚠ Ran Fable 5, not Sonnet 5")).toBeTruthy();
	});

	it("falls back to raw ids and renders nothing for partial evidence", () => {
		const drifted: UserMessageType = {
			type: "user",
			uuid: "user-1",
			text: "Use unknown models",
			modelExecution: {
				requestedModel: "selected-raw",
				expectedModel: "expected-raw",
				actualModel: "actual-raw",
				drifted: true,
			},
		};
		const raw = render(UserMessage, { props: { message: drifted } });
		expect(raw.getByText("⚠ Ran actual-raw, not selected-raw")).toBeTruthy();
		raw.unmount();

		const partial: UserMessageType = {
			type: "user",
			uuid: "user-2",
			text: "Missing selection evidence",
			modelExecution: {
				expectedModel: "expected-raw",
				actualModel: "actual-raw",
				drifted: true,
			},
		};
		const incomplete = render(UserMessage, { props: { message: partial } });
		expect(incomplete.queryByText(/⚠ Ran/)).toBeNull();
	});
});
