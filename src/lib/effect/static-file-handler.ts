import { FileSystem, HttpServerResponse, Path } from "@effect/platform";
import { Context, Data, Effect, Layer } from "effect";

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

export function getCacheControl(filePath: string): string {
	return filePath.includes(".") && /\.[a-f0-9]{8,}\./.test(filePath)
		? "public, max-age=31536000, immutable"
		: "public, max-age=0, must-revalidate";
}

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
		return HttpServerResponse.uint8Array(content, {
			headers: {
				"Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
				"Cache-Control": getCacheControl(cachePath),
			},
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
