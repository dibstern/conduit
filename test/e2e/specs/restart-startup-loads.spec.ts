// An open tab must reload all startup data without error toasts after a restart.
// Holding /rpc on a dead address lets /ws attach first, making the race deterministic.

import { writeFile } from "node:fs/promises";
import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

type ProbeWindow = typeof window & {
	__holdRpc: boolean;
	__heldRpcDials: number;
	__wsAttachedWhileHeld: boolean;
	__startupLoadErrors: string[];
};

const startupLoads = [
	"GetProjects",
	"GetFileTree",
	"GetAgents",
	"GetModels",
	"GetCommands",
	"ListPtys",
	"ListDaemonSessions",
];

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
		probe.__wsAttachedWhileHeld = false;
		probe.__startupLoadErrors = [];
		const NativeWebSocket = window.WebSocket;
		window.WebSocket = class extends NativeWebSocket {
			constructor(...args: ConstructorParameters<typeof WebSocket>) {
				const [url, protocols] = args;
				const held = probe.__holdRpc && String(url).includes("/rpc");
				if (held) probe.__heldRpcDials++;
				super(held ? "ws://127.0.0.1:9/rpc" : url, protocols);
				if (String(url).includes("/ws")) {
					this.addEventListener("message", ({ data }) => {
						if (!probe.__holdRpc || typeof data !== "string") return;
						const message = JSON.parse(data) as { type: string };
						if (message.type === "project_attached") {
							probe.__wsAttachedWhileHeld = true;
						}
					});
				}
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
				}
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
	const hold = await page.evaluate(() => ({
		heldRpcDials: (window as ProbeWindow).__heldRpcDials,
		wsAttachedWhileHeld: (window as ProbeWindow).__wsAttachedWhileHeld,
	}));
	expect(hold.heldRpcDials).toBeGreaterThan(0);
	expect(hold.wsAttachedWhileHeld).toBe(true);

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
	} finally {
		const artifact = testInfo.outputPath("restart-startup-loads.json");
		await writeFile(
			artifact,
			JSON.stringify({
				...hold,
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
