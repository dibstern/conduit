import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpApp, HttpServerResponse } from "@effect/platform";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthManager } from "../../../src/lib/auth.js";
import { makeAuthManagerLive } from "../../../src/lib/effect/auth-middleware.js";
import { StaticDirTag } from "../../../src/lib/effect/static-file-handler.js";
import {
	effectRouterWithCors,
	ProjectApiDelegateProvider,
	ProjectsProvider,
	RemoveProjectProvider,
	type RouterProjectInfo,
} from "../../../src/lib/server/effect-http-router.js";

let staticDir = "";

const oneProject: RouterProjectInfo[] = [
	{
		slug: "test-project",
		directory: "/tmp/test-project",
		title: "Test Project",
		status: "ready",
	},
];

const multiProject: RouterProjectInfo[] = [
	...oneProject,
	{
		slug: "other",
		directory: "/tmp/other",
		title: "Other Project",
		status: "registering",
	},
];

beforeAll(async () => {
	staticDir = await mkdtemp(join(tmpdir(), "conduit-router-static-"));
	await writeFile(join(staticDir, "index.html"), "<html>app</html>");
	await writeFile(join(staticDir, "app.a1b2c3d4.js"), "console.log('app')");
});

afterAll(async () => {
	if (staticDir) await rm(staticDir, { recursive: true, force: true });
});

function makeHandler(options?: {
	projects?: RouterProjectInfo[];
	auth?: AuthManager;
	removeProject?: (slug: string) => void;
}) {
	const auth = options?.auth ?? new AuthManager();
	const layer = Layer.mergeAll(
		Layer.succeed(ProjectsProvider, {
			getProjects: () => options?.projects ?? oneProject,
		}),
		makeAuthManagerLive(auth),
		Layer.succeed(StaticDirTag, staticDir),
		Layer.succeed(RemoveProjectProvider, {
			removeProject: (slug: string) =>
				options?.removeProject == null
					? Effect.fail(new Error("missing"))
					: Effect.sync(() => options.removeProject?.(slug)),
		}),
		Layer.succeed(ProjectApiDelegateProvider, {
			delegateApiRequest: () =>
				Effect.succeed(HttpServerResponse.text("delegated", { status: 299 })),
		}),
		NodeFileSystem.layer,
		NodePath.layer,
	);
	return HttpApp.toWebHandlerLayer(effectRouterWithCors, layer);
}

describe("Effect HTTP Router production routes", () => {
	it("GET / redirects to the only project", async () => {
		const { handler, dispose } = makeHandler();
		try {
			const response = await handler(new Request("http://localhost/"));
			expect(response.status).toBe(302);
			expect(response.headers.get("location")).toBe("/p/test-project/");
		} finally {
			await dispose();
		}
	});

	it("GET / serves dashboard when multiple projects exist", async () => {
		const { handler, dispose } = makeHandler({ projects: multiProject });
		try {
			const response = await handler(new Request("http://localhost/"));
			expect(response.status).toBe(200);
			await expect(response.text()).resolves.toContain("<html>app</html>");
		} finally {
			await dispose();
		}
	});

	it("serves /auth and static assets without auth gate", async () => {
		const auth = new AuthManager();
		auth.setPin("1234");
		const { handler, dispose } = makeHandler({ auth });
		try {
			const authResponse = await handler(new Request("http://localhost/auth"));
			expect(authResponse.status).toBe(200);
			const assetResponse = await handler(
				new Request("http://localhost/app.a1b2c3d4.js"),
			);
			expect(assetResponse.status).toBe(200);
			expect(assetResponse.headers.get("cache-control")).toContain("immutable");
		} finally {
			await dispose();
		}
	});

	it("auth-gates project APIs and allows valid session cookie", async () => {
		const auth = new AuthManager();
		auth.setPin("1234");
		const cookie = auth.authenticate("1234", "127.0.0.1").cookie;
		const { handler, dispose } = makeHandler({ auth });
		try {
			const blocked = await handler(
				new Request("http://localhost/api/projects"),
			);
			expect(blocked.status).toBe(401);

			const allowed = await handler(
				new Request("http://localhost/api/projects", {
					headers: { cookie: `relay_session=${cookie}` },
				}),
			);
			expect(allowed.status).toBe(200);
		} finally {
			await dispose();
		}
	});

	it("DELETE /api/projects/:slug calls remove provider", async () => {
		const removed: string[] = [];
		const { handler, dispose } = makeHandler({
			removeProject: (slug) => {
				removed.push(slug);
			},
		});
		try {
			const response = await handler(
				new Request("http://localhost/api/projects/test-project", {
					method: "DELETE",
				}),
			);
			expect(response.status).toBe(200);
			expect(removed).toEqual(["test-project"]);
		} finally {
			await dispose();
		}
	});

	it("GET /p/:slug/api/status returns project status", async () => {
		const { handler, dispose } = makeHandler();
		try {
			const response = await handler(
				new Request("http://localhost/p/test-project/api/status"),
			);
			expect(response.status).toBe(200);
			await expect(response.json()).resolves.toEqual({ status: "ready" });
		} finally {
			await dispose();
		}
	});

	it("auth-gates project browser routes with redirect", async () => {
		const auth = new AuthManager();
		auth.setPin("1234");
		const { handler, dispose } = makeHandler({ auth });
		try {
			const response = await handler(
				new Request("http://localhost/p/test-project/dashboard"),
			);
			expect(response.status).toBe(302);
			expect(response.headers.get("location")).toBe("/auth");
		} finally {
			await dispose();
		}
	});
});
