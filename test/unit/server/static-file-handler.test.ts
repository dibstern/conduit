import { FileSystem, HttpServerRequest } from "@effect/platform";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import {
	getCacheControl,
	MIME_TYPES,
	StaticDirTag,
	serveStaticFile,
} from "../../../src/lib/domain/server/Services/static-file-handler.js";

const nodeLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer);

const fakeRequest = (acceptEncoding?: string) =>
	HttpServerRequest.fromWeb(
		new Request("http://localhost/", {
			...(acceptEncoding !== undefined && {
				headers: { "accept-encoding": acceptEncoding },
			}),
		}),
	);

const withTempStaticDir = <A, E, R>(
	program: (dir: string) => Effect.Effect<A, E, R>,
	acceptEncoding?: string,
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const dir = yield* fs.makeTempDirectoryScoped({
				prefix: "conduit-static-",
			});
			yield* fs.writeFileString(`${dir}/index.html`, "<html>app</html>");
			yield* fs.writeFileString(`${dir}/app.a1b2c3d4.js`, "console.log('x')");
			// A realistic Vite bundle: base64url hash, and big enough to compress.
			yield* fs.writeFileString(
				`${dir}/assets/index-C5y8mNaB.js`.replace("/assets", ""),
				"console.log('padding');".repeat(200),
			);
			yield* fs.makeDirectory(`${dir}/nested`);
			yield* fs.writeFileString(
				`${dir}/nested/index.html`,
				"<html>nested</html>",
			);
			return yield* program(dir).pipe(
				Effect.provideService(StaticDirTag, dir),
				Effect.provideService(
					HttpServerRequest.HttpServerRequest,
					fakeRequest(acceptEncoding),
				),
			);
		}),
	).pipe(Effect.provide(nodeLayer));

describe("Static file handler", () => {
	describe("getCacheControl", () => {
		it("returns immutable for content-hashed files", () => {
			expect(getCacheControl("app.a1b2c3d4.js")).toContain("immutable");
		});

		it("returns immutable for Vite base64url hashes", () => {
			// The original bug: these only ever matched lowercase hex, so every
			// real bundle was served must-revalidate and re-downloaded each load.
			for (const name of [
				"index-C5y8mNaB.js",
				"effect--wz1aTmo.js",
				"index-7iIZuZ8T.css",
				"manifest-BXkQ5EUk.webmanifest",
			]) {
				expect(getCacheControl(name)).toContain("immutable");
			}
		});

		it("does not mark word-like filenames immutable", () => {
			for (const name of ["index.html", "my-components.js", "sw.js"]) {
				expect(getCacheControl(name)).toContain("must-revalidate");
			}
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

		it.effect("gzips compressible assets when the client accepts it", () =>
			withTempStaticDir(
				() =>
					Effect.gen(function* () {
						const response = yield* serveStaticFile("/index-C5y8mNaB.js");
						expect(response.headers["content-encoding"]).toBe("gzip");
						expect(response.headers["vary"]).toContain("Accept-Encoding");
					}),
				"gzip, deflate, br",
			),
		);

		it.effect("serves plain bytes when gzip is not accepted", () =>
			withTempStaticDir(() =>
				Effect.gen(function* () {
					const response = yield* serveStaticFile("/index-C5y8mNaB.js");
					expect(response.headers["content-encoding"]).toBeUndefined();
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

		it.effect("returns bad request for malformed URI encoding", () =>
			withTempStaticDir(() =>
				Effect.gen(function* () {
					const response = yield* serveStaticFile("/%E0%A4%A");
					expect(response.status).toBe(400);
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
