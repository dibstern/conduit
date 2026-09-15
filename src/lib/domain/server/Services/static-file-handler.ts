import { promisify } from "node:util";
import { gzip } from "node:zlib";
import {
	FileSystem,
	HttpServerRequest,
	HttpServerResponse,
	Path,
} from "@effect/platform";
import { Context, Data, Effect, Layer } from "effect";

const gzipAsync = promisify(gzip);

export const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".webp": "image/webp",
	".webmanifest": "application/manifest+json",
	".map": "application/json",
};

const HASH_SEGMENT = /[.-]([A-Za-z0-9_-]{8,})\.[A-Za-z0-9]+$/;

/**
 * Vite emits `name-HASH.ext` with a base64url hash — mixed case, `-`/`_` — which
 * the old lowercase-hex pattern never matched, leaving every asset uncacheable.
 * Requiring a digit or mixed case keeps real words (`my-components.js`) out.
 */
function isContentHashed(filePath: string): boolean {
	const hash = HASH_SEGMENT.exec(filePath)?.[1];
	if (hash === undefined) return false;
	return /\d/.test(hash) || (/[a-z]/.test(hash) && /[A-Z]/.test(hash));
}

export function getCacheControl(filePath: string): string {
	return isContentHashed(filePath)
		? "public, max-age=31536000, immutable"
		: "public, max-age=0, must-revalidate";
}

const COMPRESSIBLE =
	/^(?:text\/|application\/(?:javascript|json|manifest\+json)|image\/svg\+xml)/;
const COMPRESS_MIN_BYTES = 1024;

/**
 * Gzipped bytes for content-hashed assets, which by definition never change.
 * Bounded because the built asset set is small and fixed per build.
 */
const gzipCache = new Map<string, Uint8Array>();
const GZIP_CACHE_MAX = 64;

export class StaticDirTag extends Context.Tag("StaticDir")<
	StaticDirTag,
	string
>() {}

export const makeStaticDirLive = (
	staticDir: string,
): Layer.Layer<StaticDirTag> => Layer.succeed(StaticDirTag, staticDir);

class InvalidStaticPathEncoding extends Data.TaggedError(
	"InvalidStaticPathEncoding",
)<{
	readonly requestPath: string;
	readonly cause: unknown;
}> {}

const decodeRequestPath = (requestPath: string) =>
	requestPath === "/" || requestPath === ""
		? Effect.succeed("index.html")
		: Effect.try({
				try: () => decodeURIComponent(requestPath).replace(/^\/+/, ""),
				catch: (cause) => new InvalidStaticPathEncoding({ requestPath, cause }),
			});

const isWithinBase = (
	pathModule: Path.Path,
	staticDir: string,
	resolved: string,
) => {
	const base = pathModule.resolve(staticDir);
	const baseWithSep = base.endsWith(pathModule.sep)
		? base
		: base + pathModule.sep;
	return resolved === base || resolved.startsWith(baseWithSep);
};

const serveFileContent = (
	fs: FileSystem.FileSystem,
	pathModule: Path.Path,
	resolved: string,
	cachePath: string,
) =>
	Effect.gen(function* () {
		const content = yield* fs.readFile(resolved);
		const ext = pathModule.extname(resolved).toLowerCase();
		const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
		const cacheControl = getCacheControl(cachePath);

		const headers: Record<string, string> = {
			"Content-Type": contentType,
			"Cache-Control": cacheControl,
			Vary: "Accept-Encoding",
		};

		const request = yield* HttpServerRequest.HttpServerRequest;
		const acceptsGzip = (request.headers["accept-encoding"] ?? "").includes(
			"gzip",
		);
		if (
			!acceptsGzip ||
			content.length < COMPRESS_MIN_BYTES ||
			!COMPRESSIBLE.test(contentType)
		) {
			return HttpServerResponse.uint8Array(content, { headers });
		}

		const immutable = cacheControl.includes("immutable");
		const cached = immutable ? gzipCache.get(resolved) : undefined;
		const compressed =
			cached ?? (yield* Effect.promise(() => gzipAsync(content)));
		if (immutable && !cached && gzipCache.size < GZIP_CACHE_MAX) {
			gzipCache.set(resolved, compressed);
		}

		return HttpServerResponse.uint8Array(compressed, {
			headers: { ...headers, "Content-Encoding": "gzip" },
		});
	});

export const serveStaticFile = (requestPath: string) =>
	Effect.gen(function* () {
		const staticDir = yield* StaticDirTag;
		const fs = yield* FileSystem.FileSystem;
		const pathModule = yield* Path.Path;
		const filePath = yield* decodeRequestPath(requestPath);

		const resolved = pathModule.resolve(staticDir, filePath);
		if (!isWithinBase(pathModule, staticDir, resolved)) {
			return yield* HttpServerResponse.text("Forbidden", { status: 403 });
		}

		const exists = yield* fs.exists(resolved);
		if (exists) {
			const info = yield* fs.stat(resolved);
			if (info.type === "Directory") {
				const indexPath = pathModule.resolve(resolved, "index.html");
				if (!isWithinBase(pathModule, staticDir, indexPath)) {
					return yield* HttpServerResponse.text("Forbidden", { status: 403 });
				}
				const indexExists = yield* fs.exists(indexPath);
				if (indexExists) {
					return yield* serveFileContent(
						fs,
						pathModule,
						indexPath,
						"index.html",
					);
				}
				return yield* HttpServerResponse.text("Not Found", { status: 404 });
			}
			return yield* serveFileContent(fs, pathModule, resolved, filePath);
		}

		if (filePath !== "index.html") {
			const indexPath = pathModule.resolve(staticDir, "index.html");
			const indexExists = yield* fs.exists(indexPath);
			if (indexExists) {
				return yield* serveFileContent(fs, pathModule, indexPath, "index.html");
			}
		}

		return yield* HttpServerResponse.text("Not Found", { status: 404 });
	}).pipe(
		Effect.catchTag("InvalidStaticPathEncoding", () =>
			HttpServerResponse.text("Bad Request", { status: 400 }),
		),
		Effect.catchTag("SystemError", (err) =>
			HttpServerResponse.text("Internal Server Error", { status: 500 }).pipe(
				Effect.tap(Effect.logWarning("Static file error", err)),
			),
		),
		Effect.withSpan("static.serveFile"),
	);
