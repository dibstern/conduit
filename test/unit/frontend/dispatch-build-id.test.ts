import { Effect, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerStatus } from "../../../src/lib/contracts/ws-rpc.js";
import type {
	WsRpcClient,
	WsRpcClients,
	WsRpcSockets,
} from "../../../src/lib/frontend/transport/shared-client.js";
import type { BannerConfig } from "../../../src/lib/frontend/types.js";
import { WS_PROTOCOL_VERSION } from "../../../src/lib/shared-types.js";

const mocks = vi.hoisted(() => ({
	refreshAppShell: vi.fn<() => Promise<void>>(),
	persistInputDraft: vi.fn<() => Promise<boolean>>(),
	showBanner: vi.fn<(config: BannerConfig) => void>(),
	removeBanner: vi.fn(),
	showToast: vi.fn(),
	restartWithConfig:
		vi.fn<
			(
				input: Parameters<WsRpcClient["RestartWithConfig"]>[0],
			) => Effect.Effect<{
				readonly ok: true;
			}>
		>(),
	reload: vi.fn(),
	inputSyncState: { reloadPending: false },
}));

vi.mock("../../../src/lib/build-id.js", () => ({ BUILD_ID: "A" }));
vi.mock("../../../src/lib/frontend/utils/build-id.js", async (original) => ({
	...(await original<
		typeof import("../../../src/lib/frontend/utils/build-id.js")
	>()),
	refreshAppShell: mocks.refreshAppShell,
}));
vi.mock(
	"../../../src/lib/frontend/stores/chat.svelte.js",
	async (original) => ({
		...(await original<
			typeof import("../../../src/lib/frontend/stores/chat.svelte.js")
		>()),
		persistInputDraft: mocks.persistInputDraft,
		inputSyncState: mocks.inputSyncState,
	}),
);
vi.mock("../../../src/lib/frontend/stores/ui.svelte.js", () => ({
	showToast: mocks.showToast,
	showBanner: mocks.showBanner,
	removeBanner: mocks.removeBanner,
	setClientCount: vi.fn(),
	updateContextPercent: vi.fn(),
}));
vi.mock("../../../src/lib/frontend/transport/runtime.js", async () => {
	const { Effect } = await import("effect");
	const { WsRpcClients } = await import(
		"../../../src/lib/frontend/transport/shared-client.js"
	);
	return {
		runTransportEffect: <A, E>(effect: Effect.Effect<A, E, WsRpcClients>) =>
			Effect.runPromise(
				Effect.provideService(effect, WsRpcClients, {
					forProject: () => {
						const control: Pick<WsRpcClient, "RestartWithConfig"> = {
							RestartWithConfig:
								mocks.restartWithConfig as WsRpcClient["RestartWithConfig"],
						};
						return Effect.succeed({ control } as WsRpcSockets);
					},
				}),
			),
	};
});
vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

