import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	CreateSession,
	SaveProject,
} from "../../../src/lib/contracts/ws-rpc.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

const artifactPath = "test-results/82tn20-session-routing.json";
const initialSteps = {
	createdBothSessions: false,
	attachedToA: false,
	submittedToB: false,
	replyInB: false,
	persistedInBOnly: false,
	noMissingSessionRejection: false,
};

// Leave failed steps even if the process harness cannot finish setting up.
test.beforeEach(() => {
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		artifactPath,
		`${JSON.stringify({ handledBy: null, steps: initialSteps, passed: false }, null, 2)}\n`,
	);
});

// Failure modes: the attached project wins over the session owner, an unknown
// session silently falls back, or a successful RPC loses the persisted turn.
test("session RPCs use the owner even when the page attaches to another project", async ({
	page,
	harness,
}, testInfo) => {
	const steps = { ...initialSteps };
	let handledBy: "B" | null = null;
	try {
		const folder = join(harness.root, "project-b");
		mkdirSync(folder);
		const project = await harness.requestRpc(
			new SaveProject({
				folders: [folder],
				title: "Project B",
			}),
		);
		const a = await harness.requestRpc(
			new CreateSession({
				projectSlug: "process-test",
				originId: "routing-test",
				providerId: "claude",
				permissionMode: "full",
				model: {
					providerId: "claude",
					modelId: "sonnet",
					variant: "",
					contextWindow: "200k",
				},
			}),
		);
		const b = await harness.requestRpc(
			new CreateSession({
				projectSlug: project.savedSlug,
				originId: "routing-test",
				providerId: "claude",
				permissionMode: "full",
				model: {
					providerId: "claude",
					modelId: "sonnet",
					variant: "",
					contextWindow: "200k",
				},
			}),
		);
		steps.createdBothSessions = Boolean(a.sessionId && b.sessionId);
		const app = new AppPage(page);
		await app.goto(`${harness.baseUrl}/?p=process-test`);
		// This cross-project state is deliberately injected through the page's real
		// RPC transport: normal navigation reattaches to the viewed session.
		const result = await page.evaluate(async (sessionId) => {
			const socket = new WebSocket(
				`${location.origin.replace(/^http/, "ws")}/rpc`,
			);
			await new Promise<void>((resolve, reject) => {
				socket.onopen = () => resolve();
				socket.onerror = () => reject(new Error("RPC connection failed"));
			});
			const request = (
				id: string,
				tag: string,
				payload: Record<string, unknown>,
			) =>
				new Promise<Record<string, unknown>>((resolve, reject) => {
					const timer = setTimeout(
						() => reject(new Error(`${tag} timed out`)),
						20_000,
					);
					const receive = (event: MessageEvent<string>) => {
						const frame = JSON.parse(event.data) as {
							_tag: string;
							requestId?: string;
							exit?: { _tag: string; value: Record<string, unknown> };
						};
						if (frame._tag !== "Exit" || frame.requestId !== id) return;
						clearTimeout(timer);
						socket.removeEventListener("message", receive);
						if (frame.exit?._tag === "Success") resolve(frame.exit.value);
						else reject(new Error(`${tag} failed`));
					};
					socket.addEventListener("message", receive);
					socket.send(
						JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }),
					);
				});
			try {
				const attached = await request("1", "AttachProject", {
					projectSlug: "process-test",
					originId: "routing-page",
				});
				const submitted = await request("2", "input.submit", {
					sessionId,
					originId: "routing-page",
					inputId: "routing-input",
					delivery: "queue",
					text: "cross-project-routing",
				});
				return {
					attached: attached["projectSlug"],
					submitted: submitted["ok"],
				};
			} finally {
				socket.close();
			}
		}, b.sessionId);
		steps.attachedToA = result.attached === "process-test";
		steps.submittedToB = result.submitted === true;
		expect(steps.attachedToA).toBe(true);
		expect(steps.submittedToB).toBe(true);
		await app.goto(`${harness.baseUrl}/s/${b.sessionId}`);
		await expect(page.locator("#messages")).toContainText(
			"done(cross-project-routing)",
		);
		steps.replyInB = true;
		const countPrompt = (slug: string): number => {
			const db = new DatabaseSync(harness.projectStorePath(slug), {
				readOnly: true,
			});
			try {
				return Number(
					db
						.prepare(
							"SELECT count(*) AS count FROM messages WHERE role = 'user' AND session_id = ?",
						)
						.get(b.sessionId)?.["count"],
				);
			} finally {
				db.close();
			}
		};
		steps.persistedInBOnly =
			countPrompt(project.savedSlug) === 1 && countPrompt("process-test") === 0;
		expect(steps.persistedInBOnly).toBe(true);
		handledBy = "B";
		steps.noMissingSessionRejection = !harness.logTail.includes(
			"reason=missing-session",
		);
		expect(steps.noMissingSessionRejection).toBe(true);
	} finally {
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			artifactPath,
			`${JSON.stringify({ handledBy, steps, passed: Object.values(steps).every(Boolean) }, null, 2)}\n`,
		);
		await testInfo.attach("session-routing", {
			path: artifactPath,
			contentType: "application/json",
		});
	}
});
