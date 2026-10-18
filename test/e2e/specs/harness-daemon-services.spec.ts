import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import {
	type CreateSessionResponse,
	type GetAgentsResponse,
	type GetProjectsResponse,
	type InstanceListResponse,
	type ListDaemonSessionsResponse,
	SaveProject,
	type SaveProjectResponse,
	type ScanNowResponse,
	UpdateInstance,
} from "../../../src/lib/contracts/ws-rpc.js";
import {
	expect,
	test as harnessTest,
} from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

const artifactPath = "test-results/82tn21-daemon-services.json";
const stepNames = [
	"attach-project-a",
	"list-projects",
	"save-project-b",
	"create-session-b",
	"cross-project-session-list",
	"unknown-session-scope",
	"save-invalid-folder",
	"list-instances",
	"add-claude-instance",
	"update-claude-instance",
	"update-missing-instance",
	"remove-claude-instance",
	"scan-now",
	"set-default-agent",
	"new-session-default-agent",
	"remove-project-b",
] as const;
type StepName = (typeof stepNames)[number];
type Json =
	| null
	| string
	| number
	| boolean
	| readonly Json[]
	| { readonly [key: string]: Json };
type Report = {
	steps: Record<StepName, { pass: boolean; result: Json }>;
};
type Reply =
	| { _tag: "Success"; value: unknown }
	| { _tag: "Failure"; cause: { _tag: "Fail"; error: unknown } };
type BrowserRpc = {
	request: (tag: string, payload: Record<string, unknown>) => Promise<Reply>;
	close: () => void;
};

// This auto fixture starts before the process harness. Failed daemon/browser
// setup must leave the same artifact, with unfinished steps marked false.
const test = harnessTest.extend<{ daemonServicesReport: Report }>({
	daemonServicesReport: [
		async ({ isMobile }, use, testInfo) => {
			const report: Report = {
				steps: Object.fromEntries(
					stepNames.map((name) => [name, { pass: false, result: null }]),
				) as Report["steps"],
			};
			// Only the desktop lane runs this contract; skipped mobile workers must
			// not overwrite its canonical artifact when the whole harness runs.
			if (isMobile) {
				await use(report);
				return;
			}
			const write = () => {
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					artifactPath,
					`${JSON.stringify(
						{
							observedFrom: "A",
							...report,
							constraints: {
								scanFailure:
									"ScanNow has no failure input; daemon scanning is infallible and treats probe failures as inactive ports.",
								sessionQueryFailure:
									"ListDaemonSessions is infallible; an unknown scope returns an empty result and store read failures are reported as availability, not RPC failures.",
							},
							pass:
								testInfo.status === "passed" &&
								stepNames.every((name) => report.steps[name].pass),
						},
						null,
						2,
					)}\n`,
				);
			};
			write();
			try {
				await use(report);
			} finally {
				write();
				await testInfo.attach("82tn21-daemon-services.json", {
					path: artifactPath,
					contentType: "application/json",
				});
			}
		},
		{ auto: true },
	],
});

test.skip(
	({ isMobile }) => isMobile,
	"The daemon RPC contract is device independent",
);
test.use({
	harnessOptions: {
		capabilityAgents: [
			{ id: "default", name: "Default" },
			{ id: "reviewer", name: "Reviewer" },
		],
	},
});