describe("build ID dispatch", () => {
	let server: typeof import("../../../src/lib/frontend/stores/server-status.js");
	let current: ServerStatus;
	let setAttachedProject: typeof import("../../../src/lib/frontend/stores/session.svelte.js")["setAttachedProject"];

	beforeEach(async () => {
		vi.resetModules();
		vi.useFakeTimers();
		vi.clearAllMocks();
		mocks.refreshAppShell.mockReset().mockResolvedValue(undefined);
		mocks.persistInputDraft.mockReset().mockResolvedValue(true);
		mocks.restartWithConfig
			.mockReset()
			.mockImplementation(() => Effect.succeed({ ok: true as const }));
		mocks.inputSyncState.reloadPending = false;
		const entries = new Map<string, string>();
		vi.stubGlobal("sessionStorage", {
			getItem: (key: string) => entries.get(key) ?? null,
			setItem: (key: string, value: string) => entries.set(key, value),
			removeItem: (key: string) => entries.delete(key),
		});
		vi.stubGlobal("location", { reload: mocks.reload });
		vi.stubGlobal(
			"WebSocket",
			class {
				static readonly OPEN = 1;
				static readonly CLOSED = 3;
				readyState = 1;
				send(_data: string): void {}
				addEventListener(
					_event: string,
					_listener: (event?: unknown) => void,
				): void {}
				close(): void {
					this.readyState = 3;
				}
			},
		);
		vi.stubGlobal("window", {
			location: { protocol: "http:", host: "localhost:3000", pathname: "/" },
			history: { pushState: () => {}, replaceState: () => {} },
			addEventListener: () => {},
		});
		current = {
			protocolVersion: WS_PROTOCOL_VERSION,
			buildId: "A",
			restartAvailable: false,
			sessionsRevision: 0,
		};
		await load();
	});

	async function load() {
		({ setAttachedProject } = await import(
			"../../../src/lib/frontend/stores/session.svelte.js"
		));
		server = await import("../../../src/lib/frontend/stores/server-status.js");
	}

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	/** A fresh connection: the feed starts over and delivers its snapshot. */
	function handshake(buildId = "B") {
		current = { ...current, buildId };
		Effect.runSync(
			Stream.runForEach(
				server.serverStatusFeed({ serverStatus: () => Stream.make(current) }),
				(status) => Effect.sync(() => server.applyServerStatus(status)),
			),
		);
	}

	function serverUpdate(restartAvailable: boolean) {
		current = { ...current, restartAvailable };
		server.applyServerStatus(current);
	}

	function restartAction() {
		const banner = mocks.showBanner.mock.calls
			.map(([config]) => config)
			.reverse()
			.find((config) => config.id === "server-update");
		expect(banner?.action?.label).toBe("Restart");
		if (!banner?.action) throw new Error("No server restart action");
		return banner.action.run;
	}

	it("shows the restart action when a server build is ready after a project UI reset", async () => {
		serverUpdate(true);
		const { onProjectAttached } = await import(
			"../../../src/lib/frontend/stores/ws-listeners.js"
		);
		const unsubscribe = onProjectAttached(() => mocks.showBanner.mockClear());
		setAttachedProject("test-project");
		unsubscribe();
		expect(mocks.showBanner).toHaveBeenCalledWith({
			id: "server-update",
			variant: "update",
			icon: "refresh-cw",
			text: "A new conduit build is ready. Restart the server to load it. Sessions and terminals keep running.",
			summary: "New build ready",
			dismissible: true,
			action: { label: "Restart", run: expect.any(Function) },
		});
	});

	it("removes the banner and disables its stale action when restart is unavailable", async () => {
		serverUpdate(true);
		const run = restartAction();
		serverUpdate(false);
		await run();
		expect(mocks.removeBanner).toHaveBeenCalledWith("server-update");
		expect(mocks.restartWithConfig).not.toHaveBeenCalled();
	});

	it("restarts through the RPC with no config and removes the banner on success", async () => {
		serverUpdate(true);
		await restartAction()();
		expect(mocks.restartWithConfig).toHaveBeenCalledExactlyOnceWith({});
		expect(mocks.removeBanner).toHaveBeenCalledWith("server-update");
		expect(mocks.showToast).toHaveBeenCalledWith("Restarting conduit…");
	});

	it("ignores repeated restart clicks during and after an accepted request", async () => {
		let finishRestart!: () => void;
		const pending = new Promise<{ readonly ok: true }>((resolve) => {
			finishRestart = () => resolve({ ok: true });
		});
		mocks.restartWithConfig.mockImplementation(() =>
			Effect.promise(() => pending),
		);
		serverUpdate(true);
		const run = restartAction();
		const first = run();
		const second = run();
		await vi.advanceTimersByTimeAsync(0);
		expect(mocks.restartWithConfig).toHaveBeenCalledTimes(1);
		serverUpdate(false);
		serverUpdate(true);
		const third = run();
		await vi.advanceTimersByTimeAsync(0);
		expect(mocks.restartWithConfig).toHaveBeenCalledTimes(1);
		serverUpdate(false);
		finishRestart();
		await Promise.all([first, second, third]);
		setAttachedProject("test-project");
		serverUpdate(true);
		await run();
		expect(mocks.restartWithConfig).toHaveBeenCalledTimes(1);
	});

	it("restores the restart action after an error so it can be retried", async () => {
		mocks.restartWithConfig.mockImplementationOnce(() =>
			Effect.promise(() => Promise.reject(new Error("restart rejected"))),
		);
		serverUpdate(true);
		const run = restartAction();
		mocks.showBanner.mockClear();
		await run();
		expect(mocks.showToast).toHaveBeenCalledWith(
			expect.stringContaining("restart rejected"),
			{ variant: "error" },
		);
		await restartAction()();
		expect(mocks.restartWithConfig).toHaveBeenCalledTimes(2);
		expect(mocks.showToast).toHaveBeenCalledWith("Restarting conduit…");
	});

	it("does not restore an obsolete restart banner when a pending request fails", async () => {
		let failRestart!: () => void;
		const pending = new Promise<{ readonly ok: true }>((_resolve, reject) => {
			failRestart = () => reject(new Error("restart rejected"));
		});
		mocks.restartWithConfig.mockImplementation(() =>
			Effect.promise(() => pending),
		);
		serverUpdate(true);
		const request = restartAction()();
		await vi.advanceTimersByTimeAsync(0);
		serverUpdate(false);
		mocks.showBanner.mockClear();
		failRestart();
		await request;
		expect(mocks.showBanner).not.toHaveBeenCalled();
	});

	it("suppresses a build mismatch while restart is available and restores it when unavailable", () => {
		sessionStorage.setItem("conduit-build-reload:B", "1");
		handshake();
		expect(mocks.showBanner).toHaveBeenCalledWith(
			expect.objectContaining({ id: "build-mismatch" }),
		);
		serverUpdate(true);
		expect(mocks.removeBanner).toHaveBeenCalledWith("build-mismatch");
		mocks.showBanner.mockClear();
		handshake();
		expect(mocks.showBanner).not.toHaveBeenCalledWith(
			expect.objectContaining({ id: "build-mismatch" }),
		);
		serverUpdate(false);
		expect(mocks.showBanner).toHaveBeenCalledWith(
			expect.objectContaining({ id: "build-mismatch" }),
		);
	});

	it("does not restore a mismatch after the server reports a matching build", () => {
		sessionStorage.setItem("conduit-build-reload:B", "1");
		handshake();
		serverUpdate(true);
		handshake("A");
		mocks.showBanner.mockClear();
		serverUpdate(false);
		expect(mocks.showBanner).not.toHaveBeenCalled();
	});

	it("keeps automatic draft-saving reloads working while restart is available", async () => {
		serverUpdate(true);
		handshake();
		await vi.runAllTimersAsync();
		expect(mocks.refreshAppShell).toHaveBeenCalledTimes(1);
		expect(mocks.persistInputDraft).toHaveBeenCalledTimes(1);
		expect(mocks.reload).toHaveBeenCalledTimes(1);
	});

	it("defers a failed reload warning until restart is unavailable", async () => {
		mocks.persistInputDraft.mockResolvedValueOnce(false);
		serverUpdate(true);
		handshake();
		mocks.showBanner.mockClear();
		await vi.runAllTimersAsync();
		expect(mocks.showBanner).not.toHaveBeenCalled();
		serverUpdate(false);
		expect(mocks.showBanner).toHaveBeenCalledWith(
			expect.objectContaining({ id: "build-mismatch" }),
		);
		expect(mocks.reload).not.toHaveBeenCalled();
	});

	it.each([
		"worker update",
		"draft save",
	])("releases an aborted reload claim after a failed %s and retries the same build", async (failure) => {
		const preparation =
			failure === "worker update"
				? mocks.refreshAppShell
				: mocks.persistInputDraft;
		preparation.mockRejectedValueOnce(new Error("temporary failure"));
		handshake();
		await vi.runAllTimersAsync();

		expect(mocks.reload).not.toHaveBeenCalled();
		expect(mocks.inputSyncState.reloadPending).toBe(false);
		expect(mocks.showBanner).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "build-mismatch",
				dismissible: false,
			}),
		);
		expect(sessionStorage.getItem("conduit-build-reload:B")).toBeNull();

		handshake();
		await vi.runAllTimersAsync();
		expect(mocks.reload).toHaveBeenCalledTimes(1);
		expect(sessionStorage.getItem("conduit-build-reload:B")).toBe("1");
	});

	it("warns when attachments defer saving, then retries after they are removed", async () => {
		mocks.persistInputDraft.mockResolvedValueOnce(false);
		handshake();
		await vi.runAllTimersAsync();
		expect(mocks.reload).not.toHaveBeenCalled();
		expect(mocks.showBanner).toHaveBeenCalledWith(
			expect.objectContaining({ id: "build-mismatch" }),
		);
		expect(mocks.inputSyncState.reloadPending).toBe(false);
		expect(sessionStorage.getItem("conduit-build-reload:B")).toBeNull();

		handshake();
		await vi.runAllTimersAsync();
		expect(mocks.reload).toHaveBeenCalledTimes(1);
	});

	it("keeps a completed reload marker and warns on a later page load", async () => {
		handshake();
		await vi.runAllTimersAsync();
		expect(mocks.reload).toHaveBeenCalledTimes(1);
		vi.resetModules();
		await load();
		handshake();
		await vi.runAllTimersAsync();
		expect(mocks.reload).toHaveBeenCalledTimes(1);
		expect(mocks.showBanner).toHaveBeenCalledWith(
			expect.objectContaining({ id: "build-mismatch" }),
		);
	});

	it("never reloads a matching build", async () => {
		handshake("A");
		await vi.runAllTimersAsync();
		expect(mocks.refreshAppShell).not.toHaveBeenCalled();
		expect(mocks.persistInputDraft).not.toHaveBeenCalled();
		expect(mocks.reload).not.toHaveBeenCalled();
	});
});
