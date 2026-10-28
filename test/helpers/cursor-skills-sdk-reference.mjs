// Observe the installed SDK's complete discovery pipeline without editing it.
// The executor hides its workspace services, so expose two closures in memory.
// Unique anchors deliberately fail on an incompatible SDK upgrade.
import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import net from "node:net";

const acquireKey = Symbol.for("conduit.cursor.skills.acquire");
const referenceKey = Symbol.for("conduit.cursor.skills.reference");
const networkAttempts = [];
globalThis.fetch = async (url) => {
	networkAttempts.push(String(url).split("?")[0]);
	throw new Error("C5-A reference runs offline");
};
net.Socket.prototype.connect = () => {
	networkAttempts.push("socket");
	throw new Error("C5-A reference runs offline");
};
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context);
		} catch (error) {
			if (
				error.code !== "ERR_MODULE_NOT_FOUND" ||
				!specifier.startsWith(".") ||
				!specifier.endsWith(".js") ||
				!context.parentURL?.includes("/src/")
			)
				throw error;
			return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
		}
	},
	load(url, context, nextLoad) {
		const loaded = nextLoad(url, context);
		if (!url.includes("/@cursor/sdk/dist/esm/")) return loaded;
		let source = String(loaded.source);
		if (url.endsWith("/index.js")) {
			const platform = /\b(\w+) as CursorAgentPlatform\b/.exec(source)?.[1];
			if (!platform) throw new Error("Cursor SDK platform export changed");
			source += `;globalThis[Symbol.for("conduit.cursor.skills.acquire")] = ${platform}.prototype.acquireLocalExecutor;`;
		}
		if (source.includes("createLocalExecutor:()=>")) {
			const anchor = ";let R,T;return(0,RI.ou)(";
			if (source.split(anchor).length !== 2)
				throw new Error("Cursor SDK skill reference anchor changed");
			source = source.replace(
				anchor,
				`;let R,T;globalThis[Symbol.for("conduit.cursor.skills.reference")] = () => P.services.getAgentSkills(a);return(0,RI.ou)(`,
			);
		}
		return { ...loaded, source };
	},
});

const [input, output] = process.argv.slice(2);
const options = JSON.parse(input);
const { createRealCursorSdkPort } = await import(
	"../../src/lib/provider/cursor/sdk-real.ts"
);
await createRealCursorSdkPort().probeRuntime();
const acquire = globalThis[acquireKey];
if (typeof acquire !== "function")
	throw new Error("Cursor SDK executor cache route changed");
let lease;
try {
	// No credential means no dashboard transport and no managed synchronization.
	lease = await acquire({
		workingDirectory: options.cwd,
		dirs: options.dirs ?? [],
		settingSources: options.settingSources,
	});
	const list = globalThis[referenceKey];
	if (typeof list !== "function")
		throw new Error("Cursor SDK skill getter was not captured");
	const skills = await list();
	const { Effect } = await import("effect");
	const { discoverCursorSkillsEffect } = await import(
		"../../src/lib/provider/cursor/cursor-skill-discovery.ts"
	);
	const conduitSkills = await Effect.runPromise(
		discoverCursorSkillsEffect(options.cwd, options),
	);
	writeFileSync(
		output,
		JSON.stringify({ skills, conduitSkills, networkAttempts }, null, 2),
	);
} finally {
	await lease?.release();
	hooks.deregister();
}
