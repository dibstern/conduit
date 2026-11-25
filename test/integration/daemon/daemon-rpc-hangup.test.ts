import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";

// A CLI request whose client gives up first, as dev:all's readiness probe does
// while a server boots, ends that connection with a socket error. The server
// reported each one as "Unhandled error in SocketServer".
it("a client that hangs up mid-request ends only its connection, quietly", async () => {
	const root = mkdtempSync(join(tmpdir(), "conduit-rpc-hangup-"));
	const server = spawn(
		process.execPath,
		[
			resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist", "src/bin/cli.js"),
			"serve",
			"--port",
			"0",
			"--no-https",
			"--log-format",
			"json",
		],
		{
			cwd: root,
			env: {
				...process.env,
				HOME: root,
				CONDUIT_CONFIG_DIR: root,
				CONDUIT_SERVICE: undefined,
				XPC_SERVICE_NAME: undefined,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let output = "";
	const ready = new Promise<void>((resolve) => {
		const read = (data: Buffer) => {
			output += data.toString();
			if (output.includes("Ready.")) resolve();
		};
		server.stdout.on("data", read);
		server.stderr.on("data", read);
	});
	const exited = once(server, "exit");
	onTestFinished(() => {
		server.kill("SIGKILL");
		mkdirSync("test-results/daemon-rpc-hangup", { recursive: true });
		writeFileSync("test-results/daemon-rpc-hangup/server.log", output);
		rmSync(root, { recursive: true, force: true });
	});
	await ready;
	const socket = join(root, "relay.sock");
	for (let attempt = 0; attempt < 5; attempt++) {
		await expect(
			sendRpcRequest(
				socket,
				{ _tag: "GetStatus" },
				{ requestTimeoutMs: 1, startupRetries: 0 },
			),
		).rejects.toThrow("timed out");
	}
	const status = await sendRpcRequest(socket, { _tag: "GetStatus" });
	expect(status.port).toBeGreaterThan(0);
	// A clean stop flushes every log line the hang-ups wrote.
	server.kill("SIGTERM");
	await exited;
	expect(output).toContain("Ready.");
	expect(output).not.toContain("Unhandled error in SocketServer");
});
