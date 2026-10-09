// An open tab must reload all startup data without error toasts after a restart.
// Holding /rpc on a dead address makes its restart outage deterministic.
// Once released, /rpc must be back within the budget: the socket retries at
// most a second apart (shared-client.ts), not on the library's 5 s default.

import { writeFile } from "node:fs/promises";
import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

type ProbeWindow = typeof window & {
	__holdRpc: boolean;
	__heldRpcDials: number;
	__startupLoadErrors: string[];
};

const startupLoads = [
	"GetProjects",
	"GetFileTree",
	"GetAgents",
	"GetModels",
	"GetCommands",
	"ListDaemonSessions",
];

// Socket retry cap (1 s) + resume re-issue cap (1 s), with headroom. Timed to
// the last startup request sent, not answered: the answers wait on the server,
// which a loaded machine slows past any budget (7.9 s in a full parallel run).
// The old 5 s retry cap would exceed it on its own.
const resendBudgetMs = 3_000;

test.use({ claudeReplay: { turns: [] } });

test("an open tab reloads startup data after the control socket reconnects", async ({
	page,
	relayUrl,
	harness,
}, testInfo) => {
	await page.addInitScript(() => {
		const probe = window as ProbeWindow;
		probe.__holdRpc = false;
		probe.__heldRpcDials = 0;
		probe.__startupLoadErrors = [];
		const NativeWebSocket = window.WebSocket;
		window.WebSocket = class extends NativeWebSocket {
			constructor(...args: ConstructorParameters<typeof WebSocket>) {
				const [url, protocols] = args;
				const held = probe.__holdRpc && String(url).includes("/rpc");
				if (held) probe.__heldRpcDials++;
				super(held ? "ws://127.0.0.1:9/rpc" : url, protocols);
			}
		};
		new MutationObserver((records) => {
			for (const record of records) {
				const nodes =
					record.type === "characterData"
						? [record.target]
						: [...record.addedNodes];
				for (const node of nodes) {
					probe.__startupLoadErrors.push(
						...(node.textContent?.match(
							/Failed to load (projects|file tree)/g,
						) ?? []),
					);
				}
			}
		}).observe(document, {
			childList: true,
			characterData: true,
			subtree: true,
		});
	});

	let restarting = false;
	const initialAnswered = new Set<string>();
	const restartAnswered = new Set<string>();
	let allAnsweredAt: number | undefined;
	let allSentAt: number | undefined;
	const restartSent = new Set<string>();
	let releasedAt = 0;
	const sentMs = () =>
		allSentAt === undefined ? null : allSentAt - releasedAt;
	const reloadMs = () =>
		allAnsweredAt === undefined ? null : allAnsweredAt - releasedAt;
	page.on("websocket", (socket) => {
		if (!socket.url().includes("/rpc")) return;
		const answered = restarting ? restartAnswered : initialAnswered;
		const requests = new Map<string, string>();
		socket.on("framesent", ({ payload }) => {
			for (const line of payload.toString().split("\n").filter(Boolean)) {
				const request = JSON.parse(line) as {
					_tag: string;
					id: string;
					tag: string;
				};
				if (request._tag === "Request" && startupLoads.includes(request.tag)) {
					requests.set(request.id, request.tag);
					if (restarting) restartSent.add(request.tag);
				}
				if (restarting && restartSent.size === startupLoads.length)
					allSentAt ??= Date.now();
			}
		});
		socket.on("framereceived", ({ payload }) => {
			for (const line of payload.toString().split("\n").filter(Boolean)) {
				const response = JSON.parse(line) as {
					_tag: string;
					requestId: string;
					exit: { _tag: string };
				};
				// Any server Exit counts: the bug fails the call client-side before a
				// frame is sent. This harness has no daemon, so ListDaemonSessions
				// is answered with a typed "not supported" Failure.
				if (response._tag !== "Exit") continue;
				const tag = requests.get(response.requestId);
				if (tag) answered.add(tag);
				if (restarting && restartAnswered.size === startupLoads.length)
					allAnsweredAt ??= Date.now();
			}
		});
	});

	await new AppPage(page).goto(relayUrl);
	await expect
		.poll(() => startupLoads.filter((tag) => initialAnswered.has(tag)), {
			timeout: 20_000,
		})
		.toEqual(startupLoads);

	await page.evaluate(() => {
		const probe = window as ProbeWindow;
		probe.__startupLoadErrors = [];
		probe.__holdRpc = true;
	});
	restarting = true;
	await harness.restart();
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => {
				setTimeout(() => {
					(window as ProbeWindow).__holdRpc = false;
					resolve();
				}, 2_000);
			}),
	);
	releasedAt = Date.now();
	const hold = await page.evaluate(() => ({
		heldRpcDials: (window as ProbeWindow).__heldRpcDials,
	}));
	expect(hold.heldRpcDials).toBeGreaterThan(0);

	try {
		await expect
			.poll(
				async () => ({
					answeredExits: startupLoads.filter((tag) => restartAnswered.has(tag)),
					loadErrors: await page.evaluate(
						() => (window as ProbeWindow).__startupLoadErrors,
					),
				}),
				{ timeout: 20_000 },
			)
			.toEqual({ answeredExits: startupLoads, loadErrors: [] });
		expect(sentMs()).toBeLessThan(resendBudgetMs);
	} finally {
		const artifact = testInfo.outputPath("restart-startup-loads.json");
		await writeFile(
			artifact,
			JSON.stringify({
				...hold,
				sentMs: sentMs(),
				reloadMs: reloadMs(),
				answeredExits: startupLoads.filter((tag) => restartAnswered.has(tag)),
				loadErrors: await page.evaluate(
					() => (window as ProbeWindow).__startupLoadErrors,
				),
			}),
		);
		await testInfo.attach("restart-startup-loads", {
			path: artifact,
			contentType: "application/json",
		});
	}
});
