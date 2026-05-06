import { FileSystem } from "@effect/platform";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import {
	getCacheControl,
	MIME_TYPES,
	StaticDirTag,
	serveStaticFile,
} from "../../../src/lib/effect/static-file-handler.js";

const nodeLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer);

const withTempStaticDir = <A, E, R>(
	program: (dir: string) => Effect.Effect<A, E, R>,
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const dir = yield* fs.makeTempDirectoryScoped({
				prefix: "conduit-static-",
			});
			yield* fs.writeFileString(`${dir}/index.html`, "<html>app</html>");
			yield* fs.writeFileString(`${dir}/app.a1b2c3d4.js`, "console.log('x')");
			yield* fs.makeDirectory(`${dir}/nested`);
			yield* fs.writeFileString(
				`${dir}/nested/index.html`,
				"<html>nested</html>",
			);
			return yield* program(dir).pipe(Effect.provideService(StaticDirTag, dir));
		}),
	).pipe(Effect.provide(nodeLayer));

describe("Static file handler", () => {
	describe("getCacheControl", () => {
		it("returns immutable for content-hashed files", () => {
			expect(getCacheControl("app.a1b2c3d4.js")).toContain("immutable");
		});

		it("returns must-revalidate for unhashed files", () => {
			expect(getCacheControl("index.html")).toContain("must-revalidate");
		});
	});

	describe("MIME_TYPES", () => {
		it("maps .html to text/html", () => {
			expect(MIME_TYPES[".html"]).toContain("text/html");
		});

		it("maps .js to application/javascript", () => {
			expect(MIME_TYPES[".js"]).toContain("application/javascript");
		});
	});

	describe("serveStaticFile", () => {
		it.effect("serves files with content type and cache headers", () =>
			withTempStaticDir((dir) =>
				Effect.gen(function* () {
					const response = yield* serveStaticFile("/app.a1b2c3d4.js");
					expect(response.status).toBe(200);
					expect(response.headers["content-type"]).toContain(
						"application/javascript",
					);
					expect(response.headers["cache-control"]).toContain("immutable");
					expect(dir).toBeTruthy();
				}),
			),
		);

		it.effect("serves index.html for SPA fallback", () =>
			withTempStaticDir(() =>
				Effect.gen(function* () {
					const response = yield* serveStaticFile("/missing-route");
					expect(response.status).toBe(200);
					expect(response.headers["content-type"]).toContain("text/html");
				}),
			),
		);

		it.effect("prevents directory traversal", () =>
			withTempStaticDir(() =>
				Effect.gen(function* () {
					const response = yield* serveStaticFile("/../secret.txt");
					expect(response.status).toBe(403);
				}),
			),
		);

		it.effect("serves directory index without recursive self-call", () =>
			withTempStaticDir(() =>
				Effect.gen(function* () {
					const response = yield* serveStaticFile("/nested");
					expect(response.status).toBe(200);
					expect(response.headers["content-type"]).toContain("text/html");
				}),
			),
		);
	});
});