// Failure cases: a project tab gets standalone adapters, mutations lose daemon
// persistence, session reads narrow to the attached project, typed errors lose
// their browser message, or SetAgent changes a different OverridesState.
test("project relays retain daemon services and their own default agent", async ({
	page,
	harness,
	daemonServicesReport: report,
}) => {
	const folderB = join(realpathSync(harness.root), "project-b");
	const missingFolder = join(realpathSync(harness.root), "missing-folder");
	mkdirSync(folderB);
	await new AppPage(page).goto(`${harness.baseUrl}/?p=process-test`);
	await page.evaluate(async () => {
		const socket = new WebSocket(
			`${location.origin.replace(/^http/, "ws")}/rpc`,
		);
		await new Promise<void>((resolve, reject) => {
			socket.onopen = () => resolve();
			socket.onerror = () => reject(new Error("RPC connection failed"));
		});
		let nextId = 0;
		const browser = window as unknown as { daemonServicesRpc: BrowserRpc };
		browser.daemonServicesRpc = {
			close: () => socket.close(),
			request: (tag, payload) =>
				new Promise<Reply>((resolve, reject) => {
					const id = String(++nextId);
					const receive = (event: MessageEvent<string>) => {
						const frame = JSON.parse(event.data) as {
							_tag: string;
							requestId?: string;
							exit?: Reply;
						};
						if (frame._tag !== "Exit" || frame.requestId !== id) return;
						clearTimeout(timer);
						socket.removeEventListener("message", receive);
						if (frame.exit) resolve(frame.exit);
						else reject(new Error(`${tag} returned no exit`));
					};
					const timer = setTimeout(() => {
						socket.removeEventListener("message", receive);
						reject(new Error(`${tag} timed out`));
					}, 20_000);
					socket.addEventListener("message", receive);
					socket.send(
						JSON.stringify({
							_tag: "Request",
							id,
							tag,
							payload: { _tag: tag, ...payload },
							headers: [],
						}),
					);
				}),
		};
	});
	const reply = (tag: string, payload: Record<string, unknown> = {}) =>
		page.evaluate(
			({ tag, payload }) =>
				(
					window as unknown as { daemonServicesRpc: BrowserRpc }
				).daemonServicesRpc.request(tag, payload),
			{ tag, payload },
		);
	const rpc = async <A>(
		tag: string,
		payload: Record<string, unknown> = {},
	): Promise<A> => {
		const result = await reply(tag, payload);
		expect(result._tag, `${tag} should succeed`).toBe("Success");
		if (result._tag !== "Success") throw new Error(`${tag} failed`);
		return result.value as A;
	};
	const check = async (
		name: StepName,
		result: Json,
		assert: () => void | Promise<void>,
	) => {
		report.steps[name].result = result;
		await assert();
		report.steps[name].pass = true;
	};
	const newSession = (projectSlug: string, title: string) =>
		rpc<CreateSessionResponse>("CreateSession", {
			projectSlug,
			originId: "daemon-services",
			providerId: "claude",
			permissionMode: "full",
			title,
			model: {
				providerId: "claude",
				modelId: "sonnet",
				variant: "",
				contextWindow: "200k",
			},
		});
	try {
		const attached = await rpc<{ projectSlug: string }>("AttachProject", {
			projectSlug: "process-test",
			originId: "daemon-services",
		});
		await check(
			"attach-project-a",
			{ project: attached.projectSlug === "process-test" ? "A" : "unexpected" },
			() => expect(attached.projectSlug).toBe("process-test"),
		);
		const projects = await rpc<GetProjectsResponse>("GetProjects");
		await check(
			"list-projects",
			{
				containsA: projects.projects.some(
					(project) => project.slug === "process-test",
				),
			},
			() =>
				expect(
					projects.projects.some((project) => project.slug === "process-test"),
				).toBe(true),
		);
		const saved = await rpc<SaveProjectResponse>("SaveProject", {
			title: "Project B",
			folders: [folderB],
		});
		const slugB = saved.savedSlug;
		await check(
			"save-project-b",
			{
				title:
					saved.projects.find((project) => project.slug === slugB)?.title ??
					null,
				warnings: saved.warnings.map((issue) => issue.kind),
			},
			() => {
				expect(
					saved.projects.find((project) => project.slug === slugB),
				).toMatchObject({ folders: [folderB], title: "Project B" });
				expect(saved.warnings).toEqual([]);
			},
		);
		const sessionB = await newSession(slugB, "B session");
		await check(
			"create-session-b",
			{
				project: sessionB.projectSlug === slugB ? "B" : "unexpected",
				created: Boolean(sessionB.sessionId),
			},
			() => {
				expect(sessionB.projectSlug).toBe(slugB);
				expect(sessionB.sessionId).toBeTruthy();
			},
		);
		const sessions = await rpc<ListDaemonSessionsResponse>(
			"ListDaemonSessions",
			{ projectSlug: "process-test" },
		);
		await check(
			"cross-project-session-list",
			{
				seesB: sessions.sessions.some(
					(session) => session.id === sessionB.sessionId,
				),
				availableB:
					sessions.availability.find((project) => project.projectSlug === slugB)
						?.available ?? false,
			},
			() => {
				expect(
					sessions.sessions.some(
						(session) => session.id === sessionB.sessionId,
					),
				).toBe(true);
				expect(
					sessions.availability.find((project) => project.projectSlug === slugB)
						?.available,
				).toBe(true);
			},
		);
		const empty = await rpc<ListDaemonSessionsResponse>("ListDaemonSessions", {
			projectSlug: "process-test",
			scope: "missing-82tn21",
		});
		await check(
			"unknown-session-scope",
			{
				sessions: empty.sessions.length,
				availability: empty.availability.length,
				hasMore: empty.hasMore,
			},
			() => {
				expect(empty.sessions).toEqual([]);
				expect(empty.availability).toEqual([]);
				expect(empty.hasMore).toBe(false);
			},
		);
		const invalidSave = await reply("SaveProject", {
			folders: [missingFolder],
		});
		expect(invalidSave._tag).toBe("Failure");
		if (invalidSave._tag !== "Failure")
			throw new Error("Invalid save succeeded");
		const projectError = Schema.decodeUnknownSync(SaveProject.errorSchema)(
			invalidSave.cause.error,
		);
		await check(
			"save-invalid-folder",
			{
				tag: projectError._tag,
				message: projectError.message.replaceAll(
					missingFolder,
					"<missing-folder>",
				),
			},
			() => {
				expect(projectError._tag).toBe("ProjectSaveRejected");
				expect(projectError.message).toBe(`missing: ${missingFolder}`);
			},
		);
		const before = await rpc<InstanceListResponse>("GetInstances");
		await check(
			"list-instances",
			{
				hasClaude: before.instances.some(
					(instance) => instance.driver === "claude",
				),
			},
			() =>
				expect(
					before.instances.some((instance) => instance.driver === "claude"),
				).toBe(true),
		);
		const added = await rpc<InstanceListResponse>("AddInstance", {
			name: "82tn21 Claude",
			driver: "claude",
		});
		const instanceId = added.addedInstanceId;
		await check(
			"add-claude-instance",
			{
				name:
					added.instances.find((instance) => instance.id === instanceId)
						?.name ?? null,
				driver:
					added.instances.find((instance) => instance.id === instanceId)
						?.driver ?? null,
				processStarted:
					added.instances.find((instance) => instance.id === instanceId)
						?.pid !== undefined,
			},
			() => {
				expect(instanceId).toBeTruthy();
				expect(
					added.instances.find((instance) => instance.id === instanceId),
				).toMatchObject({ name: "82tn21 Claude", driver: "claude" });
				expect(
					added.instances.find((instance) => instance.id === instanceId)?.pid,
				).toBeUndefined();
			},
		);
		const updated = await rpc<InstanceListResponse>("UpdateInstance", {
			instanceId,
			name: "82tn21 Claude renamed",
		});
		await check(
			"update-claude-instance",
			{
				name:
					updated.instances.find((instance) => instance.id === instanceId)
						?.name ?? null,
			},
			() =>
				expect(
					updated.instances.find((instance) => instance.id === instanceId)
						?.name,
				).toBe("82tn21 Claude renamed"),
		);
		const missingUpdate = await reply("UpdateInstance", {
			instanceId: "missing-82tn21",
			name: "Missing",
		});
		expect(missingUpdate._tag).toBe("Failure");
		if (missingUpdate._tag !== "Failure")
			throw new Error("Missing instance update succeeded");
		const instanceError = Schema.decodeUnknownSync(UpdateInstance.errorSchema)(
			missingUpdate.cause.error,
		);
		await check(
			"update-missing-instance",
			{ tag: instanceError._tag, message: instanceError.message },
			() => {
				expect(instanceError._tag).toBe("AccountChangeRejected");
				expect(instanceError.message).toBe(
					'Instance "missing-82tn21" not found',
				);
			},
		);
		const removedInstance = await rpc<InstanceListResponse>("RemoveInstance", {
			instanceId,
		});
		await check(
			"remove-claude-instance",
			{
				removed: !removedInstance.instances.some(
					(instance) => instance.id === instanceId,
				),
			},
			() =>
				expect(
					removedInstance.instances.some(
						(instance) => instance.id === instanceId,
					),
				).toBe(false),
		);
		const scan = await rpc<ScanNowResponse>("ScanNow", {
			projectSlug: "process-test",
		});
		await check(
			"scan-now",
			{
				arrays: [scan.discovered, scan.lost, scan.active].every(Array.isArray),
				validPorts: [scan.discovered, scan.lost, scan.active]
					.flat()
					.every((port) => Number.isInteger(port) && port > 0 && port <= 65535),
			},
			() => {
				for (const ports of [scan.discovered, scan.lost, scan.active]) {
					expect(Array.isArray(ports)).toBe(true);
					for (const port of ports) {
						expect(Number.isInteger(port)).toBe(true);
						expect(port).toBeGreaterThan(0);
						expect(port).toBeLessThanOrEqual(65535);
					}
				}
			},
		);
		const agentSet = await rpc<{ ok: boolean }>("SetAgent", {
			slug: "process-test",
			agent: "reviewer",
		});
		await check(
			"set-default-agent",
			{ ok: agentSet.ok, agent: "reviewer" },
			() => expect(agentSet.ok).toBe(true),
		);
		const sessionA = await newSession(
			"process-test",
			"A inherits default agent",
		);
		const agents = await rpc<GetAgentsResponse>("GetAgents", {
			sessionId: sessionA.sessionId,
		});
		await check(
			"new-session-default-agent",
			{
				project: agents.projectSlug === "process-test" ? "A" : "unexpected",
				activeAgent: agents.activeAgentId ?? null,
			},
			() => {
				expect(agents.projectSlug).toBe("process-test");
				expect(agents.activeAgentId).toBe("reviewer");
			},
		);
		const removedProject = await rpc<GetProjectsResponse>("RemoveProject", {
			slug: slugB,
		});
		await check(
			"remove-project-b",
			{
				containsA: removedProject.projects.some(
					(project) => project.slug === "process-test",
				),
				removedB: !removedProject.projects.some(
					(project) => project.slug === slugB,
				),
			},
			() => {
				expect(
					removedProject.projects.some((project) => project.slug === slugB),
				).toBe(false);
				expect(
					removedProject.projects.some(
						(project) => project.slug === "process-test",
					),
				).toBe(true);
			},
		);
	} finally {
		await page.evaluate(() =>
			(
				window as unknown as { daemonServicesRpc: BrowserRpc }
			).daemonServicesRpc.close(),
		);
	}
});
