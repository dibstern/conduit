import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Banners from "../../../src/lib/frontend/components/overlays/Banners.svelte";
import {
	clearDiscoveryState,
	handleModelInfo,
	handleModelList,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import { instanceState } from "../../../src/lib/frontend/stores/instance.svelte.js";
import {
	showBanner,
	uiState,
} from "../../../src/lib/frontend/stores/ui.svelte.js";
import type {
	OpenCodeInstance,
	ProviderInfo,
} from "../../../src/lib/frontend/types.js";

const unhealthyInstance = {
	id: "default",
	name: "Personal",
	port: 4096,
	managed: false,
	status: "unhealthy",
	restartCount: 0,
	createdAt: 1,
} satisfies OpenCodeInstance;

const claudeProvider = {
	id: "claude",
	name: "Anthropic - claude",
	configured: true,
	models: [
		{
			id: "claude-sonnet-4-7",
			name: "Claude Sonnet 4.7",
			provider: "claude",
		},
	],
} satisfies ProviderInfo;

const opencodeProvider = {
	id: "openai",
	name: "OpenAI",
	configured: true,
	models: [
		{
			id: "gpt-4.1",
			name: "GPT-4.1",
			provider: "openai",
		},
	],
} satisfies ProviderInfo;

async function renderBanners() {
	render(Banners);
	flushSync();
	await tick();
}

describe("Banners", () => {
	beforeEach(() => {
		instanceState.instances = [];
		clearDiscoveryState();
		uiState.banners = [];
	});

	afterEach(() => {
		cleanup();
	});

	it("does not show the OpenCode health warning when Claude is available", async () => {
		instanceState.instances = [unhealthyInstance];
		handleModelList({ providers: [claudeProvider] });
		handleModelInfo({ type: "model_info", model: "", provider: "claude" });

		await renderBanners();

		expect(screen.queryByText("No healthy OpenCode instances")).toBeNull();
	});

	it("shows the OpenCode health warning when the active provider needs OpenCode", async () => {
		instanceState.instances = [unhealthyInstance];
		handleModelList({ providers: [claudeProvider, opencodeProvider] });
		handleModelInfo({ type: "model_info", model: "", provider: "openai" });

		await renderBanners();

		expect(screen.getByText("No healthy OpenCode instances")).toBeTruthy();
	});

	it("renders a banner action after the banner arrives", async () => {
		await renderBanners();
		const run = vi.fn();
		showBanner({
			id: "stale-page",
			variant: "update",
			icon: "refresh-cw",
			text: "Conduit was updated. Reload this tab to keep things working.",
			dismissible: true,
			action: { label: "Reload", run },
		});
		await tick();

		expect(
			screen.getByText(
				"Conduit was updated. Reload this tab to keep things working.",
			),
		).toBeTruthy();
		expect(screen.getByTestId("banner-action").textContent).toBe("Reload");
		await fireEvent.click(screen.getByTestId("banner-action"));
		expect(run).toHaveBeenCalledOnce();
	});
});
