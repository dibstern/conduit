import { cleanup, render, screen } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import Banners from "../../../src/lib/frontend/components/overlays/Banners.svelte";
import { discoveryState } from "../../../src/lib/frontend/stores/discovery.svelte.js";
import { instanceState } from "../../../src/lib/frontend/stores/instance.svelte.js";
import { uiState } from "../../../src/lib/frontend/stores/ui.svelte.js";
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
		discoveryState.providers = [];
		discoveryState.currentProviderId = "";
		uiState.banners = [];
	});

	afterEach(() => {
		cleanup();
	});

	it("does not show the OpenCode health warning when Claude is available", async () => {
		instanceState.instances = [unhealthyInstance];
		discoveryState.providers = [claudeProvider];
		discoveryState.currentProviderId = "claude";

		await renderBanners();

		expect(screen.queryByText("No healthy OpenCode instances")).toBeNull();
	});

	it("shows the OpenCode health warning when the active provider needs OpenCode", async () => {
		instanceState.instances = [unhealthyInstance];
		discoveryState.providers = [claudeProvider, opencodeProvider];
		discoveryState.currentProviderId = "openai";

		await renderBanners();

		expect(screen.getByText("No healthy OpenCode instances")).toBeTruthy();
	});
});
