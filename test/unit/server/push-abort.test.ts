import { createECDH } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { ClientRequest, IncomingMessage } from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { PushNotificationManager } from "../../../src/lib/server/push.js";

it.each([
	"sendTo",
	"sendToAll",
] as const)("%s destroys a still-live request before releasing its deadline", async (method) => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-push-abort-"));
	// Only the HTTPS boundary is faked. The real web-push encoder and manager run.
	const request = new EventEmitter() as ClientRequest;
	request.destroyed = false;
	request.write = vi.fn(() => true);
	request.end = vi.fn(() => request);
	request.destroy = vi.fn((error?: Error) => {
		request.destroyed = true;
		queueMicrotask(() => request.emit("error", error));
		return request;
	});
	const transport = vi.spyOn(https, "request").mockReturnValue(request);
	try {
		const manager = new PushNotificationManager({ configDir: dir });
		await manager.init();
		const ecdh = createECDH("prime256v1");
		manager.addSubscription("device", {
			endpoint: "https://push.example/a",
			keys: {
				p256dh: ecdh.generateKeys().toString("base64url"),
				auth: Buffer.alloc(16).toString("base64url"),
			},
		});
		vi.useFakeTimers();
		const result =
			method === "sendTo"
				? manager.sendTo("device", { title: "Question", body: "Answer?" })
				: manager.sendToAll({ title: "Question", body: "Answer?" });
		await vi.advanceTimersByTimeAsync(9_999);
		expect(transport).toHaveBeenCalledOnce();
		expect(request.destroyed).toBe(false);
		// There is no inactivity timeout event: the transport is still live.
		await vi.advanceTimersByTimeAsync(1);
		const report = await result;
		expect(request.destroyed).toBe(true);
		expect(request.destroy).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Push send timed out after 10000ms" }),
		);
		expect(report.delivered).toEqual([]);
		expect(report.failed).toEqual([
			{ clientId: "device", cause: expect.any(Error) },
		]);
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		vi.useRealTimers();
		transport.mockRestore();
		rmSync(dir, { recursive: true, force: true });
	}
});

it.each([
	201, 403, 404, 410, 503,
])("preserves push response %s through the cancellable transport", async (statusCode) => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-push-response-"));
	const request = new EventEmitter() as ClientRequest;
	request.write = vi.fn(() => true);
	request.end = vi.fn(() => request);
	const transport = vi.spyOn(https, "request").mockReturnValue(request);
	try {
		const manager = new PushNotificationManager({ configDir: dir });
		await manager.init();
		const ecdh = createECDH("prime256v1");
		manager.addSubscription("device", {
			endpoint: "https://push.example/a",
			keys: {
				p256dh: ecdh.generateKeys().toString("base64url"),
				auth: Buffer.alloc(16).toString("base64url"),
			},
		});
		vi.useFakeTimers();
		const result = manager.sendTo("device", {
			title: "Question",
			body: "Answer?",
		});
		expect(transport).toHaveBeenCalledWith(
			new URL("https://push.example/a"),
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					"Content-Encoding": "aes128gcm",
					Authorization: expect.stringContaining("vapid "),
					TTL: 2419200,
				}),
			}),
			expect.any(Function),
		);
		expect(request.write).toHaveBeenCalledWith(expect.any(Buffer));
		const response = new EventEmitter() as IncomingMessage;
		response.statusCode = statusCode;
		response.resume = vi.fn(() => response);
		transport.mock.calls[0]?.[2]?.(response);
		response.emit("end");
		const report = await result;
		if (statusCode === 201) expect(report.delivered).toEqual(["device"]);
		else if (statusCode === 503)
			expect(report.failed).toEqual([
				{ clientId: "device", cause: expect.objectContaining({ statusCode }) },
			]);
		else {
			expect(report.expired).toEqual(["device"]);
			expect(manager.getSubscriptionIds()).toEqual([]);
		}
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		vi.useRealTimers();
		transport.mockRestore();
		rmSync(dir, { recursive: true, force: true });
	}
});
