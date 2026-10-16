// @vitest-environment jsdom
import { ManagedRuntime, Stream } from "effect";
import { flushSync, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedTranscript } from "../../../src/lib/frontend/stores/saved-transcripts.js";
import { makeWsRpcClientsLayer } from "../../../src/lib/frontend/transport/shared-client.js";
import { makeRpcWire } from "../../helpers/rpc-wire.js";
import type { StubTable } from "../../helpers/stub-ws-rpc.js";

const runtimeMock = vi.hoisted(() => ({
	getRuntime: vi.fn(),
	runTransportEffect: vi.fn(),
}));
const savedMock = vi.hoisted(() => ({
	openSavedTranscript: vi.fn<() => Promise<SavedTranscript | undefined>>(),
	saveTranscript: vi.fn(() => Promise.resolve()),
	forgetTranscript: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../../src/lib/frontend/transport/runtime.js", () => runtimeMock);
vi.mock(
	"../../../src/lib/frontend/transport/connection-status.svelte.js",
	() => ({ getIsConnected: () => true }),
);
vi.mock(
	"../../../src/lib/frontend/stores/saved-transcripts.js",
	() => savedMock,
);
vi.mock("../../../src/lib/frontend/utils/markdown.js", () => ({
	renderMarkdown: (text: string) => text,
}));

import {
	currentChat,
	inputSyncState,
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	applyGetModelsResponse,
	chooseVariant,
	clearDiscoveryState,
	discoveryState,
	getDraftPick,
	getEffectiveInstanceId,
	handleDefaultModelInfo,
	handleHarnessDefaults,
	handleModelList,
	selectInstance,
	watchCatalogs,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import { fileTreeState } from "../../../src/lib/frontend/stores/file-tree.svelte.js";
import {
	applyInstanceListResponse,
	instanceState,
} from "../../../src/lib/frontend/stores/instance.svelte.js";
import {
	getDraftProject,
	projectState,
} from "../../../src/lib/frontend/stores/project-state.svelte.js";
import {
	attachedProjectState,
	replaceRoute,
	routerState,
} from "../../../src/lib/frontend/stores/router.svelte.js";
import {
	clearSessionState,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { setSessionScope } from "../../../src/lib/frontend/stores/session-scope.js";
import { todoState } from "../../../src/lib/frontend/stores/todo.svelte.js";
import { savedDraw } from "../../../src/lib/frontend/stores/transcript.svelte.js";
import { turn } from "../../../src/lib/frontend/stores/turn.svelte.js";
import { uiState } from "../../../src/lib/frontend/stores/ui.svelte.js";
import { drawSavedShell } from "../../../src/lib/frontend/transport/session-subscription.svelte.js";
import { detailRowsOf } from "../../helpers/detail-rows.js";
import {
	applyFamilyFeedChange,
	applySessionRemoved,
	seedSessions,
} from "../stores/session-fixtures.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((finish) => {
		resolve = finish;
	});
	return { promise, resolve };
}
type Attach = { projectSlug: string | null; sessionSlug: string | null };
let table: { -readonly [K in keyof StubTable]: StubTable[K] };
let wire: ReturnType<typeof makeRpcWire>;
let runtime: ManagedRuntime.ManagedRuntime<
	import("../../../src/lib/frontend/transport/shared-client.js").WsRpcClients,
	never
>;

import * as module from "../../../src/lib/frontend/stores/selection.svelte.js";

let stop: (() => void) | undefined;
let stopCatalogs: (() => void) | undefined;
const calls = (tag: string) =>
	wire.requests.filter((request) => request.tag === tag);
const settle = async () => {
	flushSync();
	await tick();
	await new Promise((resolve) => setTimeout(resolve, 20));
	flushSync();
};
function start() {
	stop = module.watchSelection();
	stopCatalogs = watchCatalogs();
	flushSync();
}

beforeEach(async () => {
	replaceRoute("/?");
	routerState.sessionNotFound = false;
	attachedProjectState.slug = null;
	clearSessionState();
	projectState.projects = [];
	projectState.newSessionProject = null;
	savedDraw.sessionId = null;
	savedMock.openSavedTranscript.mockResolvedValue(undefined);
	table = {
		AttachProject: () => ({ projectSlug: "A", sessionSlug: null }),
		ResolveSession: () => ({ projectSlug: "A" }),
		ViewSession: () => ({ ok: true }),
		GetFileTree: () => ({ projectSlug: "A", entries: [] }),
	};
	wire = makeRpcWire(table);
	runtime = ManagedRuntime.make(makeWsRpcClientsLayer(wire.connect));
	runtimeMock.getRuntime.mockResolvedValue(runtime);
	runtimeMock.runTransportEffect.mockImplementation((effect) =>
		runtime.runPromise(effect),
	);
});

describe("turn readiness for the shown scope", () => {
	beforeEach(() => {
		clearDiscoveryState();
		sessionState.currentId = null;
		projectState.projects = [
			{ slug: "ready", title: "Ready", folders: ["/ready"] },
		];
		projectState.newSessionProject = "ready";
		attachedProjectState.slug = "ready";
		replaceRoute("/new?project=ready");
		applyInstanceListResponse({
			instances: ["ready-account", "ready-other"].map((id) => ({
				id,
				name: id,
				driver: "opencode",
				isDefault: id === "ready-account",
				port: 0,
				managed: false,
				status: "healthy",
				restartCount: 0,
				createdAt: 0,
				capabilities: { supportsMultiFolder: false, supportsWorktree: false },
			})),
		});
	});
	afterEach(() => {
		clearDiscoveryState();
		applyInstanceListResponse({ instances: [] });
	});

	function pickModel() {
		const providers = [
			{
				id: "openai",
				name: "OpenAI",
				configured: true,
				models: [{ id: "gpt", name: "GPT", provider: "openai" }],
			},
		];
		handleDefaultModelInfo({ model: "gpt", provider: "openai" });
		handleModelList({ providers });
		applyGetModelsResponse({
			projectSlug: "ready",
			instanceId: "ready-account",
			providers,
			active: { model: "gpt", provider: "openai" },
		});
	}

	it("a placed session is ready without a draft model pick", () => {
		seedSessions([
			{ id: "ready-placed", title: "Ready", projectSlug: "ready" },
		]);
		module.selection.open("ready-placed");
		expect(getDraftPick()).toBeUndefined();
		expect(turn().ready).toBe(true);
	});
	it.each([
		"placing",
		"drawn",
	] as const)("an unplaced %s session is not ready", (kind) => {
		const sessionId = `ready-${kind}`;
		module.selection.open(sessionId);
		if (kind === "drawn") savedDraw.sessionId = sessionId;
		expect(module.selection.shown.kind).toBe(kind);
		expect(turn().ready).toBe(false);
	});
	it("a draft without its account's model pick is not ready", () => {
		expect(getEffectiveInstanceId()).toBe("ready-account");
		expect(getDraftPick()).toBeUndefined();
		expect(turn().ready).toBe(false);
	});
	it("a supported draft with its account's model pick is ready", () => {
		pickModel();
		expect(getDraftPick()?.instanceId).toBe("ready-account");
		expect(turn().ready).toBe(true);
	});
	it("another account's model pick does not make the draft ready", () => {
		pickModel();
		selectInstance("ready-other");
		expect(getEffectiveInstanceId()).toBe("ready-other");
		expect(getDraftPick()).toBeUndefined();
		expect(turn().ready).toBe(false);
	});
	it.each([
		false,
		true,
	])("a multifolder draft is ready only when supported: %s", (supported) => {
		pickModel();
		projectState.projects = [
			{
				slug: "ready",
				title: "Ready",
				folders: ["/ready", "/second"],
			},
		];
		const account = instanceState.instances.find(
			(item) => item.id === "ready-account",
		);
		if (!account) throw new Error("missing account");
		account.capabilities = {
			supportsMultiFolder: supported,
			supportsWorktree: false,
		};
		expect(getDraftPick()).toBeDefined();
		expect(turn().ready).toBe(supported);
	});
	it("a loaded directory with no account stays ready for the actionable send failure", () => {
		applyInstanceListResponse({ instances: [] });
		expect(instanceState.loaded).toBe(true);
		expect(getEffectiveInstanceId()).toBeUndefined();
		expect(turn().ready).toBe(true);
	});
	it("an account directory still loading cannot make a draft ready", () => {
		applyInstanceListResponse({ instances: [] });
		instanceState.loaded = false;
		expect(turn().ready).toBe(false);
	});
});
afterEach(async () => {
	stop?.();
	stop = undefined;
	stopCatalogs?.();
	stopCatalogs = undefined;
	await settle();
	if (runtime) await runtime.dispose();
	runtimeMock.getRuntime.mockReset();
	runtimeMock.runTransportEffect.mockReset();
	sessionActivity.clear();
	sessionMessages.clear();
	replaceRoute("/?");
	attachedProjectState.slug = null;
});

describe("session selection at the browser RPC wire", () => {
	it("follow without a captured scope neither places a session nor moves the route", () => {
		replaceRoute("/?");
		module.selection.follow(null, "follow-no-scope", "push");
		expect(routerState.path).toBe("/");
		module.selection.open("follow-no-scope");
		expect(module.selection.shown).toEqual({
			kind: "placing",
			sessionId: "follow-no-scope",
		});
	});
	it("follow places a draft's new session before showing it, without a resolve", () => {
		replaceRoute("/new?project=follow-project");
		const from = module.selection.scope;
		expect(from).toEqual({ project: "follow-project", sessionId: null });
		if (!from) throw new Error("draft has no scope");

		module.selection.follow(from, "follow-created", "push");

		expect(routerState.path).toBe("/s/follow-created");
		expect(module.selection.shown).toEqual({
			kind: "placed",
			project: "follow-project",
			sessionId: "follow-created",
		});
		expect(calls("ResolveSession")).toHaveLength(0);
	});
	it("follow compares the scope's project and session values", () => {
		seedSessions([{ id: "follow-parent", title: "Parent", projectSlug: "A" }]);
		module.selection.open("follow-parent");
		const from = { project: "A", sessionId: "follow-parent" };
		expect(module.selection.scope).toEqual(from);
		expect(module.selection.scope).not.toBe(from);

		module.selection.follow(from, "follow-side", "push");

		expect(module.selection.shown).toEqual({
			kind: "placed",
			project: "A",
			sessionId: "follow-side",
		});
	});
	it.each([
		"session",
		"project",
		"draft",
		"home",
	] as const)("a follow after opening another %s places only its reply's session and leaves the route alone", (destination) => {
		const suffix = `follow-late-${destination}`;
		seedSessions([
			{ id: `${suffix}-parent`, title: "Parent", projectSlug: "A" },
			{ id: `${suffix}-other`, title: "Other", projectSlug: "B" },
		]);
		module.selection.open(`${suffix}-parent`);
		const from = module.selection.scope;
		if (!from) throw new Error("parent has no scope");
		if (destination === "session") module.selection.open(`${suffix}-other`);
		else if (destination === "project") module.selection.openDraft("B");
		else if (destination === "draft") module.selection.openDraft("A");
		else replaceRoute("/?");
		const path = routerState.path;
		const search = routerState.search;
		const shown = module.selection.shown;

		module.selection.follow(from, `${suffix}-reply`, "replace");

		expect(routerState.path).toBe(path);
		expect(routerState.search).toBe(search);
		expect(module.selection.shown).toEqual(shown);
		module.selection.open(`${suffix}-reply`);
		expect(module.selection.shown).toEqual({
			kind: "placed",
			project: "A",
			sessionId: `${suffix}-reply`,
		});
		module.selection.open(`${suffix}-unrelated`);
		expect(module.selection.shown).toEqual({
			kind: "placing",
			sessionId: `${suffix}-unrelated`,
		});
		expect(calls("ResolveSession")).toHaveLength(0);
	});
	it("a draft follow cannot replace a newly selected project's draft", () => {
		replaceRoute("/new?project=follow-A");
		const from = module.selection.scope;
		if (!from) throw new Error("draft has no scope");
		module.selection.openDraft("follow-B");

		module.selection.follow(from, "follow-draft-late", "push");

		expect(module.selection.shown).toEqual({
			kind: "draft",
			project: "follow-B",
		});
		module.selection.open("follow-draft-late");
		expect(module.selection.shown).toEqual({
			kind: "placed",
			project: "follow-A",
			sessionId: "follow-draft-late",
		});
	});
	it("a late attach places its own id without moving the session now shown", async () => {
		const pending = deferred<Attach>();
		table.AttachProject = () => pending.promise;
		replaceRoute("/s/attach-old");
		start();
		await vi.waitFor(() => expect(calls("AttachProject")).toHaveLength(1));
		seedSessions([{ id: "attach-new", title: "New", projectSlug: "B" }]);
		module.selection.open("attach-new");
		await settle();
		pending.resolve({ projectSlug: "A", sessionSlug: "A" });
		await settle();
		expect(module.selection.shown).toEqual({
			kind: "placed",
			sessionId: "attach-new",
			project: "B",
		});
		expect(routerState.path).toBe("/s/attach-new");
	});
	it("a late resolve never moves another session or its route", async () => {
		attachedProjectState.slug = "A";
		const pending = deferred<{ projectSlug: string | null }>();
		table.ResolveSession = () => pending.promise;
		start();
		module.selection.open("resolve-old");
		await vi.waitFor(() => expect(calls("ResolveSession")).toHaveLength(1));
		seedSessions([{ id: "resolve-new", title: "New", projectSlug: "A" }]);
		module.selection.open("resolve-new");
		await settle();
		pending.resolve({ projectSlug: null });
		await settle();
		expect(module.selection.shown).toEqual({
			kind: "placed",
			sessionId: "resolve-new",
			project: "A",
		});
		expect(routerState.sessionNotFound).toBe(false);
		expect(routerState.path).toBe("/s/resolve-new");
	});
	it("two quick project switches finish attached to the second project", async () => {
		attachedProjectState.slug = "A";
		const first = deferred<Attach>();
		const second = deferred<Attach>();
		table.AttachProject = (payload) =>
			"projectSlug" in payload && payload.projectSlug === "B"
				? first.promise
				: second.promise;
		start();
		module.selection.openDraft("B");
		await vi.waitFor(() => expect(calls("AttachProject")).toHaveLength(1));
		module.selection.openDraft("C");
		await vi.waitFor(() => expect(calls("AttachProject")).toHaveLength(2));
		second.resolve({ projectSlug: "C", sessionSlug: null });
		await settle();
		first.resolve({ projectSlug: "B", sessionSlug: null });
		await settle();
		expect(attachedProjectState.slug).toBe("C");
		expect(module.selection.scope).toEqual({ project: "C", sessionId: null });
	});
	it("places a live sidebar session immediately without attach or resolve", async () => {
		attachedProjectState.slug = "A";
		seedSessions([{ id: "sidebar", title: "Sidebar", projectSlug: "A" }]);
		start();
		module.selection.open("sidebar");
		expect(module.selection.shown).toEqual({
			kind: "placed",
			sessionId: "sidebar",
			project: "A",
		});
		await settle();
		expect(calls("ResolveSession")).toHaveLength(0);
		expect(calls("AttachProject")).toHaveLength(0);
	});
	it("an unknown session goes home with the not-found notice", async () => {
		attachedProjectState.slug = "A";
		table.ResolveSession = () => ({ projectSlug: null });
		start();
		module.selection.open("unknown");
		await vi.waitFor(() => expect(routerState.path).toBe("/"));
		expect(routerState.sessionNotFound).toBe(true);
		expect(module.selection.shown).toEqual({ kind: "none" });
	});
	it("draws a saved cold page while every scoped read and feed waits for placement", async () => {
		const pending = deferred<Attach>();
		table.AttachProject = () => pending.promise;
		savedMock.openSavedTranscript.mockResolvedValue({
			schema: 1,
			sessionId: "saved",
			project: "A",
			buildId: "test",
			protocolVersion: 1,
			openedAt: 1,
			snapshot: { _tag: "snapshot", sequence: 1, rows: [], hasMore: false },
		});
		replaceRoute("/s/saved");
		start();
		await settle();
		expect(module.selection.shown).toEqual({
			kind: "drawn",
			sessionId: "saved",
		});
		expect(module.selection.scope).toBeNull();
		expect(wire.requests.map((request) => request.tag)).toEqual([
			"AttachProject",
		]);
		pending.resolve({ projectSlug: "A", sessionSlug: "A" });
		await vi.waitFor(() =>
			expect(module.selection.shown).toEqual({
				kind: "placed",
				sessionId: "saved",
				project: "A",
			}),
		);
		await vi.waitFor(() => expect(calls("GetFileTree")).toHaveLength(1));
		expect(savedDraw.sessionId).toBeNull();
	});
	it("saved sidebar rows never place a session", async () => {
		const pending = deferred<Attach>();
		table.AttachProject = () => pending.promise;
		replaceRoute("/s/saved-sidebar");
		drawSavedShell({
			schema: 1,
			project: "stale",
			buildId: "test",
			protocolVersion: 1,
			savedAt: 1,
			rows: [
				{
					id: "saved-sidebar",
					title: "Saved",
					status: "idle",
					projectSlug: "stale",
					accountId: null,
				},
			],
		});
		start();
		await settle();
		expect(module.selection.shown).toEqual({
			kind: "placing",
			sessionId: "saved-sidebar",
		});
		expect(module.selection.scope).toBeNull();
		pending.resolve({ projectSlug: "A", sessionSlug: "A" });
		await vi.waitFor(() =>
			expect(module.selection.shown).toEqual({
				kind: "placed",
				sessionId: "saved-sidebar",
				project: "A",
			}),
		);
	});
	it.each([
		"B",
		null,
	])("discards a saved page placed in %s instead of its saved project", async (project) => {
		const pending = deferred<Attach>();
		table.AttachProject = () => pending.promise;
		savedMock.openSavedTranscript.mockResolvedValue({
			schema: 1,
			sessionId: `foreign-saved-${project}`,
			project: "A",
			buildId: "test",
			protocolVersion: 1,
			openedAt: 1,
			snapshot: {
				_tag: "snapshot",
				sequence: 1,
				rows: detailRowsOf({
					id: "saved-message",
					role: "user",
					time: { created: 1 },
					parts: [
						{ id: "saved-text", type: "text", text: "provisional saved text" },
					],
				}),
				hasMore: false,
			},
		});
		replaceRoute(`/s/foreign-saved-${project}`);
		start();
		await settle();
		expect(currentChat().messages).toHaveLength(1);
		pending.resolve({ projectSlug: project ?? "A", sessionSlug: project });
		await settle();
		expect(currentChat().messages).toHaveLength(0);
		expect(savedDraw.sessionId).toBeNull();
	});
	it("a late file-tree reply never appears under the next scope", async () => {
		attachedProjectState.slug = "A";
		const first = deferred<{ projectSlug: string; entries: string[] }>();
		table.GetFileTree = (payload) =>
			"sessionId" in payload && payload.sessionId === "tree-old"
				? first.promise
				: { projectSlug: "A", entries: ["new.txt"] };
		seedSessions([
			{ id: "tree-old", title: "Old", projectSlug: "A" },
			{ id: "tree-new", title: "New", projectSlug: "A" },
		]);
		module.selection.open("tree-old");
		start();
		await vi.waitFor(() => expect(calls("GetFileTree")).toHaveLength(1));
		module.selection.open("tree-new");
		await vi.waitFor(() => expect(fileTreeState.entries).toEqual(["new.txt"]));
		first.resolve({ projectSlug: "A", entries: ["old.txt"] });
		await settle();
		expect(fileTreeState.entries).toEqual(["new.txt"]);
	});
	it("a cold session link attaches and places in one round trip", async () => {
		table.AttachProject = () => ({ projectSlug: "B", sessionSlug: "B" });
		replaceRoute("/s/cold");
		start();
		await vi.waitFor(() =>
			expect(module.selection.shown).toEqual({
				kind: "placed",
				sessionId: "cold",
				project: "B",
			}),
		);
		expect(calls("AttachProject")).toHaveLength(1);
		expect(calls("AttachProject")[0]?.payload).toMatchObject({
			sessionId: "cold",
		});
		expect(calls("ResolveSession")).toHaveLength(0);
	});
	it("choosing a project scope from home attaches that project", async () => {
		attachedProjectState.slug = "A";
		table.AttachProject = () => ({ projectSlug: "B", sessionSlug: null });
		start();
		setSessionScope("B");
		await vi.waitFor(() => expect(attachedProjectState.slug).toBe("B"));
		expect(calls("AttachProject")[0]?.payload).toMatchObject({
			projectSlug: "B",
		});
		expect(module.selection.scope).toEqual({ project: "B", sessionId: null });
	});
	it("home reads the attached project's catalogs and files and keeps its draft send ready", async () => {
		clearDiscoveryState();
		projectState.projects = [
			{ slug: "B", title: "Project B", folders: ["/B"] },
		];
		projectState.newSessionProject = "B";
		attachedProjectState.slug = "B";
		applyInstanceListResponse({
			instances: [
				{
					id: "home-opencode",
					name: "OpenCode",
					driver: "opencode",
					isDefault: true,
					port: 0,
					managed: false,
					status: "healthy",
					restartCount: 0,
					createdAt: 0,
				},
			],
		});
		const models = {
			projectSlug: "B",
			instanceId: "home-opencode",
			defaultOpenCodeInstanceId: "home-opencode",
			providers: [
				{
					id: "openai",
					name: "OpenAI",
					configured: true,
					models: [{ id: "gpt", name: "GPT", provider: "openai" }],
				},
			],
			active: { model: "gpt", provider: "openai" },
		};
		table.GetModels = () => models;
		table.GetAgents = () => ({
			projectSlug: "B",
			providerScope: { id: "opencode", name: "OpenCode" },
			agents: [{ id: "build", name: "Build" }],
		});
		table.GetCommands = () => ({
			projectSlug: "B",
			commands: [{ name: "compact" }],
		});
		table.GetFileTree = () => ({ projectSlug: "B", entries: ["home.ts"] });
		table.SubscribeDraftModels = () => Stream.make(models);
		handleDefaultModelInfo({ model: "gpt", provider: "openai" });
		try {
			start();
			await vi.waitFor(() => expect(calls("GetModels")).toHaveLength(1));
			await vi.waitFor(() =>
				expect(getDraftPick()).toMatchObject({
					instanceId: "home-opencode",
					model: { modelId: "gpt", providerId: "openai" },
				}),
			);
			expect(module.selection.shown).toEqual({ kind: "none" });
			expect(module.selection.scope).toEqual({ project: "B", sessionId: null });
			expect(getDraftProject()).toBe("B");
			for (const tag of [
				"GetModels",
				"GetAgents",
				"GetCommands",
				"SubscribeDraftModels",
				"GetFileTree",
			])
				expect(calls(tag)[0]?.payload).toMatchObject({
					projectSlug: getDraftProject(),
				});
			expect(fileTreeState.entries).toEqual(["home.ts"]);
			for (const tag of [
				"ViewSession",
				"SubscribeSessionDetail",
				"SubscribeSessionTodos",
				"SubscribeSessionFamily",
				"SubscribeInputDraft",
			])
				expect(calls(tag)).toHaveLength(0);
		} finally {
			projectState.projects = [];
			projectState.newSessionProject = null;
			clearDiscoveryState();
			applyInstanceListResponse({ instances: [] });
		}
	});
	it.each([
		"shell",
		"family",
	])("deleting the open %s session selects the next filtered session with no notice", async (source) => {
		attachedProjectState.slug = "A";
		replaceRoute("/?p=A");
		const id = `${source}-deleted`;
		const survivor = `${source}-survivor`;
		const deleted = { id, title: "Deleted", projectSlug: "A" };
		seedSessions([
			...(source === "shell" ? [deleted] : []),
			{ id: "other-project", title: "Other", projectSlug: "B" },
			{ id: survivor, title: "Survivor", projectSlug: "A" },
		]);
		start();
		if (source === "family")
			applyFamilyFeedChange({
				_tag: "snapshot",
				rows: [{ ...deleted, parentID: survivor }],
			});
		module.selection.open(id);
		await settle();
		expect(module.selection.shown).toEqual({
			kind: "placed",
			sessionId: id,
			project: "A",
		});
		if (source === "family")
			applyFamilyFeedChange({ _tag: "remove", id, deleted: true });
		else applySessionRemoved(id);
		await vi.waitFor(() => expect(routerState.path).toBe(`/s/${survivor}`));
		expect(routerState.sessionNotFound).toBe(false);
	});
	it("deleting the last session goes home and clears the shown session", async () => {
		attachedProjectState.slug = "A";
		seedSessions([{ id: "last", title: "Last", projectSlug: "A" }]);
		start();
		module.selection.open("last");
		await settle();
		todoState.items = [{ id: "old", subject: "Old todo", status: "pending" }];
		uiState.contextPercent = 75;
		applySessionRemoved("last");
		await vi.waitFor(() => expect(routerState.path).toBe("/"));
		expect(sessionState.currentId).toBeNull();
		expect(routerState.sessionNotFound).toBe(false);
		expect(todoState.items).toEqual([]);
		expect(uiState.contextPercent).toBe(0);
	});
	it("sends one view after placement and never applies a late draft to another session", async () => {
		attachedProjectState.slug = "A";
		const pending = deferred<{ projectSlug: string | null }>();
		const draft = deferred<{ ok: true; draft: string }>();
		const secondVisit = deferred<{ ok: true; draft: string }>();
		let oldVisits = 0;
		table.ResolveSession = () => pending.promise;
		table.ViewSession = ({ sessionId }) => {
			if (sessionId !== "view-old") return { ok: true, draft: "new draft" };
			oldVisits++;
			if (oldVisits === 1) return draft.promise;
			if (oldVisits === 2) return secondVisit.promise;
			return { ok: true, draft: "returned draft" };
		};
		seedSessions([{ id: "view-new", title: "New", projectSlug: "A" }]);
		start();
		module.selection.open("view-old");
		await vi.waitFor(() => expect(calls("ResolveSession")).toHaveLength(1));
		expect(calls("ViewSession")).toHaveLength(0);
		pending.resolve({ projectSlug: "A" });
		await vi.waitFor(() => expect(calls("ViewSession")).toHaveLength(1));
		module.selection.open("view-new");
		await vi.waitFor(() => expect(inputSyncState.text).toBe("new draft"));
		draft.resolve({ ok: true, draft: "old draft" });
		await settle();
		expect(inputSyncState.text).toBe("new draft");
		expect(
			calls("ViewSession").filter(
				(request) =>
					(request.payload as { sessionId: string }).sessionId === "view-old",
			),
		).toHaveLength(1);
		module.selection.open("view-old");
		await vi.waitFor(() => expect(calls("ViewSession")).toHaveLength(3));
		module.selection.open("view-new");
		await vi.waitFor(() => expect(calls("ViewSession")).toHaveLength(4));
		module.selection.open("view-old");
		await vi.waitFor(() => expect(inputSyncState.text).toBe("returned draft"));
		secondVisit.resolve({ ok: true, draft: "left visit draft" });
		await settle();
		expect(inputSyncState.text).toBe("returned draft");
		expect(
			calls("ViewSession").filter(
				(request) =>
					(request.payload as { sessionId: string }).sessionId === "view-old",
			),
		).toHaveLength(3);
	});
	it("consumes the pick on session bind so the next draft starts on the default", async () => {
		clearDiscoveryState();
		attachedProjectState.slug = "conduit";
		sessionState.currentId = null;
		applyInstanceListResponse({
			instances: ["claude", "claude-2", "opencode"].map((id) => ({
				id,
				name: id,
				port: 0,
				managed: false,
				status: "healthy",
				restartCount: 0,
				createdAt: 0,
				driver: id === "opencode" ? "opencode" : "claude",
				isDefault: id === "claude" || id === "opencode",
			})),
			providerCapabilities: {},
		});
		const defaults = {
			projectSlug: "conduit",
			providers: [
				{
					id: "claude",
					name: "Claude",
					configured: true,
					models: [
						{
							id: "sonnet",
							name: "Sonnet",
							provider: "claude",
							variants: ["high"],
						},
					],
				},
				{
					id: "openai",
					name: "OpenAI",
					configured: true,
					models: [{ id: "gpt", name: "GPT", provider: "openai" }],
				},
			],
			instanceId: "claude",
			active: { model: "sonnet", provider: "claude" },
		};
		handleDefaultModelInfo({ model: "sonnet", provider: "claude" });
		handleModelList({ providers: defaults.providers });
		applyGetModelsResponse({
			projectSlug: "conduit",
			instanceId: "opencode",
			providers: defaults.providers.filter(
				(provider) => provider.id !== "claude",
			),
		});
		handleHarnessDefaults({
			_tag: "harnessDefaults",
			claude: {
				status: "ok",
				pick: {
					modelId: "sonnet",
					providerId: "claude",
					effort: "",
					contextWindow: "",
				},
			},
			opencode: {
				status: "ok",
				pick: {
					modelId: "gpt",
					providerId: "openai",
					effort: "",
					contextWindow: "",
				},
			},
		});
		applyGetModelsResponse(defaults);
		seedSessions([
			{
				id: "picked-session",
				title: "Picked",
				projectSlug: "conduit",
				accountId: "opencode",
			},
		]);
		stop = module.watchSelection();
		flushSync();
		try {
			selectInstance("opencode");
			expect(discoveryState.hasInstanceChoice).toBe(true);
			module.selection.open("picked-session");
			await settle();
			expect(discoveryState.hasInstanceChoice).toBe(false);
			sessionState.currentId = null;
			await settle();
			expect(discoveryState.hasModelChoice).toBe(false);
			expect(getEffectiveInstanceId()).toBe("claude");
			sessionState.currentId = "picked-session";
			await settle();
			applyGetModelsResponse({
				...defaults,
				active: { model: "gpt", provider: "openai" },
			});
			sessionState.currentId = null;
			await settle();
			expect(getEffectiveInstanceId()).toBe("claude");
			applyGetModelsResponse(defaults);
			chooseVariant("high");
			expect(getEffectiveInstanceId()).toBe("claude");
			expect(getDraftPick()).toMatchObject({
				instanceId: "claude",
				model: { modelId: "sonnet", providerId: "claude", variant: "high" },
			});
			selectInstance("opencode");
			expect(getDraftPick()).toMatchObject({
				instanceId: "opencode",
				model: { modelId: "gpt", providerId: "openai" },
			});
		} finally {
			stop();
			stop = undefined;
			clearDiscoveryState();
			applyInstanceListResponse({ instances: [] });
		}
	});
});
