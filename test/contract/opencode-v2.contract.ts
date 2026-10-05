import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { OpenCodeAPI } from "../../src/lib/instance/opencode-api.js";
import { createSdkClient } from "../../src/lib/instance/sdk-factory.js";

it("runs the v2 adapter against the isolated OpenCode server", async () => {
	const baseUrl = process.env["OPENCODE_URL"];
	if (!baseUrl || ["2633", "4096"].includes(new URL(baseUrl).port)) {
		throw new Error(
			"The v2 contract requires the global setup's ephemeral OpenCode URL",
		);
	}
	const directory = realpathSync(
		mkdtempSync(join(tmpdir(), "conduit-v2-contract-")),
	);
	const { client, authHeaders } = createSdkClient({ baseUrl, directory });
	const api = new OpenCodeAPI({ sdk: client, baseUrl, authHeaders });
	const controller = new AbortController();
	let sessionID: string | undefined;
	try {
		expect((await api.app.path()).cwd).toBe(directory);
		const { stream } = await api.event.subscribe({
			signal: controller.signal,
			sseMaxRetryAttempts: 1,
		});
		try {
			const first = await stream.next();
			expect(first.value).toMatchObject({ type: "server.connected" });
		} finally {
			controller.abort();
			await stream.return();
		}
		const session = await api.session.create({ title: "g1cm-v2-contract" });
		sessionID = session.id;
		expect(session.directory).toBe(directory);
		expect((await api.session.get(session.id)).id).toBe(session.id);
		await api.session.update(session.id, { title: "g1cm-v2-updated" });
		expect((await api.session.get(session.id)).title).toBe("g1cm-v2-updated");
		expect(
			(await api.session.list({ roots: true, limit: 1 })).map(
				(item) => item.id,
			),
		).toContain(session.id);
		expect(await api.session.messages(session.id, { limit: 1 })).toEqual([]);
		expect(await api.session.messagesPage(session.id, { limit: 1 })).toEqual(
			[],
		);
		expect(await api.permission.list()).toEqual([]);
		expect(await api.question.list()).toEqual([]);
		expect(Array.isArray(await api.app.skills(directory))).toBe(true);
		await expect(
			api.question.reply("missing-v2-question", [["yes"]]),
		).rejects.toMatchObject({
			_tag: "OpenCodeApiError",
			responseStatus: 400,
		});
		await expect(
			api.question.reject("missing-v2-question"),
		).rejects.toMatchObject({
			_tag: "OpenCodeApiError",
			responseStatus: 400,
		});
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/g1cm-v2-contract.json",
			JSON.stringify(
				{
					baseUrl,
					directory,
					sessionID,
					sdkVersion: "1.18.32",
					verified: [
						"session CRUD",
						"directory",
						"message paging",
						"permission/question lists",
						"skills",
						"question HTTP errors",
						"SSE and abort",
					],
				},
				null,
				2,
			),
		);
	} finally {
		controller.abort();
		try {
			if (sessionID) await api.session.delete(sessionID);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
});
