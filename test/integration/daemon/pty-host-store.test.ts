import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	decodeMessage,
	preloadDecoder,
} from "../../../src/lib/frontend/effect-boundary.js";
import {
	applyPtyListResponse,
	destroyAll,
	getScrollback,
	handlePtyCreated,
	handlePtyDeleted,
	handlePtyExited,
	handlePtyList,
	handlePtyOutput,
	onOutput,
	renameTab,
	terminalState,
} from "../../../src/lib/frontend/stores/terminal.svelte.js";
import type { RelayMessage } from "../../../src/lib/frontend/types.js";
import type { PtyHostClient as HostClient } from "../../../src/lib/terminal/pty-host-client.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";
import { createPtySocketProxy } from "../../helpers/pty-host-fixture.js";

const DIST = fileURLToPath(new URL("../../../dist/", import.meta.url));
const { PtyHostClient, stopPtyHost } = (await import(
	pathToFileURL(join(DIST, "src/lib/terminal/pty-host-client.js")).href
)) as typeof import("../../../src/lib/terminal/pty-host-client.js");
const { ptyHostSocketPath } = (await import(
	pathToFileURL(join(DIST, "src/lib/terminal/pty-host-protocol.js")).href
)) as typeof import("../../../src/lib/terminal/pty-host-protocol.js");
const { BUILD_ID } = (await import(
	pathToFileURL(join(DIST, "src/lib/build-id.js")).href
)) as typeof import("../../../src/lib/build-id.js");

function printMarker(marker: string): string {
	return `printf '%s%s\\n' '${marker.slice(0, 4)}' '${marker.slice(4)}'`;
}

function feedStore(message: Record<string, unknown>): void {
	if (!String(message["type"]).startsWith("pty_")) return;
	const msg = decodeMessage(message) as RelayMessage;
	switch (msg.type) {
		case "pty_list":
			handlePtyList(msg);
			break;
		case "pty_created":
			handlePtyCreated(msg);
			break;
		case "pty_output":
			handlePtyOutput(msg);
			break;
		case "pty_exited":
			handlePtyExited(msg);
			break;
		case "pty_deleted":
			handlePtyDeleted(msg);
	}
}

async function list(browser: ProcessBrowser) {
	const ptys = await browser.listPtys();
	applyPtyListResponse({ projectSlug: "process-test", ptys });
	return ptys;
}

