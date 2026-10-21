// Behaviour pin conduit-test-16c8.6: across a build change, a stale tab reloads
// before it sends the new daemon any RPC, and a CLI of another build refuses
// the daemon with a clear message, through the built server and a real browser.
//
// Ways it can fail, each checked below:
// - the stale tab redials /rpc and sends frames (subscriptions, requests) to a
//   daemon whose wire it may not decode: no frame may leave the stale page on
//   a socket opened after the old daemon stopped;
// - the build is learned only over RPC, or not before the dial: a plain HTTP
//   GET /info (a fetch, not a WebSocket) must report the new build before the
//   reload;
// - the tab never reloads, or reloads in a loop: exactly one reload, then the
//   "different builds" banner on the reloaded page;
// - a CLI of another build sends RPC to the daemon, or fails with an unclear
//   error: `conduit --list` exits non-zero naming both builds and the restart;
// - `conduit --status` sends RPC to the mismatched daemon: it must exit
//   non-zero with the same mismatch message;
// - `conduit stop` sends the Shutdown RPC, or cannot stop a mismatched daemon:
//   it must exit 0 only once the recorded pid has exited (SIGTERM, then a
//   bounded wait), and the stopped daemon leaves no build file;
// - a matching CLI is refused: `conduit --list` against its own build exits 0.
//
//   CONDUIT_TEST_DIST=dist pnpm exec playwright test \
//     --config test/e2e/playwright-harness.config.ts --project=desktop \
//     --workers=1 harness-build-mismatch-pin

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Request } from "@playwright/test";
import { isProcessAlive } from "../../../src/lib/instance/managed-opencode-process.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

const ARTIFACT = resolve("test-results/16c8-6-build-mismatch.json");

test.describe.configure({ retries: 0 });
// Started below with a startup bound that tolerates a loaded machine.
test.use({ startHarness: false });
const STARTUP_TIMEOUT_MS = 60_000;
const CLI = { timeoutMs: 60_000 };

