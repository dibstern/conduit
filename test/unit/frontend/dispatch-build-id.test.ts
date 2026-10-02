import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS_PROTOCOL_VERSION } from "../../../src/lib/shared-types.js";

const mocks = vi.hoisted(() => ({
	refreshAppShell: vi.fn<() => Promise<void>>(),
	persistInputDraft: vi.fn<() => Promise<boolean>>(),
	showBanner: vi.fn(),
	removeBanner: vi.fn(),
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
	showToast: vi.fn(),
	showBanner: mocks.showBanner,
	removeBanner: mocks.removeBanner,
	setClientCount: vi.fn(),
	updateContextPercent: vi.fn(),
}));
vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

describe("build ID dispatch", () => {
	let handleMessage: typeof import("../../../src/lib/frontend/stores/ws-dispatch.js")["handleMessage"];

	beforeEach(async () => {
		vi.resetModules();
		vi.useFakeTimers();
		vi.clearAllMocks();
		mocks.refreshAppShell.mockReset().mockResolvedValue(undefined);
		mocks.persistInputDraft.mockReset().mockResolvedValue(true);
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
		({ handleMessage } = await import(
			"../../../src/lib/frontend/stores/ws-dispatch.js"
		));
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	function handshake(buildId = "B") {
		handleMessage({
			type: "protocol_version",
			version: WS_PROTOCOL_VERSION,
			buildId,
		});
	}

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
		({ handleMessage } = await import(
			"../../../src/lib/frontend/stores/ws-dispatch.js"
		));
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
