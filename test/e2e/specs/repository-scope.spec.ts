// Failure cases, written before implementation:
// - Repository selection omits a clone or admits an unrelated project.
// - Project selection and browser back disagree with the chip or RPC scope.
// - A lone project offers a redundant repository level.
// - Group-looking project slugs or project: tokens become group scopes.
// - A cold group link is sent to AttachProject as a project slug.
// - A grouping edit leaves a stale scope showing sessions or broadens the URL.
// - Removing the attached scoped project clears the group scope and widens the list.
// - Live updates admit outside projects or drop a member of the scoped group.
// - Search and the next browse/search page lose the group scope.
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
const groupKey = JSON.stringify(["repository", "github.com/acme/shared"]);
const groupScope = `/group/${groupKey}`;
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
			GetDefaultGroupingMode: () => ({
				mode: projects[0]?.effectiveGroupingMode ?? "repository",
			}),
			GetAutoSettleSetting: () => ({ autoSettleAfterDays: 3 }),
			ListDaemonSessions: ({ scope, search, cursor, exclude, limit }) => {
				const members = projects
					.filter(
						(project) =>
							project.slug !== lone && project.effectiveGroupingMode !== "off",
					)
					.map(({ slug }) => slug);
				const candidates = sessions.filter(
					(session) =>
						projects.some((project) => project.slug === session.projectSlug) &&
						(!scope ||
							(scope === groupScope
								? members.includes(session.projectSlug ?? "")
								: session.projectSlug === scope)) &&
						session.projectSlug !== exclude &&
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
		},
		handlers: {
			AttachProject: ({ projectSlug }) => ({
				projectSlug: projectSlug ?? projects[0]?.slug ?? null,
				sessionSlug: null,
			}),
			GetProjects: () => ({ projects, current: projects[0]?.slug ?? null }),
		},
		streams: {
			SubscribeShell: ({ projectSlug }) => [
				{
					_tag: "snapshot",
					sequence: 1,
					rows: sessions.filter(
						(session) => session.projectSlug === projectSlug,
					),
				},
				{ _tag: "synchronized" },
			],
		},
	});
	await mockRelayWebSocket(page, {
		initMessages: [{ type: "project_list", projects, current: primary }],
		responses: new Map(),
	});
	rpc.setShellRows(
		sessions.filter((session) => session.projectSlug === primary),
	);
	controls.set(page, rpc);
	await page.goto(
		`${baseUrl}/${options.scope ? `?${new URLSearchParams({ p: options.scope })}` : ""}`,
	);
	await expect(page.locator("#session-list")).toBeVisible();
	await expect(page.locator("#connect-overlay")).toBeHidden();
	await expect
		.poll(
			() =>
				rpc.getRequests().filter(({ tag }) => tag === "ListDaemonSessions")
					.length,
		)
		.toBeGreaterThan(0);
	return {
		rpc,
		sessions,
		turnGroupingOff: () => {
			projects = projects.map((project) => ({
				...project,
				effectiveGroupingMode: "off",
			}));
			rpc.setDaemonList("SubscribeProjects", { projects });
			rpc.setProjectSetting({ _tag: "defaultGroupingMode", mode: "off" });
		},
		removeScopedProjects: () => {
			projects = projects.filter(({ slug }) => slug === lone);
			rpc.setDaemonList("SubscribeProjects", { projects });
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
async function chooseRepository(page: Page) {
	await page.getByTestId("session-scope-chip").click();
	await page
		.getByRole("menuitemradio", { name: "Shared", exact: true })
		.click();
	await expect(page.getByTestId("session-scope-chip")).toHaveText("Shared");
	await expect
		.poll(() => new URL(page.url()).searchParams.get("p"))
		.toBe(groupScope);
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
		test("repository then project scopes carry their labels and browser back undoes each step", async ({
			page,
			harness,
		}) => {
			const { rpc, sessions } = await openList(page, harness.relayBaseUrl);
			await expect(rows(page)).toHaveCount(5);
			await chooseRepository(page);
			const members = sessions
				.filter((session) => session.projectSlug !== lone)
				.map(({ id }) => id)
				.sort();
			await expect.poll(() => ids(page)).toEqual(members);
			expect(listRequests(rpc).at(-1)?.payload).toMatchObject({
				_tag: "ListDaemonSessions",
				scope: groupScope,
			});
			await record(page, "repository");
			await page.getByTestId("session-scope-chip").click();
			await page
				.getByRole("menuitemradio")
				.filter({ hasText: `project:${secondary}` })
				.click();
			await expect(page.getByTestId("session-scope-chip")).toHaveText(
				"Shared · HTTPS clone",
			);
			await expect
				.poll(() => ids(page))
				.toEqual(
					sessions
						.filter((session) => session.projectSlug === secondary)
						.map(({ id }) => id)
						.sort(),
				);
			expect(listRequests(rpc).at(-1)?.payload).toMatchObject({
				_tag: "ListDaemonSessions",
				scope: secondary,
			});
			await record(page, "project");
			await page.goBack();
			await expect(page.getByTestId("session-scope-chip")).toHaveText("Shared");
			await expect.poll(() => ids(page)).toEqual(members);
			await record(page, "back-to-repository");
			await page.goBack();
			await expect(page.getByTestId("session-scope-chip")).toHaveText(
				"All projects",
			);
			await expect(rows(page)).toHaveCount(5);
			expect(
				rpc
					.getRequests()
					.filter(({ tag }) => tag === "AttachProject")
					.some(({ payload }) => payload["projectSlug"] === groupScope),
			).toBe(false);
		});

		test("a lone project is offered once and a group-looking project token stays project-only", async ({
			page,
			harness,
		}) => {
			const { rpc } = await openList(page, harness.relayBaseUrl);
			await page.getByTestId("session-scope-chip").click();
			await expect(
				page.getByRole("menuitemradio").filter({ hasText: "Library clone" }),
			).toHaveCount(1);
			await expect(
				page.getByRole("menuitemradio", { name: "Library", exact: true }),
			).toHaveCount(0);
			await expect(
				page.getByRole("menuitemradio", { name: "Shared", exact: true }),
			).toHaveCount(1);
			await page.keyboard.press("Escape");
			const input = page.getByRole("textbox", { name: "Search sessions" });
			await input.fill(`project:${lone} `);
			await expect(input).toHaveValue("");
			await expect(page.getByTestId("session-scope-chip")).toHaveText(
				"Library clone",
			);
			await expect.poll(() => ids(page)).toEqual([`scope-${lone}-0`]);
			expect(listRequests(rpc).at(-1)?.payload).toMatchObject({
				_tag: "ListDaemonSessions",
				scope: lone,
			});
		});

		test("cold group links attach a project and a live grouping edit leaves a stale scope empty", async ({
			page,
			harness,
		}) => {
			const { rpc, turnGroupingOff } = await openList(
				page,
				harness.relayBaseUrl,
				{ scope: groupScope },
			);
			await expect(page.getByTestId("session-scope-chip")).toHaveText("Shared");
			await expect(rows(page)).toHaveCount(4);
			expect(
				rpc.getRequests().find(({ tag }) => tag === "AttachProject")?.payload,
			).not.toHaveProperty("projectSlug", groupScope);
			await record(page, "cold-group-link");
			const before = listRequests(rpc).length;
			turnGroupingOff();
			await expect(rows(page)).toHaveCount(0);
			await expect.poll(() => listRequests(rpc).length).toBeGreaterThan(before);
			expect(listRequests(rpc).at(-1)?.payload).toMatchObject({
				_tag: "ListDaemonSessions",
				scope: groupScope,
			});
			expect(new URL(page.url()).searchParams.get("p")).toBe(groupScope);
			await expect(page.getByTestId("session-scope-chip")).toHaveText(
				groupScope,
			);
			await record(page, "grouping-off");
		});

		test("removing both checkouts leaves the stale repository scope empty", async ({
			page,
			harness,
		}) => {
			const { rpc, removeScopedProjects } = await openList(
				page,
				harness.relayBaseUrl,
				{ scope: groupScope },
			);
			await expect(rows(page)).toHaveCount(4);
			removeScopedProjects();
			await expect(page.getByTestId("session-scope-chip")).toHaveText(
				groupScope,
			);
			expect(new URL(page.url()).searchParams.get("p")).toBe(groupScope);
			await expect(rows(page)).toHaveCount(0);
			await expect
				.poll(
					() =>
						rpc
							.getRequests()
							.filter(({ tag }) => tag === "AttachProject")
							.at(-1)?.payload["projectSlug"],
				)
				.toBeUndefined();
			await record(page, "projects-removed");
			await page.getByRole("button", { name: "Clear project scope" }).click();
			await expect.poll(() => ids(page)).toEqual([`scope-${lone}-0`]);
		});

		test("live member updates enter a repository scope while outside updates stay hidden", async ({
			page,
			harness,
		}) => {
			const { rpc } = await openList(page, harness.relayBaseUrl);
			await chooseRepository(page);
			await expect(rows(page)).toHaveCount(4);
			const before = listRequests(rpc).length;
			rpc.upsertShellRow({
				accountId: null,
				id: "live-member",
				title: "Live HTTPS session",
				status: "idle" as const,
				projectSlug: secondary,
				updatedAt: 2_000_000_001_000,
				messageCount: 0,
			});
			rpc.upsertShellRow({
				accountId: null,
				id: "live-outside",
				title: "Live library session",
				status: "idle" as const,
				projectSlug: lone,
				updatedAt: 2_000_000_002_000,
				messageCount: 0,
			});
			await expect(
				page.locator('#session-list a[data-session-id="live-member"]'),
			).toBeVisible();
			await expect(
				page.locator('#session-list a[data-session-id="live-outside"]'),
			).toHaveCount(0);
			expect(listRequests(rpc)).toHaveLength(before);
			await record(page, "live-updates");
		});

		test("browse and search next pages keep the repository scope", async ({
			page,
			harness,
		}) => {
			const { rpc, sessions } = await openList(page, harness.relayBaseUrl, {
				paged: true,
			});
			await chooseRepository(page);
			await page.locator("#session-list-scroller").evaluate((element) => {
				element.scrollTop = element.scrollHeight;
			});
			await expect
				.poll(() =>
					listRequests(rpc).some(
						({ payload }) =>
							payload["scope"] === groupScope &&
							payload["cursor"] !== undefined &&
							payload["search"] === undefined,
					),
				)
				.toBe(true);
			const expected = sessions
				.filter((session) => session.projectSlug !== lone)
				.map(({ id }) => id)
				.sort();
			await expect.poll(() => ids(page)).toEqual(expected);
			await record(page, "browse-next-page");
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
							payload["scope"] === groupScope &&
							payload["search"] === "needle" &&
							payload["cursor"] !== undefined,
					),
				)
				.toBe(true);
			await expect.poll(() => ids(page)).toEqual(expected);
			for (const { payload } of listRequests(rpc).filter(
				({ payload }) => payload["search"] === "needle",
			))
				expect(payload).toMatchObject({
					_tag: "ListDaemonSessions",
					scope: groupScope,
				});
			await record(page, "search-next-page");
		});
	});
}