test("a stale tab reloads before any RPC to a new build, and a mismatched CLI fails clearly", async ({
	harness,
	page,
}) => {
	test.setTimeout(240_000);
	const { BUILD_ID: buildA } = (await import(
		pathToFileURL(
			resolve(
				process.env["CONDUIT_TEST_DIST"] ?? "dist",
				"src/lib/build-id.js",
			),
		).href
	)) as { BUILD_ID: string };
	expect(buildA, "the pin needs a stamped build").not.toBe("dev");
	const buildB = `${buildA}-B`;
	const buildFile = join(harness.configDir, "relay.sock.build");

	const t0 = Date.now();
	const at = () => Date.now() - t0;
	// Document 1 is the stale tab; each main-frame navigation starts the next.
	let document = 0;
	const navigations: { at: number; url: string }[] = [];
	const sockets: { at: number; document: number; id: number }[] = [];
	const framesSent: {
		at: number;
		document: number;
		socket: number;
		bytes: number;
	}[] = [];
	const buildChecks: {
		at: number;
		document: number;
		method: string;
		resourceType: string;
		status?: number;
		buildId?: unknown;
	}[] = [];
	const checkOf = new Map<Request, (typeof buildChecks)[number]>();
	page.on("request", (request) => {
		if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
			document++;
			navigations.push({ at: at(), url: request.url() });
		}
		if (new URL(request.url()).pathname !== "/info") return;
		const check = {
			at: at(),
			document,
			method: request.method(),
			resourceType: request.resourceType(),
		};
		buildChecks.push(check);
		checkOf.set(request, check);
	});
	page.on("response", async (response) => {
		const check = checkOf.get(response.request());
		if (!check) return;
		check.status = response.status();
		const body: unknown = await response.json().catch(() => null);
		check.buildId =
			typeof body === "object" && body !== null && "buildId" in body
				? body.buildId
				: undefined;
	});
	page.on("websocket", (socket) => {
		if (!new URL(socket.url()).pathname.endsWith("/rpc")) return;
		const entry = { at: at(), document, id: sockets.length };
		sockets.push(entry);
		socket.on("framesent", ({ payload }) => {
			framesSent.push({
				at: at(),
				document: entry.document,
				socket: entry.id,
				bytes: Buffer.byteLength(payload),
			});
		});
	});

	await harness.restart({ startupTimeoutMs: STARTUP_TIMEOUT_MS });
	const matching = await harness.runCli(["--list"], CLI);
	expect(matching.code, matching.output).toBe(0);

	await new AppPage(page).goto(`${harness.baseUrl}/?p=process-test`);
	await expect.poll(() => framesSent.length).toBeGreaterThan(0);

	const stoppedAt = at();
	await harness.terminate();
	await harness.restart({
		keepPort: true,
		startupTimeoutMs: STARTUP_TIMEOUT_MS,
		serviceEnvironment: { CONDUIT_SERVER_BUILD_ID: buildB },
	});
	const restartedAt = at();

	await expect.poll(() => document, { timeout: 30_000 }).toBe(2);
	const reloadAt = navigations[1]?.at ?? Number.NaN;
	await page.locator(".connect-overlay").waitFor({ state: "detached" });
	await expect(
		page.locator(".banner-text", { hasText: "different builds" }),
	).toBeVisible();

	// Sockets the stale tab opened once the old daemon was going away: any of
	// them could reach the new daemon, so none may carry a frame.
	const staleSockets = sockets.filter(
		(socket) => socket.document === 1 && socket.at >= stoppedAt,
	);
	const staleFrames = framesSent.filter((frame) =>
		staleSockets.some((socket) => socket.id === frame.socket),
	);
	const staleBuildChecks = buildChecks.filter(
		(check) => check.document === 1 && check.at >= stoppedAt,
	);
	expect(navigations).toHaveLength(2);
	expect(staleFrames).toEqual([]);
	expect(staleBuildChecks).toContainEqual(
		expect.objectContaining({
			method: "GET",
			resourceType: "fetch",
			status: 200,
			buildId: buildB,
		}),
	);
	expect(
		staleBuildChecks.find(({ buildId }) => buildId === buildB)?.at,
	).toBeLessThan(reloadAt);

	const daemonBuildFile: { buildId: string; pid: number } = JSON.parse(
		readFileSync(buildFile, "utf8"),
	);
	expect(daemonBuildFile).toMatchObject({ buildId: buildB });
	const mismatched = await harness.runCli(["--list"], CLI);
	expect(mismatched.code).not.toBe(0);
	expect(mismatched.output).toContain(
		`Build mismatch: this CLI is build ${buildA}, the running server is build ${buildB}.`,
	);
	expect(mismatched.output).toContain("conduit stop, then conduit serve");
	const status = await harness.runCli(["--status"], CLI);
	expect(status.code).not.toBe(0);
	expect(status.output).toContain(
		`Build mismatch: this CLI is build ${buildA}, the running server is build ${buildB}.`,
	);
	const daemonPid = daemonBuildFile.pid;
	expect(isProcessAlive(daemonPid)).toBe(true);
	const stop = await harness.runCli(["stop"], CLI);
	expect(stop.code, stop.output).toBe(0);
	expect(stop.output).toContain("Server stopped.");
	// The CLI returns only after the pid exits; an RPC stop returns before.
	const daemonExitedOnStop = !isProcessAlive(daemonPid);
	expect(daemonExitedOnStop).toBe(true);
	await harness.waitForExit({ keepBrowsersOpen: true });
	expect(existsSync(buildFile)).toBe(false);

	mkdirSync(resolve("test-results"), { recursive: true });
	writeFileSync(
		ARTIFACT,
		`${JSON.stringify(
			{
				pin: "conduit-test-16c8.6",
				builds: { page: buildA, server: buildB, cli: buildA },
				reload: {
					stoppedAtMs: stoppedAt,
					restartedAtMs: restartedAt,
					reloadAtMs: reloadAt,
					navigations,
					// Checks while no daemon listened get no answer and are retried.
					unansweredBuildChecks: staleBuildChecks.filter(
						(check) => check.status === undefined,
					).length,
					answeredBuildChecksBeforeReload: staleBuildChecks.filter(
						(check) => check.status !== undefined && check.at < reloadAt,
					),
					staleSocketsOpened: staleSockets.length,
					framesSentBeforeStop: framesSent.filter(
						(frame) => frame.at < stoppedAt,
					).length,
					framesSentByStaleTabToNewDaemon: staleFrames,
				},
				cli: {
					matching: { code: matching.code, output: matching.output },
					mismatched: { code: mismatched.code, output: mismatched.output },
					status: { code: status.code, output: status.output },
					stop: { code: stop.code, output: stop.output },
					daemonExitedOnStop,
					daemonBuildFile,
					buildFileRemovedOnStop: !existsSync(buildFile),
				},
			},
			null,
			2,
		)}\n`,
	);
});
