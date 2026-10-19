// Project scope must survive browser back, live updates, search and paging.
// Projects with the same repository identity remain independent choices.
import { writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import type {
	ProjectInfo,
	SessionInfo,
} from "../../../src/lib/shared-types.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc, type RpcMockControl } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

test.use({ recording: "chat-simple" });
const primary = "e2e-replay";
const secondary = "https-clone";
const lone = "group-repository-github-com-acme-shared";
const controls = new WeakMap<Page, RpcMockControl>();
const observations = new WeakMap<
	Page,
	{ phase: string; scope: string | null; label: string; sessionIds: string[] }[]
>();

async function openList(
	page: Page,
	baseUrl: string,
	options: { scope?: string; paged?: boolean } = {},
) {
	let projects: ProjectInfo[] = [
		{
			slug: primary,
			title: "SSH clone",
			folders: ["/workspace/ssh"],
			repositoryIdentities: {
				"/workspace/ssh": {
					key: "github.com/acme/shared",
					name: "Shared",
					root: "/workspace/ssh",
				},
			},
		},
		{
			slug: secondary,
			title: "HTTPS clone",
			folders: ["/workspace/https"],
			repositoryIdentities: {
				"/workspace/https": {
					key: "github.com/acme/shared",
					name: "Shared",
					root: "/workspace/https",
				},
			},
		},
		{
			slug: lone,
			title: "Library clone",
			folders: ["/workspace/library"],
			repositoryIdentities: {
				"/workspace/library": {
					key: "github.com/acme/library",
					name: "Library",
					root: "/workspace/library",
				},
			},
		},
	];
	const sessions: SessionInfo[] = projects.flatMap((project, index) =>
		Array.from(
			{
				length:
					options.paged && project.slug === secondary
						? 36
						: project.slug === lone
							? 1
							: 2,
			},
			(_, row) => ({
				accountId: null,
				id: `scope-${project.slug}-${row}`,
				title: `needle ${project.title} ${row}`,
				status: "idle" as const,
				projectSlug: project.slug,
				updatedAt: 2_000_000_000_000 - (index * 100 + row) * 1000,
				messageCount: 0,
			}),
		),
	);
	const rpc = await mockWsRpc(page, {
		stubs: {
			GetAutoSettleSetting: () => ({ autoSettleAfterDays: 3 }),
			ListDaemonSessions: ({ scope, search, cursor, limit }) => {
				const candidates = sessions.filter(
					(session) =>
						projects.some((project) => project.slug === session.projectSlug) &&
						(!scope || session.projectSlug === scope) &&
						(!search ||
							session.title
								.toLowerCase()
								.includes(String(search).toLowerCase())),
				);
				const cursorId =
					cursor && typeof cursor === "object" && "id" in cursor
						? cursor.id
						: null;
				const start =
					cursorId === null
						? 0
						: candidates.findIndex(({ id }) => id === cursorId) + 1;
				const size = Number(limit ?? candidates.length);
				const rows = candidates.slice(start, start + size);
				const last = rows.at(-1);
				const hasMore = start + size < candidates.length;
				return {
					sessions: rows,
					availability: [],
					hasMore,
					nextCursor:
						hasMore && last
							? { updatedAt: Number(last.updatedAt), id: last.id }
							: null,
				};
			},
			AttachProject: (payload) => ({
				projectSlug:
					("projectSlug" in payload ? payload.projectSlug : undefined) ??
					projects[0]?.slug ??
					null,
				sessionSlug: null,
			}),
			GetProjects: () => ({ projects, current: projects[0]?.slug }),
		},
		streams: {
			SubscribeShell: () => [
				{
					_tag: "snapshot",
					sequence: 1,
					rows: sessions,
				},
				{ _tag: "synchronized" },
			],
		},
	});
	await mockRelayWebSocket(page, {
		initMessages: [{ type: "project_list", projects, current: primary }],
		responses: new Map(),
	});
	rpc.setShellRows(sessions);
	controls.set(page, rpc);
	await page.goto(
		`${baseUrl}/${options.scope ? `?${new URLSearchParams({ p: options.scope })}` : ""}`,
	);
	await expect(page.locator("#session-list")).toBeVisible();
	await expect(page.locator("#connect-overlay")).toBeHidden();
	expect(listRequests(rpc)).toHaveLength(0);
	return {
		rpc,
		sessions,
		removeScopedProject: () => {
			projects = projects.filter(({ slug }) => slug !== secondary);
			rpc.setProjects({ projects });
		},
	};
}

function rows(page: Page) {
	return page.locator("#session-list a[data-session-id]");
}
async function ids(page: Page) {
	return rows(page).evaluateAll((elements) =>
		elements
			.map((element) => element.getAttribute("data-session-id") ?? "")
			.sort(),
	);
}
async function record(page: Page, phase: string) {
	const entries = observations.get(page) ?? [];
	entries.push({
		phase,
		scope: new URL(page.url()).searchParams.get("p"),
		label: await page.getByTestId("session-scope-chip").innerText(),
		sessionIds: await ids(page),
	});
	observations.set(page, entries);
}
function listRequests(rpc: RpcMockControl) {
	return rpc.getRequests().filter(({ tag }) => tag === "ListDaemonSessions");
}
async function chooseProject(page: Page, slug = secondary) {
	await page.getByTestId("session-scope-chip").click();
	await page
		.getByRole("menuitemradio")
		.filter({ hasText: `project:${slug}` })
		.click();
	await expect.poll(() => new URL(page.url()).searchParams.get("p")).toBe(slug);
}

test.afterEach(async ({ page }, info) => {
	if (!controls.has(page)) return;
	await record(page, "final");
	const requests = controls
		.get(page)
		?.getRequests()
		.filter(({ tag }) => ["ListDaemonSessions", "AttachProject"].includes(tag))
		.map(({ tag, payload }) => ({
			tag,
			payload: Object.fromEntries(
				Object.entries(payload)
					.filter(([key]) => key !== "originId")
					.sort(([a], [b]) => a.localeCompare(b)),
			),
		}));
	const artifact = info.outputPath("repository-scope.json");
	writeFileSync(
		artifact,
		`${JSON.stringify({ viewport: page.viewportSize(), requests, observations: observations.get(page) ?? [] }, null, 2)}\n`,
	);
	await info.attach("repository-scope-state", {
		path: artifact,
		contentType: "application/json",
	});
	const screenshot = info.outputPath("repository-scope.png");
	await page.screenshot({ path: screenshot, animations: "disabled" });
	await info.attach("repository-scope", {
		path: screenshot,
		contentType: "image/png",
	});
});

for (const viewport of [
	{ name: "desktop", viewport: { width: 1440, height: 900 }, hasTouch: false },
	{ name: "phone", viewport: { width: 390, height: 844 }, hasTouch: true },
]) {
	test.describe(viewport.name, () => {
		test.use({ viewport: viewport.viewport, hasTouch: viewport.hasTouch });

		test("project scopes carry project titles and browser back undoes each step", async ({
			page,
			harness,
		}) => {
			const { rpc, sessions } = await openList(page, harness.relayBaseUrl);
			await expect(rows(page)).toHaveCount(5);
			await chooseProject(page, primary);
			await expect(page.getByTestId("session-scope-chip")).toHaveText(
				"SSH clone",
			);
			const first = sessions
				.filter((session) => session.projectSlug === primary)
				.map(({ id }) => id)
				.sort();
			await expect.poll(() => ids(page)).toEqual(first);
			await chooseProject(page);
			await expect(page.getByTestId("session-scope-chip")).toHaveText(
				"HTTPS clone",
			);
			await expect
				.poll(() => ids(page))
				.toEqual(
					sessions
						.filter((session) => session.projectSlug === secondary)
						.map(({ id }) => id)
						.sort(),
				);
			expect(listRequests(rpc)).toHaveLength(0);
			await page.goBack();
			await expect(page.getByTestId("session-scope-chip")).toHaveText(
				"SSH clone",
			);
			await expect.poll(() => ids(page)).toEqual(first);
			await page.goBack();
			await expect(page.getByTestId("session-scope-chip")).toHaveText(
				"All projects",
			);
			await expect(rows(page)).toHaveCount(5);
		});

		test("the menu offers each project once and project tokens select only that project", async ({
			page,
			harness,
		}) => {
			const { rpc } = await openList(page, harness.relayBaseUrl);
			await page.getByTestId("session-scope-chip").click();
			await expect(page.getByRole("menuitemradio")).toHaveCount(4);
			await expect(
				page.getByRole("menuitemradio", { name: "Shared", exact: true }),
			).toHaveCount(0);
			await page.keyboard.press("Escape");
			const input = page.getByRole("textbox", { name: "Search sessions" });
			await input.fill(`project:${lone} `);
			await expect(input).toHaveValue("");
			await expect(page.getByTestId("session-scope-chip")).toHaveText(
				"Library clone",
			);
			await expect.poll(() => ids(page)).toEqual([`scope-${lone}-0`]);
			expect(listRequests(rpc)).toHaveLength(0);
		});

		test("removing the attached scoped project returns to all projects", async ({
			page,
			harness,
		}) => {
			const { removeScopedProject, sessions } = await openList(
				page,
				harness.relayBaseUrl,
				{ scope: secondary },
			);
			await expect(rows(page)).toHaveCount(2);
			removeScopedProject();
			await expect(page.getByTestId("session-scope-chip")).toHaveText(
				"All projects",
			);
			expect(new URL(page.url()).searchParams.has("p")).toBe(false);
			await expect
				.poll(() => ids(page))
				.toEqual(
					sessions
						.filter((session) => session.projectSlug !== secondary)
						.map(({ id }) => id)
						.sort(),
				);
		});

		test("live updates enter only their own project scope", async ({
			page,
			harness,
		}) => {
			const { rpc } = await openList(page, harness.relayBaseUrl);
			await chooseProject(page);
			await expect(rows(page)).toHaveCount(2);
			const before = listRequests(rpc).length;
			for (const projectSlug of [primary, secondary]) {
				rpc.upsertShellRow({
					accountId: null,
					id: `live-${projectSlug}`,
					title: `Live ${projectSlug} session`,
					status: "idle" as const,
					projectSlug,
					updatedAt: 2_000_000_001_000,
					messageCount: 0,
				});
			}
			await expect(
				page.locator(`#session-list a[data-session-id="live-${secondary}"]`),
			).toBeVisible();
			await expect(
				page.locator(`#session-list a[data-session-id="live-${primary}"]`),
			).toHaveCount(0);
			expect(listRequests(rpc)).toHaveLength(before);
		});

		test("search next pages keep the project scope", async ({
			page,
			harness,
		}) => {
			const { rpc, sessions } = await openList(page, harness.relayBaseUrl, {
				paged: true,
			});
			await chooseProject(page);
			const expected = sessions
				.filter((session) => session.projectSlug === secondary)
				.map(({ id }) => id)
				.sort();
			expect(listRequests(rpc)).toHaveLength(0);
			await page
				.getByRole("textbox", { name: "Search sessions" })
				.fill("needle");
			await expect
				.poll(() =>
					listRequests(rpc).some(
						({ payload }) => payload["search"] === "needle",
					),
				)
				.toBe(true);
			await page.locator("#session-list-scroller").evaluate((element) => {
				element.scrollTop = element.scrollHeight;
			});
			await expect
				.poll(() =>
					listRequests(rpc).some(
						({ payload }) =>
							payload["scope"] === secondary &&
							payload["search"] === "needle" &&
							payload["cursor"] !== undefined,
					),
				)
				.toBe(true);
			await expect.poll(() => ids(page)).toEqual(expected);
			for (const { payload } of listRequests(rpc).filter(
				({ payload }) => payload["search"] === "needle",
			)) {
				expect(payload).toMatchObject({
					_tag: "ListDaemonSessions",
					scope: secondary,
				});
			}
		});
	});
}
