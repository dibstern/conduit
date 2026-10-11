import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

const setProjectInstanceRpc = vi.fn();
const getAgentsRpc = vi.fn();
vi.mock(
	"../../../src/lib/frontend/transport/ws-rpc-client.js",
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		setProjectInstanceRpc: (...args: unknown[]) =>
			setProjectInstanceRpc(...args),
		getAgentsRpc: (...args: unknown[]) => getAgentsRpc(...args),
	}),
);

import {
	clearDiscoveryState,
	getEffectiveInstanceId,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import { applyInstanceListResponse } from "../../../src/lib/frontend/stores/instance.svelte.js";
import {
	applyProjectList,
	bindProjectInstance,
	projectState,
} from "../../../src/lib/frontend/stores/project.svelte.js";
import { attachedProjectState } from "../../../src/lib/frontend/stores/router.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";

const claudeInstance = (id: string, name: string) => ({
	id,
	name,
	port: 0,
	managed: false,
	status: "healthy" as const,
	restartCount: 0,
	createdAt: 0,
	driver: "claude" as const,
});

const projectList = (instanceId: string) => ({
	projects: [
		{
			slug: "conduit",
			title: "conduit",
			folders: ["/repo"] as const,
			instanceId,
		},
	],
	current: "conduit",
});

/** A setProjectInstance reply the test settles by hand. */
const deferredReply = () => {
	let resolve = (_: ReturnType<typeof projectList>) => {};
	let reject = (_: Error) => {};
	const promise = new Promise<ReturnType<typeof projectList>>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	setProjectInstanceRpc.mockReturnValueOnce(promise);
	return { promise, resolve, reject };
};

const boundInstance = () =>
	projectState.projects.find((p) => p.slug === "conduit")?.instanceId;

beforeEach(() => {
	clearDiscoveryState();
	sessionState.currentId = null;
	attachedProjectState.slug = "conduit";
	// Settled replies, so no pick stays pending into the next test.
	setProjectInstanceRpc
		.mockReset()
		.mockImplementation(async ({ instanceId }: { instanceId: string }) =>
			projectList(instanceId),
		);
	getAgentsRpc.mockReset().mockReturnValue(new Promise(() => {}));
	// Listed Claude 2 first so "first available" can never pass for "bound".
	applyInstanceListResponse({
		instances: [
			claudeInstance("claude-2", "Claude 2"),
			claudeInstance("personal-claude", "Personal Claude"),
			claudeInstance("claude-3", "Claude 3"),
		],
		providerCapabilities: {},
	} as unknown as Parameters<typeof applyInstanceListResponse>[0]);
	applyProjectList(projectList("personal-claude"));
});

describe("new session instance", () => {
	it("creates the new session on the project's bound instance", () => {
		expect(getEffectiveInstanceId()).toBe("personal-claude");
	});

	// Incident ses_661e4e5a: the header badge rebound the project to Claude 2,
	// and the next send still created the session on Personal.
	it("follows a header rebind before the daemon replies", () => {
		bindProjectInstance("conduit", "claude-2");
		expect(getEffectiveInstanceId()).toBe("claude-2");
		expect(setProjectInstanceRpc).toHaveBeenCalledWith({
			projectSlug: "conduit",
			slug: "conduit",
			instanceId: "claude-2",
		});
	});

	it("restores the previous binding when the rebind fails", async () => {
		setProjectInstanceRpc.mockReturnValue(Promise.reject(new Error("down")));
		bindProjectInstance("conduit", "claude-2");
		await vi.waitFor(() => expect(boundInstance()).toBe("personal-claude"));
	});

	it("keeps a newer pick when an older reply or snapshot lands", async () => {
		const first = deferredReply();
		deferredReply();
		bindProjectInstance("conduit", "claude-2");
		bindProjectInstance("conduit", "claude-3");
		applyProjectList(projectList("claude-2"));
		first.resolve(projectList("claude-2"));
		await first.promise;
		expect(getEffectiveInstanceId()).toBe("claude-3");
	});

	it("falls back to the daemon's binding when every pick fails", async () => {
		const first = deferredReply();
		const second = deferredReply();
		bindProjectInstance("conduit", "claude-2");
		bindProjectInstance("conduit", "claude-3");
		first.reject(new Error("down"));
		second.reject(new Error("down"));
		await vi.waitFor(() => expect(boundInstance()).toBe("personal-claude"));
	});

	it("refetches the draft's agents for the new instance", () => {
		bindProjectInstance("conduit", "claude-2");
		expect(getAgentsRpc).toHaveBeenCalledWith({
			projectSlug: "conduit",
			instanceId: "claude-2",
		});
	});
});
