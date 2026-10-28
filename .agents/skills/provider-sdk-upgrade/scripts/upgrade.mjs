// Usage: node .agents/skills/provider-sdk-upgrade/scripts/upgrade.mjs <command> [flags]
// targets [--claude V] [--anthropic V] [--opencode V] [--cursor V] | audit |
// pin [--dry-run] | catalog [--dry-run] | gates [--live] [--dry-run].
// Every command accepts --root DIR (default cwd), --only SLICE and --scratch DIR.
// State/downloads: /tmp/sdk-upgrade/. Run pnpm install yourself after pin.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, stripVTControlCharacters } from "node:util";

let scratch = "/tmp/sdk-upgrade";
const scripts = dirname(fileURLToPath(import.meta.url));
const workspaceFile = "pnpm-workspace.yaml";
const lockTest = "test/unit/contracts/providers/sdk-version-lock.guard.test.ts";
const packages = {
	claude: "@anthropic-ai/claude-agent-sdk",
	anthropic: "@anthropic-ai/sdk",
	opencode: "@opencode-ai/sdk",
	cursor: "@cursor/sdk",
};
const cursorHelpers = [
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-x64",
	"win32-x64",
].map((platform) => `@cursor/sdk-${platform}`);
const overrideLine = /^( {2}['"]?@anthropic-ai\/sdk['"]?: *)([^\n]+)/gm;
const read = (path) => fs.readFileSync(path, "utf8");
const json = (path) => JSON.parse(read(path));
const state = () => {
	const result = json(join(scratch, "targets.json"));
	if (only)
		assert(
			Object.keys(result.slices).length === 1 && result.slices[only],
			`Run targets --only ${only} first`,
		);
	return result;
};
const file = (name) => join(root, name);
const temp = (...names) => join(scratch, ...names);
const execJson = (args, options) => JSON.parse(exec(args, options));
const scalar = (value) => value.trim().replace(/^['"]|['"]$/g, "");
const save = (name, value) =>
	fs.writeFileSync(temp(name), `${JSON.stringify(value, null, 2)}\n`);
const print = console.log;
const warn = console.error;
let root = process.cwd();
let only;

function display(argv) {
	return argv
		.map((arg) =>
			/^[\w@./:=+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`,
		)
		.join(" ");
}

function run(argv, { log, ...options } = {}) {
	const fd = log ? fs.openSync(log, "a") : undefined;
	if (log) fs.writeFileSync(fd, `$ ${display(argv)}\n`);
	const result = spawnSync(argv[0], argv.slice(1), {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		killSignal: "SIGKILL",
		...options,
		stdio: log ? ["ignore", fd, fd] : "pipe",
	});
	let stderr = result.stderr ?? "";
	if (result.error) stderr += `${result.error.message}\n`;
	if (log && stderr) fs.writeFileSync(fd, stderr);
	if (log) fs.closeSync(fd);
	return { rc: result.status ?? 1, stdout: result.stdout ?? "", stderr };
}

function exec(argv, options) {
	const { rc, stdout, stderr } = run(argv, options);
	if (rc)
		throw new Error(
			`${display(argv)} failed (rc ${rc})\n${(stderr + stdout).slice(-1500)}`,
		);
	return stdout.trim();
}

function version(value, label) {
	assert(
		/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(value),
		`${label}: expected an exact version, got ${JSON.stringify(value)}`,
	);
	return value;
}

function one(text, pattern, label) {
	const matches = [...text.matchAll(pattern)];
	assert(
		matches.length === 1,
		`${label}: expected exactly one literal to replace, found ${matches.length}`,
	);
	return matches[0];
}

function update(text, pattern, item, label) {
	expected(one(text, pattern, label)[0], item, label);
	return text.replace(pattern, item.target);
}

function expected(value, { current, target }, label) {
	assert(
		value === current || value === target,
		`${label}: expected ${current} or ${target}, found ${value}`,
	);
}

// Workspace YAML uses top-level blocks with indented scalar/list entries.
function yamlBlock(text, key, optional = false) {
	const matches = [
		...text.matchAll(new RegExp(`^${key}: *\n(?: .*(?:\n|$)|\n)*`, "gm")),
	];
	if (!matches.length && optional) return "";
	if (matches.length !== 1)
		throw new Error(`pnpm-workspace.yaml: expected exactly one ${key} key`);
	return matches[0][0];
}

function excludes(workspace) {
	const block = yamlBlock(workspace, "minimumReleaseAgeExclude", true);
	return [...block.matchAll(/^ {2}- (.+)$/gm)].map((m) => scalar(m[1]));
}

function targets(flags) {
	const manifest = json(file("package.json"));
	const dependencies = manifest.dependencies;
	const workspace = read(file(workspaceFile));
	const override = one(
		yamlBlock(workspace, "overrides"),
		overrideLine,
		"@anthropic-ai/sdk override",
	);
	const age = [...workspace.matchAll(/^minimumReleaseAge: *([^\n]+)/gm)];
	if (age.length > 1) throw new Error("Duplicate minimumReleaseAge keys");
	const minimumAge = age.length ? Number(scalar(age[0][1])) : 1440;
	if (!Number.isFinite(minimumAge) || minimumAge < 0)
		throw new Error("Invalid minimumReleaseAge");
	const slices = {};
	for (const [slice, pkg] of Object.entries(packages)) {
		if (only && slice !== only) continue;
		const pinned =
			slice === "anthropic"
				? scalar(override[2])
				: slice === "cursor"
					? manifest.optionalDependencies[pkg]
					: dependencies[pkg];
		const current = version(pinned, pkg);
		const chosen = flags[slice] ?? exec(["npm", "view", pkg, "version"]);
		const target = version(chosen, `${slice} target`);
		const published = execJson(["npm", "view", pkg, "time", "--json"])[target];
		if (!published || !Number.isFinite(Date.parse(published)))
			throw new Error(`${pkg}@${target}: no publish time`);
		if (
			slice === "opencode" &&
			exec(["npm", "view", `opencode-ai@${target}`, "version"]) !== target
		)
			throw new Error(`opencode-ai@${target}: server release is unavailable`);
		if (slice === "cursor") {
			const helpers = execJson([
				"npm",
				"view",
				`${pkg}@${target}`,
				"optionalDependencies",
				"--json",
			]);
			for (const helper of cursorHelpers) {
				assert.equal(manifest.optionalDependencies[helper], current, helper);
				assert.equal(helpers[helper], target, `${helper} target`);
			}
		}
		const ageHours = (Date.now() - Date.parse(published)) / 3_600_000;
		const fresh = ageHours * 60 < minimumAge;
		slices[slice] = {
			package: pkg,
			current,
			target,
			published,
			ageHours,
			fresh,
		};
	}
	const pins = Object.values(slices).map((s) => `${s.package}@${s.target}`);
	const platform = /^(@anthropic-ai\/claude-agent-sdk|@cursor\/sdk)-[^@]+@/;
	const staleExcludes = excludes(workspace).filter(
		(entry) =>
			(!only ||
				entry.startsWith(`${packages[only]}@`) ||
				((only === "claude" || only === "cursor") &&
					entry.startsWith(`${packages[only]}-`))) &&
			!pins.includes(entry.replace(platform, "$1@")),
	);
	save("targets.json", { slices, staleExcludes });
	console.table(
		Object.entries(slices).map(([slice, { ageHours, fresh, ...pin }]) => ({
			slice,
			...pin,
			"age h": ageHours.toFixed(1),
			FRESH: fresh ? "FRESH" : "",
		})),
	);
	print(
		`Stale minimumReleaseAgeExclude entries: ${staleExcludes.length ? `\n${staleExcludes.join("\n")}` : "none"}`,
	);
	if (Object.values(slices).some((s) => s.fresh))
		print(
			"The user must choose to commit pnpm's exclude entries, wait, or pass an older --<slice> version.",
		);
	print(temp("targets.json"));
}

function packed(slice, pkg, v) {
	const dir = temp("pack", `${slice}-${v}`);
	if (!fs.existsSync(join(dir, ".extracted"))) {
		fs.mkdirSync(dir, { recursive: true });
		const args = ["npm", "pack", `${pkg}@${v}`, "--pack-destination", dir];
		const [archive] = execJson([...args, "--ignore-scripts", "--json"], {
			cwd: dir,
		});
		exec(["tar", "-xzf", join(dir, archive.filename), "-C", dir]);
		fs.writeFileSync(join(dir, ".extracted"), "");
	}
	return join(
		dir,
		"package",
		slice === "claude" ? "sdk.d.ts" : slice === "cursor" ? "dist/esm" : "dist",
	);
}

function audit() {
	for (const [slice, s] of Object.entries(state().slices)) {
		if (slice === "anthropic") {
			// Conduit never imports it; its shapes reach the contract only through
			// the Claude SDK's types, which pnpm check holds to AssertExtends.
			print("anthropic: not audited; pnpm check covers it via the Claude SDK");
			continue;
		}
		if (s.current === s.target) {
			print(`${slice}: nothing to audit (${s.current})`);
			continue;
		}
		const old = packed(slice, s.package, s.current);
		const next = packed(slice, s.package, s.target);
		const contracts =
			slice === "cursor"
				? [
						"src/lib/provider/cursor/sdk-port.ts",
						"src/lib/provider/cursor/sdk-trace-player.ts",
					]
				: [
						`src/lib/contracts/providers/${slice === "opencode" ? "opencode-sdk.ts" : "claude-agent-sdk.ts"}`,
					];
		const args = ["python3", "-I", join(scripts, "dts-diff.py"), old, next];
		const output = exec([
			...args,
			...contracts.flatMap((path) => ["--contract", file(path)]),
		]);
		const path = temp(`audit-${slice}.txt`);
		fs.writeFileSync(path, output ? `${output}\n` : "");
		const counts = {};
		const headers = output.split("\n").filter((line) => line.startsWith("## "));
		for (const tag of ["additive", "review", "comment", "contract"]) {
			counts[tag] = headers.filter((line) => line.includes(`[${tag}]`)).length;
		}
		print(`${slice}: ${path} ${JSON.stringify(counts)}`);
	}
}

function removeStale(workspace, stale) {
	const entries = excludes(workspace);
	for (const entry of stale) {
		if (entries.filter((v) => v === entry).length > 1)
			throw new Error(`Duplicate exclude entry: ${entry}`);
	}
	const block = yamlBlock(workspace, "minimumReleaseAgeExclude", true);
	if (!block) return workspace;
	const remaining = block.replace(/^ {2}- (.+)\n?/gm, (line, value) =>
		stale.includes(scalar(value)) ? "" : line,
	);
	return /^ {2}- /m.test(remaining)
		? workspace.replace(block, remaining)
		: workspace.replace(new RegExp(`\n?${RegExp.escape(block)}`), "");
}

function pin(flags) {
	const { slices, staleExcludes } = state();
	const paths = ["package.json", workspaceFile, ".opencode-version", lockTest];
	const originals = paths.map((path) => read(file(path)));
	let [pkgText, workspace, ocText, testText] = originals;
	const manifest = JSON.parse(pkgText);
	for (const [slice, s] of Object.entries(slices)) {
		if (slice === "anthropic") continue;
		const dependencies =
			slice === "cursor"
				? manifest.optionalDependencies
				: { ...manifest.dependencies, ...manifest.devDependencies };
		// The opencode-ai server is a devDependency so tests run the pinned build.
		const names =
			slice === "cursor"
				? [s.package, ...cursorHelpers]
				: slice === "opencode"
					? [s.package, "opencode-ai"]
					: [s.package];
		for (const name of names) {
			expected(dependencies[name], s, `${name} dependency`);
			const key = RegExp.escape(name);
			const pattern = new RegExp(`(?<="${key}"\\s*:\\s*")[^"]+`, "g");
			pkgText = update(pkgText, pattern, s, name);
		}
	}
	if (slices.anthropic) {
		const block = yamlBlock(workspace, "overrides");
		const override = one(block, overrideLine, "@anthropic-ai/sdk override");
		expected(
			scalar(override[2]),
			slices.anthropic,
			"@anthropic-ai/sdk override",
		);
		const updated = override[0].replace(
			scalar(override[2]),
			slices.anthropic.target,
		);
		workspace = workspace.replace(block, block.replace(override[0], updated));
	}
	if (slices.claude) {
		const comment =
			/(^#[^\r\n]*@anthropic-ai\/claude-agent-sdk@)(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)/gm;
		one(workspace, comment, "Claude version in override comment");
		workspace = workspace.replace(
			comment,
			(_m, prefix) => prefix + slices.claude.target,
		);
	}
	if (slices.cursor)
		assert(
			/^ {2}- ['"]?@cursor\/sdk-\*['"]?$/m.test(
				yamlBlock(workspace, "publicHoistPattern"),
			),
			"Cursor helpers need publicHoistPattern: '@cursor/sdk-*'",
		);
	workspace = removeStale(workspace, staleExcludes);
	if (slices.opencode) {
		expected(ocText.trim(), slices.opencode, ".opencode-version");
		ocText = ocText.replace(ocText.trim(), slices.opencode.target);
	}
	for (const [slice, s] of Object.entries(slices)) {
		const alternatives = [s.current, s.target].map(RegExp.escape).join("|");
		const pattern = new RegExp(`(?<=toBe\\(")(?:${alternatives})(?="\\))`, "g");
		const label = `${slice} version-lock test`;
		testText = update(testText, pattern, s, label);
	}
	// All four files are validated before any write.
	const edits = [pkgText, workspace, ocText, testText];
	let changed = false;
	paths.forEach((path, i) => {
		if (edits[i] === originals[i]) return;
		if (!flags["dry-run"]) fs.writeFileSync(file(path), edits[i]);
		print(`${flags["dry-run"] ? "Would change" : "Changed"} ${path}`);
		changed = true;
	});
	if (!changed) print("All pins already at target; no files changed.");
}

function installed(prefix, pkg, v, log) {
	const base = join(prefix, "node_modules");
	const manifest = join(base, pkg, "package.json");
	const bin = join(base, ".bin");
	const entry =
		pkg === "opencode-ai" ? join(bin, "opencode") : join(base, pkg, "sdk.mjs");
	const present = fs.existsSync(manifest) && fs.existsSync(entry);
	if (!present || json(manifest).version !== v) {
		fs.mkdirSync(prefix, { recursive: true });
		const args = ["npm", "install", "--prefix", prefix, `${pkg}@${v}`];
		exec([...args, "--no-audit", "--no-fund"], { cwd: prefix, log });
	}
	return bin;
}

async function claudeCatalog(s) {
	const prefix = temp(`claude-${s.current}`);
	installed(prefix, s.package, s.current);
	const targetDir = join(root, "node_modules", s.package);
	if (json(join(targetDir, "package.json")).version !== s.target)
		throw new Error(
			"Installed Claude SDK differs from target; run pnpm install first",
		);
	const sdkPaths = [
		join(prefix, "node_modules", s.package, "sdk.mjs"),
		join(targetDir, "sdk.mjs"),
	];
	const command = [process.execPath, join(scripts, "claude-catalog.mjs")];
	const [old, next] = sdkPaths.map((sdk) =>
		execJson([...command, sdk], { timeout: 120_000 }),
	);
	const added = next.models.filter((id) => !old.models.includes(id));
	const removed = old.models.filter((id) => !next.models.includes(id));
	const require = createRequire(join(root, "package.json"));
	const { tsImport } = await import(
		pathToFileURL(require.resolve("tsx/esm/api")).href
	);
	const modelFile = file("src/lib/provider/claude/claude-api-model-id.ts");
	const { hasContextWindowRow } = await tsImport(
		pathToFileURL(modelFile).href,
		import.meta.url,
	);
	const gaps = next.models.filter((id) => !hasContextWindowRow(id));
	print(
		`Claude claudeCodeVersion: ${old.claudeCodeVersion} -> ${next.claudeCodeVersion}`,
	);
	print(`Claude catalog: ${next.models.join(", ")}`);
	print(
		`Added: ${added.join(", ") || "none"}; removed: ${removed.join(", ") || "none"}`,
	);
	for (const id of gaps) print(`GAP ${id}`);
	return { old, new: next, added, removed, gaps };
}

function opencodeCatalog({ target: v }) {
	const bin = installed(temp(`oc-${v}`), "opencode-ai", v);
	const home = fs.mkdtempSync(temp("oc-home-"));
	const env = { ...process.env };
	env.HOME = home;
	for (const kind of ["CONFIG", "DATA", "CACHE", "STATE"])
		env[`XDG_${kind}_HOME`] = home;
	const output = exec([join(bin, "opencode"), "models", "opencode"], {
		cwd: home,
		env,
		timeout: 120_000,
	});
	const helper = read(file("test/contract/helpers/session-helpers.ts"));
	const matches = [...helper.matchAll(/\bmodelID:\s*"([^"]+)"/g)];
	if (matches.length !== 1)
		throw new Error("session-helpers.ts: expected exactly one literal modelID");
	const modelID = matches[0][1];
	const models = stripVTControlCharacters(output)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("opencode/"));
	const listed = models.includes(`opencode/${modelID}`);
	print(`OpenCode ${v} catalog:\n${models.join("\n")}`);
	print(`${listed ? "LISTED" : "MISSING"} contract model ${modelID}`);
	return { version: v, modelID, listed, models, home };
}

async function cursorCatalog(s, flags) {
	const installedVersion = json(
		file("node_modules/@cursor/sdk/package.json"),
	).version;
	assert.equal(
		installedVersion,
		s.target,
		"Installed Cursor SDK differs from target; run pnpm install first",
	);
	const helper = read(file("test/integration/daemon/cursor-discovery.test.ts"));
	const required = [
		...new Set(
			[...helper.matchAll(/\bmodelId:\s*"([^"]+)"/g)].map((m) => m[1]),
		),
	];
	assert(
		required.length,
		"cursor-discovery.test.ts: expected literal test model ids",
	);
	if (flags["dry-run"]) {
		print(
			`Cursor ${installedVersion}: discoverCursorEffect() via sdk-port.ts; CURSOR_API_KEY then SDK login; required models: ${required.join(", ")}`,
		);
		return { version: installedVersion, required, dryRun: true };
	}
	const require = createRequire(file("package.json"));
	const { tsImport } = await import(
		pathToFileURL(require.resolve("tsx/esm/api")).href
	);
	const { discoverCursorEffect } = await tsImport(
		pathToFileURL(file("src/lib/provider/cursor/cursor-runner-driver.ts")).href,
		import.meta.url,
	);
	const { Effect } = require("effect");
	const { models } = await Effect.runPromise(discoverCursorEffect());
	const ids = models.map((model) => model.id);
	const missing = required.filter((id) => !ids.includes(id));
	const replay = Boolean(process.env.CONDUIT_CURSOR_SDK_TRACE);
	print(
		`Cursor ${installedVersion} ${replay ? "replay" : "live"} catalog: ${ids.join(", ")}`,
	);
	for (const id of required)
		print(
			`${missing.includes(id) ? "MISSING" : "LISTED"} Cursor test model ${id}`,
		);
	return {
		version: installedVersion,
		models: ids,
		required,
		missing,
		listed: !missing.length,
		replay,
	};
}

async function catalog(flags) {
	const result = {};
	const probes = {
		claude: claudeCatalog,
		opencode: opencodeCatalog,
		cursor: cursorCatalog,
	};
	const { slices } = state();
	for (const [slice, probe] of Object.entries(probes)) {
		if (!slices[slice]) continue;
		if (flags["dry-run"] && slice !== "cursor") {
			print(
				`${slice}: would query the model catalog for ${slices[slice].target}`,
			);
			continue;
		}
		try {
			result[slice] = await probe(slices[slice], flags);
			if (result[slice].listed === false) process.exitCode = 1;
		} catch (error) {
			process.exitCode = 1;
			result[slice] = { error: error.message };
			const label = {
				claude: "Claude",
				opencode: "OpenCode",
				cursor: "Cursor",
			}[slice];
			warn(`${label} catalog error: ${error.message}`);
		}
	}
	if (!flags["dry-run"]) save("catalog.json", result);
	print(temp("catalog.json"));
}

function gates(flags) {
	const cursorOnly = only === "cursor";
	const includeCursor = !only || cursorOnly;
	if (includeCursor) {
		try {
			createRequire(file("package.json")).resolve("@cursor/sdk");
		} catch (cause) {
			throw new Error(
				"Cursor upgrade gates require installed @cursor/sdk, including when checking with --dry-run. Install optional dependencies before running the gates.",
				{ cause },
			);
		}
	}
	const v = read(file(".opencode-version")).trim();
	version(v, ".opencode-version");
	const prefix = temp(`oc-${v}`);
	const bin = join(prefix, "node_modules", ".bin");
	const oc = join(bin, "opencode");
	const contractEnv = {
		...process.env,
		PATH: `${bin}:${process.env.PATH ?? ""}`,
	};
	const entries = [
		["check", ["pnpm", "check"]],
		["lint", ["pnpm", "lint"]],
		["unit", ["pnpm", "test:unit"]],
		...(cursorOnly
			? []
			: [["contract", ["pnpm", "test:contract"], contractEnv]]),
	];
	if (includeCursor) {
		entries.push(
			[
				"cursor-sdk-contract",
				[
					"pnpm",
					"exec",
					"vitest",
					"run",
					"--config",
					"vitest.e2e.config.ts",
					"test/e2e/provider/cursor-skills-real-sdk.test.ts",
					"test/e2e/provider/cursor-credentials-real-sdk.test.ts",
					"test/e2e/provider/cursor-errors-real-sdk.test.ts",
				],
				{ ...process.env, RUN_CURSOR_SKILLS_SMOKE: "0" },
			],
			[
				"cursor-boundary",
				[process.execPath, "scripts/check-cursor-sdk-boundary.mjs"],
			],
			[
				"cursor-traces",
				[process.execPath, "scripts/check-cursor-sdk-traces.mjs"],
			],
			["build", ["pnpm", "build"]],
			[
				"cursor-replay",
				[
					"pnpm",
					"exec",
					"vitest",
					"run",
					"--config",
					"vitest.integration.config.ts",
					"test/integration/daemon/cursor-discovery.test.ts",
					"test/integration/daemon/cursor-driver-unavailable.test.ts",
				],
			],
		);
		if (flags.live)
			entries.push([
				"cursor-live",
				[
					"pnpm",
					"exec",
					"vitest",
					"run",
					"--config",
					"vitest.e2e.config.ts",
					"test/e2e/provider/cursor-sdk-live.test.ts",
				],
			]);
	}
	if (flags.live && !cursorOnly) {
		const tests = [
			"claude-runner-real-sdk",
			"claude-provider-instance-real-sdk",
		].map((name) => `test/e2e/provider/${name}.test.ts`);
		const args = ["npx", "--no-install", "vitest", "run"];
		args.push("--config", "vitest.e2e.config.ts", ...tests);
		entries.push(...(includeCursor ? [] : [["build", ["pnpm", "build"]]]), [
			"real-sdk",
			args,
			{ ...process.env, RUN_EXPENSIVE_E2E: "1" },
		]);
	}
	const results = [];
	if (flags["dry-run"]) print(`Root: ${root}`);
	else fs.mkdirSync(temp("gates"), { recursive: true });
	for (const [name, command, env] of entries) {
		const args =
			command[0] === "pnpm" ? ["mise", "exec", "--", ...command] : command;
		const log = temp("gates", `${name}.log`);
		if (flags["dry-run"]) {
			if (name === "contract")
				print(
					`contract preparation: ${display(["npm", "install", "--prefix", prefix, `opencode-ai@${v}`])} if missing; ${display([oc, "--version"])} must equal ${v}`,
				);
			const labels = {
				"cursor-sdk-contract": "RUN_CURSOR_SKILLS_SMOKE=0 ",
				contract: `PATH=${bin}:$PATH `,
				"real-sdk": "RUN_EXPENSIVE_E2E=1 ",
			};
			const vars = labels[name] ?? "";
			print(`${name}: ${vars}${display(args)} -> ${log}`);
			continue;
		}
		fs.writeFileSync(log, "");
		const started = performance.now();
		let rc;
		try {
			if (name === "cursor-live" && !process.env.CURSOR_API_KEY)
				throw new Error(
					"Cursor live smoke requires CURSOR_API_KEY; SDK login can run catalog only",
				);
			if (name === "contract") {
				installed(prefix, "opencode-ai", v, log);
				const actual = exec([oc, "--version"]);
				fs.writeFileSync(log, `$ ${display([oc, "--version"])}\n${actual}\n`, {
					flag: "a",
				});
				if (actual !== v)
					throw new Error(`opencode --version: expected ${v}, got ${actual}`);
			}
			rc = run(args, { log, env }).rc;
		} catch (error) {
			rc = 1;
			fs.writeFileSync(log, `${error.message}\n`, { flag: "a" });
		}
		const seconds = Number(((performance.now() - started) / 1000).toFixed(1));
		results.push({ gate: name, rc, seconds, log });
	}
	if (flags["dry-run"]) return;
	save("gates.json", results);
	console.table(results);
	for (const { gate, rc, log } of results)
		if (rc)
			warn(
				`\n${gate} failed:\n${fs.readFileSync(log).subarray(-1500).toString("utf8")}`,
			);
	if (results.some((r) => r.rc)) process.exitCode = 1;
}

const command = process.argv[2];
const cli = display([process.execPath, join(scripts, "upgrade.mjs")]);
let next = `${cli} ${display(process.argv.slice(2))}`;
try {
	const commands = { targets, audit, pin, catalog, gates };
	if (!Object.hasOwn(commands, command))
		throw new Error(
			"Usage: upgrade.mjs <targets|audit|pin|catalog|gates> [--root DIR] [flags]",
		);
	const options = {
		root: { type: "string" },
		only: { type: "string" },
		scratch: { type: "string" },
	};
	const flags = {
		targets: Object.keys(packages),
		pin: ["dry-run"],
		catalog: ["dry-run"],
		gates: ["live", "dry-run"],
	};
	for (const flag of flags[command] ?? [])
		options[flag] = { type: command === "targets" ? "string" : "boolean" };
	const { values } = parseArgs({ args: process.argv.slice(3), options });
	root = resolve(values.root ?? root);
	only = values.only;
	if (only && !Object.hasOwn(packages, only))
		throw new Error(`Unknown slice: ${only}`);
	scratch = resolve(values.scratch ?? scratch);
	fs.mkdirSync(scratch, { recursive: true });
	await commands[command](values);
	const atRoot = ` --root ${display([root])}${only ? ` --only ${only}` : ""} --scratch ${display([scratch])}`;
	const nextCommands = {
		targets: `${cli} audit${atRoot}`,
		audit: `${cli} pin${atRoot}`,
		pin: values["dry-run"]
			? `${cli} pin${atRoot}`
			: `${display(["mise", "exec", "--", "pnpm", "--dir", root, "install"])} && ${cli} catalog${atRoot}`,
		catalog: `${cli} ${values["dry-run"] ? "catalog" : "gates"}${atRoot}`,
		gates: values["dry-run"]
			? `${cli} gates${atRoot}${values.live ? " --live" : ""}`
			: values.live
				? "Record versions, claude_code_version, audit summary, catalog changes, and gate results into the bead."
				: `${cli} gates${atRoot} --live`,
	};
	if (!process.exitCode) next = nextCommands[command];
} catch (error) {
	warn(`Error: ${error.message}`);
	process.exitCode = 1;
} finally {
	print(`Next: ${next}`);
}