describe("built PTY reconnect with the same frontend terminal store", () => {
	let harness: ProcessHarness | undefined;
	let realConfig: string | undefined;
	let proxy: Awaited<ReturnType<typeof createPtySocketProxy>> | undefined;
	const clients: HostClient[] = [];
	const subscriptions: Array<() => void> = [];
	let ptyId = "";
	let rendered = "";
	let resetCount = 0;
	let evidence: Record<string, unknown> = {};

	beforeEach(async () => {
		await preloadDecoder();
		destroyAll();
		rendered = "";
		resetCount = 0;
		evidence = { assertionsCompleted: false };
	});

	afterEach(async (context) => {
		const snapshot = {
			storeOutput: getScrollback(ptyId).join(""),
			rendered,
			resetCount,
			tab: terminalState.tabs.get(ptyId),
		};
		for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
		for (const client of clients.splice(0)) client.disconnect();
		try {
			proxy?.resume();
			if (realConfig) await stopPtyHost({ configDir: realConfig, force: true });
			await proxy?.dispose();
			await harness?.dispose();
		} finally {
			mkdirSync("test-results/85kb-11", { recursive: true });
			writeFileSync(
				`test-results/85kb-11/${context.task.name.replace(/\W+/g, "-")}.json`,
				JSON.stringify(
					{
						test: context.task.name,
						builtDist: DIST,
						serverBuildId: BUILD_ID,
						...evidence,
						frontend: snapshot,
						harness: harness?.proof(),
					},
					null,
					2,
				),
			);
			destroyAll();
			harness = undefined;
			realConfig = undefined;
			proxy = undefined;
			ptyId = "";
		}
	});

	function mountTerminal(browser: ProcessBrowser, id: string): void {
		ptyId = id;
		subscriptions.push(browser.onMessage(feedStore));
		rendered = getScrollback(id).join("");
		subscriptions.push(
			onOutput(id, (data: string, replace?: boolean) => {
				if (replace) resetCount++;
				rendered = replace ? data : rendered + data;
			}),
		);
		renameTab(id, "Persistent shell");
	}

	it("replaces replay in the open-page store after a same-build server restart", async () => {
		harness = await ProcessHarness.start({ dist: DIST });
		const first = await harness.connect();
		const pty = await first.createPty();
		mountTerminal(first, pty.id);
		const host = await PtyHostClient.connect({
			configDir: harness.configDir,
			start: false,
		});
		clients.push(host);
		const historical = `85kb-store-history-${randomUUID()}`;
		const missed = `85kb-store-restart-gap-${randomUUID()}`;
		const trigger = join(harness.root, "store-restart-trigger");
		const finished = join(harness.root, "store-restart-finished");
		first.inputPty(
			pty.id,
			`stty -echo; (while [ ! -f '${trigger}' ]; do sleep 0.02; done; ${printMarker(missed)}; : > '${finished}') & ${printMarker(historical)}\n`,
		);
		await vi.waitFor(() => expect(rendered).toContain(historical));
		expect(getScrollback(pty.id).join("").split(historical)).toHaveLength(2);
		await harness.kill();
		writeFileSync(trigger, "go");
		await vi.waitFor(() => expect(existsSync(finished)).toBe(true));
		await harness.restart({ probe: false });
		const reconnected = await harness.connect(undefined, first.originId);
		subscriptions.push(reconnected.onMessage(feedStore));
		const listed = await list(reconnected);
		await vi.waitFor(() => expect(rendered).toContain(missed));
		const replay = getScrollback(pty.id).join("");
		evidence = {
			assertionsCompleted: false,
			hostPid: host.hello.pid,
			buildId: host.hello.buildId,
			shellPid: pty.pid,
			historical,
			missed,
			historyCount: replay.split(historical).length - 1,
			missedCount: replay.split(missed).length - 1,
		};
		expect(listed.find((entry) => entry.id === pty.id)?.pid).toBe(pty.pid);
		expect(replay.split(historical)).toHaveLength(2);
		expect(replay.split(missed)).toHaveLength(2);
		expect(replay.indexOf(historical)).toBeLessThan(replay.indexOf(missed));
		expect(rendered).toBe(replay);
		expect(resetCount).toBeGreaterThan(0);
		expect(terminalState.tabs.get(pty.id)?.title).toBe("Persistent shell");
		const current = await PtyHostClient.connect({
			configDir: harness.configDir,
			start: false,
		});
		clients.push(current);
		expect(current.hello.pid).toBe(host.hello.pid);
		expect(current.hello.buildId).toBe(host.hello.buildId);
		evidence["assertionsCompleted"] = true;
	}, 60_000);

	it("replays missed output once into the mounted store after only the host socket drops", async () => {
		harness = await ProcessHarness.start({ dist: DIST });
		realConfig = join(harness.root, "real-host");
		mkdirSync(realConfig, { mode: 0o700 });
		const host = await PtyHostClient.connect({ configDir: realConfig });
		clients.push(host);
		proxy = await createPtySocketProxy(
			harness.root,
			ptyHostSocketPath(realConfig),
		);
		const browser = await harness.connect();
		const pty = await browser.createPty();
		mountTerminal(browser, pty.id);
		const historical = `85kb-store-before-drop-${randomUUID()}`;
		const missed = `85kb-store-during-drop-${randomUUID()}`;
		const live = `85kb-store-after-drop-${randomUUID()}`;
		const trigger = join(harness.root, "socket-drop-trigger");
		const finished = join(harness.root, "socket-drop-finished");
		browser.inputPty(
			pty.id,
			`stty -echo; (while [ ! -f '${trigger}' ]; do sleep 0.02; done; ${printMarker(missed)}; : > '${finished}') & ${printMarker(historical)}\n`,
		);
		await vi.waitFor(() => expect(rendered).toContain(historical));
		expect(proxy.connections).toBeGreaterThan(0);
		proxy.drop();
		writeFileSync(trigger, "go");
		await vi.waitFor(() => expect(existsSync(finished)).toBe(true));
		expect(getScrollback(pty.id).join("")).not.toContain(missed);
		expect(browser.connected).toBe(true);
		expect(host.connected).toBe(true);
		proxy.resume();
		evidence = {
			assertionsCompleted: false,
			hostPid: host.hello.pid,
			buildId: host.hello.buildId,
			shellPid: pty.pid,
			historical,
			missed,
			live,
			browserConnectedDuringDrop: browser.connected,
			hostConnectedDuringDrop: host.connected,
			missedWrittenWhileDropped: existsSync(finished),
			phase: "waiting-for-missed-output-replay",
		};
		const listed = await list(browser);
		await vi.waitFor(() => expect(rendered).toContain(missed), {
			timeout: 15_000,
		});
		browser.inputPty(pty.id, `${printMarker(live)}\n`);
		await vi.waitFor(() => expect(rendered).toContain(live));
		await list(browser);
		const replay = getScrollback(pty.id).join("");
		expect(listed.find((entry) => entry.id === pty.id)?.pid).toBe(pty.pid);
		for (const marker of [historical, missed, live]) {
			expect(replay.split(marker)).toHaveLength(2);
			expect(rendered.split(marker)).toHaveLength(2);
		}
		expect(replay.indexOf(historical)).toBeLessThan(replay.indexOf(missed));
		expect(replay.indexOf(missed)).toBeLessThan(replay.indexOf(live));
		expect(rendered).toBe(replay);
		expect(resetCount).toBeGreaterThan(0);
		expect(terminalState.tabs.get(pty.id)?.exited).toBe(false);
		expect(terminalState.tabs.get(pty.id)?.title).toBe("Persistent shell");
		evidence["assertionsCompleted"] = true;
		evidence["phase"] = "reattached-and-live";
		evidence["proxyConnections"] = proxy.connections;
	}, 60_000);

	it("preserves the open tab when in-flight host discovery fails and then resyncs it", async () => {
		harness = await ProcessHarness.start({ dist: DIST });
		realConfig = join(harness.root, "real-host");
		mkdirSync(realConfig, { mode: 0o700 });
		const host = await PtyHostClient.connect({ configDir: realConfig });
		clients.push(host);
		proxy = await createPtySocketProxy(
			harness.root,
			ptyHostSocketPath(realConfig),
		);
		const browser = await harness.connect();
		const pty = await browser.createPty();
		mountTerminal(browser, pty.id);
		const historical = `85kb-store-list-reset-${randomUUID()}`;
		const live = `85kb-store-list-recovered-${randomUUID()}`;
		browser.inputPty(pty.id, `stty -echo; ${printMarker(historical)}\n`);
		await vi.waitFor(() => expect(rendered).toContain(historical));
		proxy.dropNextList();
		const failedListRejected = await list(browser).then(
			() => false,
			() => true,
		);
		const afterFailure = getScrollback(pty.id).join("");
		const tabAfterFailure = terminalState.tabs.get(pty.id);
		evidence = {
			assertionsCompleted: false,
			hostPid: host.hello.pid,
			buildId: host.hello.buildId,
			shellPid: pty.pid,
			historical,
			live,
			failedListRejected,
			listDrops: proxy.listDrops,
			tabKeptAfterFailure: Boolean(tabAfterFailure),
			titleAfterFailure: tabAfterFailure?.title,
			historyCountAfterFailure: afterFailure.split(historical).length - 1,
		};
		expect(proxy.listDrops).toBe(1);
		expect(failedListRejected).toBe(true);
		expect(tabAfterFailure?.title).toBe("Persistent shell");
		expect(afterFailure.split(historical)).toHaveLength(2);
		const listed = await list(browser);
		expect(listed.find((entry) => entry.id === pty.id)?.pid).toBe(pty.pid);
		browser.inputPty(pty.id, `${printMarker(live)}\n`);
		await vi.waitFor(() => expect(rendered).toContain(live));
		const recovered = getScrollback(pty.id).join("");
		expect(recovered.split(historical)).toHaveLength(2);
		expect(recovered.split(live)).toHaveLength(2);
		expect(rendered).toBe(recovered);
		expect(terminalState.tabs.get(pty.id)?.title).toBe("Persistent shell");
		expect(terminalState.tabs.get(pty.id)?.exited).toBe(false);
		evidence["assertionsCompleted"] = true;
	}, 60_000);

	it("closes the surviving shell through an unavailable proxy without resurrecting its tab", async () => {
		harness = await ProcessHarness.start({ dist: DIST });
		realConfig = join(harness.root, "real-host");
		mkdirSync(realConfig, { mode: 0o700 });
		const host = await PtyHostClient.connect({ configDir: realConfig });
		clients.push(host);
		proxy = await createPtySocketProxy(
			harness.root,
			ptyHostSocketPath(realConfig),
		);
		const browser = await harness.connect();
		const pty = await browser.createPty();
		mountTerminal(browser, pty.id);
		const marker = `85kb-store-before-close-${randomUUID()}`;
		browser.inputPty(pty.id, `stty -echo; ${printMarker(marker)}\n`);
		await vi.waitFor(() => expect(rendered).toContain(marker));
		const observer = await PtyHostClient.connect({
			configDir: harness.configDir,
			start: false,
		});
		clients.push(observer);
		proxy.drop();
		await vi.waitFor(() => expect(observer.connected).toBe(false));
		evidence = {
			assertionsCompleted: false,
			hostPid: host.hello.pid,
			buildId: host.hello.buildId,
			shellPid: pty.pid,
			ptyId: pty.id,
			phase: "waiting-for-close-proxy-notification",
		};
		await vi.waitFor(
			() => expect(terminalState.tabs.get(pty.id)?.exited).toBe(true),
			{ timeout: 5_000 },
		);
		proxy.resume();
		await browser.closePty(pty.id);
		const shellKilled = await vi
			.waitFor(() => expect(() => process.kill(pty.pid, 0)).toThrow(), {
				timeout: 2_000,
			})
			.then(
				() => true,
				() => false,
			);
		const listed = await list(browser);
		evidence = {
			assertionsCompleted: false,
			hostPid: host.hello.pid,
			buildId: host.hello.buildId,
			shellPid: pty.pid,
			ptyId: pty.id,
			observerDisconnected: !observer.connected,
			shellKilled,
			listedIds: listed.map((entry) => entry.id),
			tabResurrected: terminalState.tabs.has(pty.id),
		};
		expect(shellKilled).toBe(true);
		expect(listed.some((entry) => entry.id === pty.id)).toBe(false);
		expect(terminalState.tabs.has(pty.id)).toBe(false);
		evidence["assertionsCompleted"] = true;
	}, 60_000);

	it("removes a naturally exited hosted terminal after its proxy connection drops", async () => {
		harness = await ProcessHarness.start({ dist: DIST });
		realConfig = join(harness.root, "real-host");
		mkdirSync(realConfig, { mode: 0o700 });
		const host = await PtyHostClient.connect({ configDir: realConfig });
		clients.push(host);
		proxy = await createPtySocketProxy(
			harness.root,
			ptyHostSocketPath(realConfig),
		);
		const browser = await harness.connect();
		const pty = await browser.createPty();
		mountTerminal(browser, pty.id);
		const marker = `85kb-store-natural-exit-${randomUUID()}`;
		const cursor = browser.frames.length;
		browser.inputPty(pty.id, `stty -echo; ${printMarker(marker)}; exit 0\n`);
		const exit = await browser.waitFor(
			(message) =>
				message["type"] === "pty_exited" &&
				message["ptyId"] === pty.id &&
				message["exitCode"] === 0,
			cursor,
		);
		expect(getScrollback(pty.id).join("")).toContain(marker);
		expect(terminalState.tabs.get(pty.id)?.exited).toBe(true);
		const observer = await PtyHostClient.connect({
			configDir: harness.configDir,
			start: false,
		});
		clients.push(observer);
		proxy.drop();
		await vi.waitFor(() => expect(observer.connected).toBe(false));
		proxy.resume();
		await browser.closePty(pty.id);
		const listed = await list(browser);
		evidence = {
			assertionsCompleted: false,
			hostPid: host.hello.pid,
			buildId: host.hello.buildId,
			shellPid: pty.pid,
			ptyId: pty.id,
			naturalExitObserved: true,
			naturalExitCode: exit["exitCode"],
			observerDisconnected: !observer.connected,
			listedIds: listed.map((entry) => entry.id),
			tabResurrected: terminalState.tabs.has(pty.id),
		};
		expect(listed.some((entry) => entry.id === pty.id)).toBe(false);
		expect(terminalState.tabs.has(pty.id)).toBe(false);
		evidence["assertionsCompleted"] = true;
	}, 60_000);
});
