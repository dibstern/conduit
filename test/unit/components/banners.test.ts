import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Banners from "../../../src/lib/frontend/components/overlays/Banners.svelte";
import {
	applyGetAgentsResponse,
	clearDiscoveryState,
	handleModelInfo,
	handleModelList,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import {
	applyInstanceListResponse,
	instanceState,
} from "../../../src/lib/frontend/stores/instance.svelte.js";
import { projectState } from "../../../src/lib/frontend/stores/project.svelte.js";
import {
	clearSessionState,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import {
	showBanner,
	uiState,
} from "../../../src/lib/frontend/stores/ui.svelte.js";
import type {
	OpenCodeInstance,
	ProviderInfo,
} from "../../../src/lib/frontend/types.js";
import { seedRootSessions } from "../stores/session-fixtures.js";

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
		applyInstanceListResponse({ instances: [] });
		clearDiscoveryState();
		clearSessionState();
		projectState.projects = [];
		uiState.banners = [];
		uiState.opencodeConnections = {};
	});

	afterEach(() => {
		cleanup();
		clearSessionState();
	});

	it("does not show the OpenCode health warning when Claude is available", async () => {
		instanceState.instances = [unhealthyInstance];
		handleModelList({ providers: [claudeProvider] });
		handleModelInfo({ model: "", provider: "claude" });

		await renderBanners();

		expect(screen.queryByText("No healthy OpenCode instances")).toBeNull();
	});

	it("shows the OpenCode health warning when the active provider needs OpenCode", async () => {
		instanceState.instances = [unhealthyInstance];
		handleModelList({ providers: [claudeProvider, opencodeProvider] });
		handleModelInfo({ model: "", provider: "openai" });

		await renderBanners();

		expect(screen.getByText("No healthy OpenCode instances")).toBeTruthy();
	});

	it.each([
		["reconnecting", "Reconnecting to OpenCode…"],
		["failed", "OpenCode failed to start"],
	] as const)("shows %s for a persisted named instance without discovery", async (status, text) => {
		applyInstanceListResponse({
			instances: [
				{
					...unhealthyInstance,
					id: "healthy-oc",
					driver: "opencode",
					status: "healthy",
				},
				{ ...unhealthyInstance, id: "work-oc", driver: "opencode" },
			],
		});
		seedRootSessions([
			{
				id: "session-work",
				title: "Work session",
				resumes: [{ at: 1, instanceId: "work-oc", reason: "user" }],
			},
		]);
		sessionState.currentId = "session-work";
		uiState.opencodeConnections = { "work-oc": status, opencode: "failed" };

		await renderBanners();

		expect(screen.getByText(text)).toBeTruthy();
		expect(screen.queryByText("No healthy OpenCode instances")).toBeNull();
	});

	it.each([
		undefined,
		"work-oc",
	])("uses the relay's default alias with project instance %s", async (projectInstanceId) => {
		applyInstanceListResponse({
			instances: [{ ...unhealthyInstance, id: "work-oc", driver: "opencode" }],
		});
		projectState.projects = [
			{
				slug: "work",
				title: "Work",
				folders: ["/work"],
				...(projectInstanceId ? { instanceId: projectInstanceId } : {}),
			},
		];
		seedRootSessions([
			{
				id: "session-work",
				title: "Work session",
				projectSlug: "work",
				resumes: [{ at: 1, instanceId: "work-oc", reason: "user" }],
			},
		]);
		sessionState.currentId = "session-work";
		uiState.opencodeConnections = { opencode: "reconnecting" };

		await renderBanners();

		expect(screen.getByText("Reconnecting to OpenCode…")).toBeTruthy();
	});

	it("uses the latest persisted Claude resume instead of stale OpenCode discovery", async () => {
		applyInstanceListResponse({
			instances: [
				{ ...unhealthyInstance, id: "work-claude", driver: "claude" },
			],
		});
		seedRootSessions([
			{
				id: "session-work",
				title: "Work session",
				resumes: [
					{ at: 1, instanceId: "opencode", reason: "user" },
					{ at: 2, instanceId: "work-claude", reason: "auto-switch" },
				],
			},
		]);
		sessionState.currentId = "session-work";
		applyGetAgentsResponse(
			{
				projectSlug: "work",
				providerScope: { id: "opencode", name: "OpenCode" },
				agents: [],
			},
			"session-work",
		);
		uiState.opencodeConnections = { opencode: "failed" };

		await renderBanners();

		expect(
			document.querySelector('[data-banner-id="opencode-connection-status"]'),
		).toBeNull();
	});

	it("keeps discovery as a fallback for a session without resume metadata", async () => {
		sessionState.currentId = "session-work";
		applyGetAgentsResponse(
			{
				projectSlug: "work",
				instanceId: "work-oc",
				providerScope: { id: "opencode", name: "OpenCode" },
				agents: [],
			},
			"session-work",
		);
		uiState.opencodeConnections = {
			"work-oc": "reconnecting",
			opencode: "failed",
		};

		await renderBanners();

		expect(screen.getByText("Reconnecting to OpenCode…")).toBeTruthy();
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
