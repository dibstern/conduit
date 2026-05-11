import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { DaemonLifecycleContext } from "../../../src/lib/daemon/daemon-lifecycle.js";
import {
	closeHttpServer,
	startHttpServer,
} from "../../../src/lib/daemon/daemon-lifecycle.js";
import { makeTestTlsCerts } from "../../helpers/tls-cert-fixture.js";

const fixtureCerts = makeTestTlsCerts();

function makeContext(): DaemonLifecycleContext {
	return {
		httpServer: null,
		upgradeServer: null,
		onboardingServer: null,
		ipcServer: null,
		ipcClients: new Set(),
		clientCount: 0,
		socketPath: "/tmp/conduit-daemon-lifecycle-bind.sock",
		router: {
			async handleRequest(_req, res) {
				res.writeHead(200, { "Content-Type": "text/plain" });
				res.end("ok");
			},
		},
	};
}

function boundAddress(ctx: DaemonLifecycleContext): AddressInfo {
	const addr = ctx.httpServer?.address();
	if (!addr || typeof addr === "string") {
		throw new Error("HTTP server did not bind to an IP address");
	}
	return addr;
}

function httpsGet(
	port: number,
	path: string,
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = httpsRequest(
			{
				hostname: "127.0.0.1",
				port,
				path,
				method: "GET",
				rejectUnauthorized: false,
			},
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					body += chunk;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

function httpGet(
	port: number,
	path: string,
): Promise<{
	status: number;
	headers: Record<string, string | string[] | undefined>;
}> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{
				hostname: "127.0.0.1",
				port,
				path,
				method: "GET",
			},
			(res) => {
				res.resume();
				res.on("end", () =>
					resolve({ status: res.statusCode ?? 0, headers: res.headers }),
				);
			},
		);
		req.on("error", reject);
		req.end();
	});
}

describe("startHttpServer bind config", () => {
	it("binds to 127.0.0.1 and returns the actual port", async () => {
		const ctx = makeContext();
		try {
			const actualPort = await startHttpServer(ctx, {
				port: 0,
				host: "127.0.0.1",
			});
			const addr = boundAddress(ctx);

			expect(addr.address).toBe("127.0.0.1");
			expect(addr.port).toBeGreaterThan(0);
			expect(actualPort).toBe(addr.port);
		} finally {
			await closeHttpServer(ctx);
		}
	});

	it("binds to 0.0.0.0 and returns the actual port", async () => {
		const ctx = makeContext();
		try {
			const actualPort = await startHttpServer(ctx, {
				port: 0,
				host: "0.0.0.0",
			});
			const addr = boundAddress(ctx);

			expect(addr.address).toBe("0.0.0.0");
			expect(addr.port).toBeGreaterThan(0);
			expect(actualPort).toBe(addr.port);
		} finally {
			await closeHttpServer(ctx);
		}
	});

	it("uses the protocol-detection wrapper in TLS mode and redirects HTTP to the actual port", async () => {
		const ctx = makeContext();
		try {
			const actualPort = await startHttpServer(ctx, {
				port: 0,
				host: "127.0.0.1",
				tls: {
					key: fixtureCerts.key,
					cert: fixtureCerts.cert,
				},
			});

			expect(ctx.upgradeServer).not.toBeNull();
			expect(actualPort).toBe(boundAddress(ctx).port);

			const httpsResponse = await httpsGet(actualPort, "/secure");
			expect(httpsResponse.status).toBe(200);
			expect(httpsResponse.body).toBe("ok");

			const httpResponse = await httpGet(actualPort, "/plain");
			expect(httpResponse.status).toBe(301);
			expect(httpResponse.headers["location"]).toContain(
				`:${actualPort}/plain`,
			);
			expect(httpResponse.headers["location"]).not.toContain(":0/plain");
		} finally {
			await closeHttpServer(ctx);
		}
	});

	it("clears both TLS protocol-detection server handles on close", async () => {
		const ctx = makeContext();

		await startHttpServer(ctx, {
			port: 0,
			host: "127.0.0.1",
			tls: {
				key: fixtureCerts.key,
				cert: fixtureCerts.cert,
			},
		});

		expect(ctx.httpServer).not.toBeNull();
		expect(ctx.upgradeServer).not.toBeNull();

		await closeHttpServer(ctx);

		expect(ctx.httpServer).toBeNull();
		expect(ctx.upgradeServer).toBeNull();
	});
});
