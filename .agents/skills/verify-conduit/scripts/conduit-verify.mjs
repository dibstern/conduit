#!/usr/bin/env node
// A short-lived JSON client. launch.ts owns the browser and isolated server.
import { spawn, spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { checkFeatures } from "./features-check.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const executable = relative(process.cwd(), fileURLToPath(import.meta.url));
const launchPath = join(scriptDir, "launch.ts");
const frontendDir = resolve(scriptDir, "../../../../src/lib/frontend");
const groups = {
	lifecycle: ["up", "doctor", "info", "down", "selftest"],
	navigation: [
		"home",
		"reload",
		"new-session",
		"open-session",
		"pick-model",
		"scroll",
		"select-project",
	],
	interaction: [
		"send",
		"click",
		"hover",
		"fill",
		"type",
		"press",
		"eval",
		"upload-image",
	],
	inspection: [
		"snapshot",
		"screenshot",
		"store",
		"console",
		"ws-log",
		"network-log",
		"perf-metrics",
	],
	debugging: ["wait-settle", "logs", "trace", "feature-flag"],
	replay: ["hold", "release"],
	maintenance: ["features"],
};
// Entries declare all accepted options, so typos fail before a browser action.
const commands = {
	up: {
		purpose:
			"Start an isolated server and launcher-owned Chromium, or return the running instance.",
		args: [],
		options: {
			"claude-turns": "value",
			"claude-delay-ms": "value",
			"opencode-recording": "value",
			"codex-turn": "value",
			"cursor-trace": "value",
			"no-seed-accounts": "flag",
			phone: "flag",
			headed: "flag",
			video: "flag",
		},
		details:
			"--claude-turns a,b selects Claude replay turns; --claude-delay-ms n waits n ms between replayed Claude messages, so in-progress states stay visible; --opencode-recording name, --codex-turn name and --cursor-trace name select recordings. --no-seed-accounts skips the seeded Cursor account. --phone uses 393x852 with mobile/touch; --headed shows Chromium. Otherwise VIEWPORT and HEADED are respected. --video (VIDEO=1) records every page of the run at the viewport size into runDir/videos. Recording costs CPU and produces larger evidence; keep video runs short and focused on the flow being proved. down finalizes the videos. Waits up to 120 seconds for READY.",
		example: "up --run demo --phone --claude-turns pong-thinking-text-turn",
		output: "{baseUrl, runDir, controlSocket, cdpUrl, alreadyRunning?:true}",
	},
	doctor: {
		purpose:
			"Read-only checks of isolation, pids, health, build identity, socket and attached page.",
		args: [],
		options: {},
		details:
			"Exit 1 when unhealthy. buildId compares the served id with dist/; frontendBuildId checks dist/frontend carries the served id (a build:server-only rebuild fails it). Either mismatch needs a full pnpm build, then down and up.",
		example: "doctor --run demo",
		output: "{healthy, checks:[{name, ok, detail}]}",
	},
	info: {
		purpose:
			"Read instance metadata, current page URL and the optional playwright-cli attach command.",
		args: [],
		options: {},
		details:
			"Attaching shares the launcher's page. Late attachment only sees later HTTP requests; use ws-log for WebSocket events.",
		example: "info --run demo",
		output:
			"{...instance, video:boolean, pageUrl, pageAttached, codexStage:{current,total}, playwrightAttach}",
	},
	down: {
		purpose: "Stop only the recorded launcher and keep the evidence directory.",
		args: [],
		options: { "dry-run": "flag" },
		details:
			"--dry-run reports launcher, server and browser pids, temporary root and socket without sending signals or changing files. browserPid is null if Chromium could not report it. Otherwise SIGTERM is followed by a wait for STOPPED and process exit. The context closes before the browser to finalize every page's video; videos lists existing, non-empty absolute .webm paths, or [] when not recording. Missing or empty recordings make teardown fail.",
		example: "down --run demo --dry-run",
		output:
			"{stopped, evidenceDir, videos:[absolutePath]} or {dryRun:true, launcherPid, serverPid, browserPid, root, socket, evidenceDir}",
	},
	hold: {
		purpose: "Hold a provider replay at a chosen point.",
		args: [],
		options: { claude: "value", codex: "value", opencode: "value" },
		details:
			"Choose exactly one provider. Claude --claude T:M holds the T-th prompt of every Claude session before its M-th delivered replay message; T and M are positive integers. Codex --codex N holds inbound trace rows whose at exceeds non-negative integer N; this also stalls usage polls while held. OpenCode --opencode session.status|permission.asked|question.asked holds the next prompt after its first event of that type. release lets them continue.",
		example: "hold --claude 1:5",
		output: "{held:{claude?|codex?|opencode?}}",
	},
	release: {
		purpose: "Release held provider replays so they continue.",
		args: [],
		options: { claude: "flag", codex: "flag", opencode: "flag" },
		details:
			"--claude, --codex and --opencode select providers; none releases all three. Returns and clears Claude hold arrival records, removes its hold, opens the Codex gate and releases stored OpenCode holds for the selected providers.",
		example: "release --claude",
		output:
			"{released:[provider], claudeReached:[{pid,hold:{turn,message,id},at}]}",
	},
	home: {
		purpose: "Navigate to the app root and draft composer.",
		args: [],
		options: {},
		details: "Waits for the composer input to be visible before returning.",
		example: "home",
		output: "{path}",
	},
	reload: {
		purpose: "Reload the current page and wait for the composer to be ready.",
		args: [],
		options: {},
		details:
			"Keeps the current URL and waits for the composer input to be visible, just like home.",
		example: "reload",
		output: "{path}",
	},
	"new-session": {
		purpose: "Open a new draft through the back and New session controls.",
		args: [],
		options: {},
		example: "new-session",
		output: "{path}",
	},
	"open-session": {
		purpose: "Open an existing session by id.",
		args: ["id"],
		options: {},
		details: "id is the stored session id, for example ses_abc.",
		example: "open-session ses_abc",
		output: "{path}",
	},
	"pick-model": {
		purpose:
			"Pick a harness, provider and model through the composer model picker.",
		args: [],
		options: { harness: "value", model: "value", provider: "value" },
		required: ["harness", "model", "provider"],
		details:
			"--harness claude|opencode|codex|cursor, --model id and --provider id are required. Works with Icons and Words controls on desktop and phone, including the Composer sheet. OpenCode uses provider anthropic. Model ids are quoted in generated CSS selectors.",
		example: "pick-model --harness codex --model gpt-6.1-sol --provider codex",
		output: "{instanceId, shownProvider, shownModel, sendDisabled}",
	},
	scroll: {
		purpose:
			"Scroll the single matched element into view or move its scroll container.",
		args: ["selector"],
		options: { to: "value", by: "value" },
		details:
			"Without options, scrolls the element into view. --to top|bottom scrolls the element's own scroll container, or its nearest scrollable ancestor. --by px sends a real vertical mouse wheel over the element; pixels may be negative. The flags are mutually exclusive. Zero or multiple matches fail with a snapshot hint. Returns the affected container's vertical scroll metrics.",
		example: 'scroll "#session-list-scroller" --to bottom',
		output: "{scrollTop, scrollHeight, clientHeight}",
	},
	"select-project": {
		purpose: "Select a project through the session list's scope chip and menu.",
		args: ["project"],
		options: {},
		details:
			"project is an exact name or slug read from the scope menu. Clicks its radio item and waits for ?p=<slug>. Desktop keeps the current pathname and open session or draft. On phone, the scope menu lives on the session list, so the command lands there; the open session or draft is not kept. Returns the actual resulting path, including the query string. Unknown projects fail with the available names and slugs; duplicate names require a slug.",
		example: "select-project process-test",
		output: "{slug, path} where path includes the query string",
	},
	send: {
		purpose:
			"Fill the composer, optionally pick a model, send through the UI and wait for the reply.",
		args: ["text"],
		options: {
			harness: "value",
			model: "value",
			provider: "value",
			"no-wait": "flag",
			timeout: "value",
		},
		details:
			"text is one quoted argument. --harness, --model and --provider must be supplied together. Model selection supports Icons and Words on desktop and phone and happens before filling the prompt. --no-wait returns after clicking Send and navigating to the session, without waiting for the reply. --timeout milliseconds bounds settling, default 60000. Settling waits for inactive turns, an empty or paused queue, 300 ms of DOM quiet and 750 ms without turn or queue changes. A reply is the last assistant .md-content, excluding user messages. Replay prompt limits still apply.",
		example:
			'send "Say hello" --harness claude --model opus --provider claude --timeout 60000',
		output: "{path, sessionId, reply, turnStatus, ms}",
	},
	click: {
		purpose: "Click the single element matching a Playwright selector.",
		args: ["selector"],
		options: { double: "flag", button: "value" },
		details:
			"--double sends a double-click. --button left|right|middle selects the mouse button, default left; it can be combined with --double. A selector matching zero or multiple elements fails with its count and a snapshot hint.",
		example: 'click "#input" --button right',
		output: "{clicked:selector}",
	},
	hover: {
		purpose: "Move the pointer over the single element matching a selector.",
		args: ["selector"],
		options: {},
		details:
			"Uses Playwright hover with its normal visibility and actionability checks. Zero or multiple matches fail with a snapshot hint.",
		example: 'hover "#attach-btn"',
		output: "{hovered:selector}",
	},
	fill: {
		purpose: "Replace an input's contents through a Playwright locator.",
		args: ["selector", "text"],
		options: {},
		details:
			"selector must match exactly one element. Quote both arguments when they contain spaces.",
		example: 'fill "#input" "Hello there"',
		output: "{filled:selector}",
	},
	type: {
		purpose:
			"Type text into the currently focused element through its locator.",
		args: ["text"],
		options: {},
		details:
			"The focused-element locator must match exactly one element. Use fill when you know the input selector.",
		example: 'type "Hello there"',
		output: "{typed:true}",
	},
	press: {
		purpose:
			"Press a key or chord on the focused element, or on the page when nothing is focused.",
		args: ["key"],
		options: {},
		details: "Use Playwright key names such as Escape, Enter or Control+Enter.",
		example: "press Escape",
		output: "{pressed:key}",
	},
	eval: {
		purpose:
			"Evaluate a JavaScript function in the page for observation and debugging.",
		args: ["source"],
		options: {},
		details:
			"source must be a JavaScript function expression returning JSON-serializable data. Do not use eval to reach an end state as proof of a user path.",
		example: 'eval "() => ({path: location.pathname})"',
		output: "the JSON-serializable function result",
	},
	"upload-image": {
		purpose: "Attach an image through Attach and Add Photos.",
		args: ["file"],
		options: {},
		details:
			"file is a local path to an image. Opens Attach if needed, selects Add Photos (#attach-photos), fills the filechooser and closes the Attach menu. Waits until the attachment chip has finished saving.",
		example: "upload-image /tmp/example.png",
		output: "attachment chip state",
	},
	snapshot: {
		purpose: "Read the body's ARIA snapshot for stable accessible controls.",
		args: [],
		options: { file: "value" },
		details:
			"--file path writes the full snapshot. Inline output is limited to 20 KB with a truncation note.",
		example: "snapshot --file test-results/verify-conduit/demo/after.aria.yml",
		output: "{snapshot, truncated, note?} or {file}",
	},
	screenshot: {
		purpose: "Capture the current page as a PNG.",
		args: [],
		options: { file: "value" },
		details:
			"--file path overrides the auto-numbered runDir/shots/NNN.png destination.",
		example: "screenshot",
		output: "{file}",
	},
	store: {
		purpose:
			"Observe the isolated event store through read-only SQLite queries.",
		args: ["kind", "sql?"],
		subcommands: ["sessions", "messages", "turns", "sql"],
		options: { session: "value" },
		details:
			'Subcommands: sessions; messages [--session id]; turns [--session id]; sql "SELECT ...". SQL must be a SELECT. Store access observes results; it is not a user path.',
		example: "store messages --session ses_abc",
		output: "rows: JSON array of database rows",
	},
	"wait-settle": {
		purpose:
			"Wait for inactive turns, an empty or paused queue and a quiet page.",
		args: [],
		options: { timeout: "value" },
		details:
			"--timeout milliseconds defaults to 60000. Session turns must be inactive, the composer must have no Stop control, and pending-input rows must be empty or explicitly paused. Requires 300 ms of DOM quiet and 750 ms without turn or queue changes. A new turn restarts the quiet window. Drafts use the same DOM and queue checks without stored turns. Timeout errors include the last observed state.",
		example: "wait-settle --timeout 60000",
		output: "{settled, ms, turnStatus}",
	},
	console: {
		purpose:
			"Read console messages and page errors buffered since the browser opened.",
		args: [],
		options: { level: "value", since: "value" },
		details:
			"--level error|warning|info filters messages. --since n includes messages after a timestamp in milliseconds. The buffer holds up to 2000 messages, with level, text, location and time.",
		example: "console --level error --since 0",
		output: "[{level, text, location, time}]",
	},
	"ws-log": {
		purpose:
			"Read the page's WebSocket debug buffer without opening the debug overlay.",
		args: [],
		options: { last: "value", payloads: "flag" },
		details:
			"--last n limits frames, default 300. Records incoming and outgoing frames from page creation, including browser RPCs, with direction in|out. The buffer keeps 2000 frames across reloads. --payloads includes parsed JSON or raw text, omitted by default. The ?feats=debug overlay covers Send at 1440x900; use this command instead.",
		example: "ws-log --last 20",
		output: "[{time, direction, event, detail, state, url, payload?}]",
	},
	"network-log": {
		purpose:
			"Read HTTP requests recorded since browser context creation, across reloads.",
		args: [],
		options: { last: "value", failed: "flag", grep: "value", summary: "flag" },
		details:
			"Records up to 2000 requests across all pages, excluding WebSocket upgrades. Same-origin URLs are path+query; other URLs are absolute. --last n defaults to 100 and applies after filtering. --failed keeps transport failures and HTTP status >=400; --grep re matches the URL. --summary counts the selected entries by status and by method path with query stripped, and lists failures. status and durationMs are null while a request is pending; transport failures have a failure string.",
		example: 'network-log --last 200 --grep "/api/" --summary',
		output:
			"[{time, method, url, status, resourceType, durationMs, failure?}] or {total, byStatus, byMethodPath, failures:[entry]}",
	},
	"feature-flag": {
		purpose:
			"Enable or disable a frontend feature flag using its URL and persisted settings.",
		args: ["name", "state"],
		options: {},
		details:
			"state is on|off. Valid names come from src/lib/frontend/stores/feature-flags.svelte.ts. on adds the flag to ?feats=, which the app persists; off removes it from both ?feats= and localStorage. Keeps the current path and other query parameters, then waits for the composer or phone New session control like reload. Returns enabled flags read back from the page. The debug panel overlays #send at 1440x900; turn it off before sending.",
		example: "feature-flag debug off",
		output: "{flags:[name]}",
	},
	logs: {
		purpose:
			"Read full server stdout/stderr, optionally changing the server log level first.",
		args: [],
		options: { bytes: "value", grep: "value", level: "value" },
		details:
			"--bytes limits the read to the last N bytes, default 8000. --grep re filters lines. --level verbose|info|warn changes the running server's log level through SetLogLevel before reading; it does not filter existing log lines. Use --grep to filter. Use this only for observation and debugging, not as user-path proof.",
		example: 'logs --level verbose --bytes 8000 --grep "session|turn"',
		output: "lines: JSON array of log lines",
	},
	"perf-metrics": {
		purpose: "Read Chromium Performance.getMetrics through a page CDP session.",
		args: [],
		options: {},
		example: "perf-metrics",
		output: "{[metricName]:number}",
	},
	trace: {
		purpose: "Start or stop Playwright tracing with screenshots and snapshots.",
		args: ["action"],
		subcommands: ["start", "stop"],
		options: { file: "value" },
		details:
			"Subcommands: start; stop [--file path]. stop defaults to runDir/traces/NNN.zip. Open the saved file with the returned viewCommand.",
		example: "trace stop --file test-results/verify-conduit/demo/trace.zip",
		output: "{file, viewCommand} on stop; {recording:true} on start",
	},
	features: {
		purpose:
			"Check the feature map's selectors, CLI commands and relative links against this checkout.",
		args: ["action"],
		subcommands: ["check"],
		options: {},
		details:
			"Subcommand: check. Static and read-only; needs no running instance. Scans SKILL.md and every features/*.md. Run after any UI, selector or CLI change, and before trusting a recipe. Fix stale entries in the same change. Dynamic selectors are counted as skipped. Exit 1 lists stale entries with file, line and the next action.",
		example: "features check",
		output:
			"{ok, files, checked:{ids,testIds,commands,links}, skipped, stale:[{file,line,kind,value,hint}]}",
	},
	selftest: {
		purpose:
			"Run the CLI's own end-to-end proof across all four replayed harnesses.",
		args: [],
		options: {},
		details:
			"Defaults to run id selftest. Requires a stopped run. Runs features check first, starts with --video, checks flag toggling, HTTP load summary, scrolling, project selection, each harness's reply and stored model, inspection commands and dry-run immutability, then stops and checks non-empty videos and cleanup evidence. Always attempts down after failure.",
		example: "selftest --run selftest",
		output: "{ok, steps:[{name, ok, ms, detail}]}",
	},
};

class CliError extends Error {
	constructor(message, hint, code = 1) {
		super(message);
		this.hint = hint;
		this.code = code;
	}
}
const usageError = (message, command) =>
	new CliError(
		message,
		`run \`${executable} ${command ? `${command} ` : ""}--help\``,
		2,
	);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const alive = (pid) => {
	if (!Number.isSafeInteger(pid) || pid < 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const readText = (file) => (existsSync(file) ? readFileSync(file, "utf8") : "");
// `pnpm build:server` or a bare `vite build` leaves dist/ halves with different
// ids; the page then reloads itself seconds after up and shows a builds banner.
const frontendHasBuild = (buildId) =>
	readdirSync("dist/frontend/assets").some(
		(name) =>
			name.endsWith(".js") &&
			readFileSync(join("dist/frontend/assets", name), "utf8").includes(
				buildId,
			),
	);
const hasMarker = (file, marker) =>
	readText(file)
		.split("\n")
		.some((line) => line.startsWith(marker));

function parse(argv) {
	const options = {};
	const words = [];
	let command;
	let literal = false;
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		if (!literal && token === "--") {
			literal = true;
			continue;
		}
		if (!literal && (token.startsWith("--") || token === "-h")) {
			const [rawName, ...rest] = token.slice(2).split("=");
			const name = token === "-h" ? "help" : rawName;
			const kind = {
				run: "value",
				pretty: "flag",
				help: "flag",
				...commands[command]?.options,
			}[name];
			if (!kind) throw usageError(`unknown option '${token}'`, command);
			if (kind === "flag") {
				if (rest.length)
					throw usageError(`--${name} does not take a value`, command);
				options[name] = true;
			} else {
				const value = rest.length ? rest.join("=") : argv[++index];
				if (
					value === undefined ||
					value === "" ||
					(!rest.length && value.startsWith("--"))
				)
					throw usageError(`--${name} requires a value`, command);
				options[name] = value;
			}
		} else if (!command) command = token;
		else words.push(token);
	}
	if (options.help && (!command || commands[command] || groups[command]))
		return { command, options, words };
	if (!commands[command])
		throw usageError(
			command ? `unknown command '${command}'` : "a command is required",
		);
	const spec = commands[command];
	const minimum = spec.args.filter((arg) => !arg.endsWith("?")).length;
	if (words.length < minimum || words.length > spec.args.length)
		throw usageError(
			`${command} expects ${spec.args.join(" ") || "no arguments"}`,
			command,
		);
	for (const name of spec.required ?? [])
		if (!options[name]) throw usageError(`--${name} is required`, command);
	if (command === "send") {
		const count = [options.harness, options.model, options.provider].filter(
			Boolean,
		).length;
		if (count !== 0 && count !== 3)
			throw usageError(
				"send requires --harness, --model and --provider together",
				command,
			);
	}
	if (command === "feature-flag") {
		if (!["on", "off"].includes(words[1]))
			throw usageError("feature-flag state must be on or off", command);
		const source = readFileSync(
			join(frontendDir, "stores/feature-flags.svelte.ts"),
			"utf8",
		);
		const declaration = source.match(
			/const VALID_FLAGS\b[^=]*=\s*\[([^\]]*)\]/,
		)?.[1];
		const flags = [...(declaration ?? "").matchAll(/["']([^"']+)["']/g)].map(
			(match) => match[1],
		);
		if (!flags.length)
			throw new CliError(
				"cannot read VALID_FLAGS from the frontend source",
				"update feature-flag's source parser to match stores/feature-flags.svelte.ts",
			);
		if (!flags.includes(words[0]))
			throw usageError(
				`unknown feature flag '${words[0]}'; valid flags: ${flags.join(", ")}`,
				command,
			);
	}
	if (command === "scroll") {
		if (options.to !== undefined && options.by !== undefined)
			throw usageError("scroll accepts only one of --to and --by", command);
		if (options.to !== undefined && !["top", "bottom"].includes(options.to))
			throw usageError("--to must be top or bottom", command);
		if (options.by !== undefined) {
			const pixels = Number(options.by);
			if (!Number.isFinite(pixels))
				throw usageError("--by must be a finite number of pixels", command);
			options.by = pixels;
		}
	}
	if (command === "network-log" && options.grep !== undefined) {
		try {
			new RegExp(options.grep);
		} catch {
			throw usageError("--grep must be a valid regular expression", command);
		}
	}
	if (options.button && !["left", "right", "middle"].includes(options.button))
		throw usageError("--button must be left, right or middle", command);
	if (
		options.harness &&
		!["claude", "opencode", "codex", "cursor"].includes(options.harness)
	)
		throw usageError(
			"--harness must be claude, opencode, codex or cursor",
			command,
		);
	const levels =
		command === "console"
			? ["error", "warning", "info"]
			: ["verbose", "info", "warn"];
	if (options.level && !levels.includes(options.level))
		throw usageError(`--level must be ${levels.join(", ")}`, command);
	for (const name of ["timeout", "bytes", "last", "since"]) {
		if (options[name] !== undefined) {
			const value = Number(options[name]);
			if (!Number.isSafeInteger(value) || value < (name === "since" ? 0 : 1))
				throw usageError(
					`--${name} must be ${name === "since" ? "a non-negative" : "a positive"} integer`,
					command,
				);
			options[name] = value;
		}
	}
	if (command === "store") {
		if (!commands.store.subcommands.includes(words[0]))
			throw usageError(
				"store expects sessions, messages, turns or sql",
				command,
			);
		if ((words[0] === "sql") !== (words.length === 2))
			throw usageError(
				"store sql requires one quoted SELECT; other store commands take no SQL argument",
				command,
			);
		if (words[0] === "sql" && !/^\s*select\b/i.test(words[1]))
			throw usageError("store sql accepts SELECT queries only", command);
		if (options.session && !["messages", "turns"].includes(words[0]))
			throw usageError(
				"--session applies to store messages or store turns",
				command,
			);
	}
	if (
		command === "features" &&
		!commands.features.subcommands.includes(words[0])
	)
		throw usageError("features expects check", command);
	if (command === "trace" && !commands.trace.subcommands.includes(words[0]))
		throw usageError("trace expects start or stop", command);
	if (command === "trace" && words[0] === "start" && options.file)
		throw usageError("--file applies to trace stop", command);
	return { command, options, words };
}

function help(command, words) {
	const globals =
		"Global options: --run <id> (RUN_ID env, default default), --pretty, --help. Run from the repo root.\nExit codes: 0 success, 1 command failure, 2 usage error. Commands emit one compact JSON value on stdout.";
	if (commands[command]) {
		const spec = commands[command];
		const sub = spec.subcommands?.includes(words[0]) ? ` ${words[0]}` : "";
		const opts = Object.entries(spec.options)
			.map(([name, kind]) => `--${name}${kind === "value" ? " <value>" : ""}`)
			.join(", ");
		return `${command}${sub}: ${spec.purpose}\n\nUsage: ${executable} ${command} ${spec.args.map((arg) => (arg.endsWith("?") ? `[${arg.slice(0, -1)}]` : `<${arg}>`)).join(" ")}${opts ? " [options]" : ""}\nArguments: ${spec.args.join(", ") || "none"}\nOptions: ${opts || "none"}\n${spec.details ?? ""}\n\nExample: ${executable} ${spec.example}\nOutput: ${spec.output}\n\n${globals}\n`;
	}
	if (groups[command])
		return `${command} commands:\n${groups[command].map((name) => `  ${name.padEnd(15)} ${commands[name].purpose}`).join("\n")}\n\nUse ${executable} <command> --help for arguments, options, example and output.\n${globals}\n`;
	return `Control one isolated conduit server and launcher-owned browser.\n\nUsage: ${executable} <command> [arguments] [options]\n\n${Object.entries(
		groups,
	)
		.map(([name, names]) => `${name}: ${names.join(", ")}`)
		.join(
			"\n",
		)}\n\nUse <group> --help or <command> --help for details.\nStore queries: store sessions|messages|turns|sql --help\nTracing: trace start|stop --help\n\nExample: ${executable} up --run demo\nOutput: JSON; see each command's --help for its result shape.\n\n${globals}\n`;
}

function runContext(id) {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id))
		throw usageError(
			"run id must start with a letter or digit and contain only letters, digits, '.', '_' or '-'",
		);
	if (
		Buffer.byteLength(
			join("test-results", "verify-conduit", id, "control.sock"),
		) > 103
	)
		throw usageError(
			"run id is too long for the Unix control socket; choose a shorter id",
		);
	const runDir = resolve("test-results", "verify-conduit", id);
	return {
		id,
		runDir,
		instanceFile: join(runDir, "instance.json"),
		pidFile: join(runDir, "launcher.pid"),
		logFile: join(runDir, "launcher.log"),
	};
}

function instanceFor(context) {
	if (!existsSync(context.instanceFile))
		throw new CliError(
			`instance not running for run '${context.id}'`,
			`run \`${executable} up --run ${context.id}\``,
		);
	try {
		return readJson(context.instanceFile);
	} catch {
		throw new CliError(
			`cannot read instance.json for run '${context.id}'`,
			`inspect ${context.instanceFile}; then run down and up`,
		);
	}
}

function isolation(instance) {
	const safeRoot =
		typeof instance.root === "string" &&
		/^\/(?:private\/)?tmp\/conduit-verify-[^/]+$/.test(instance.root);
	let safeUrl = false;
	try {
		const url = new URL(instance.baseUrl);
		safeUrl =
			url.protocol === "http:" &&
			["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
			Boolean(url.port) &&
			url.port !== "2633" &&
			!url.username &&
			!url.password;
	} catch {
		/* Report malformed metadata as a failed isolation check. */
	}
	return { safeRoot, safeUrl };
}

function requireIsolation(instance) {
	const { safeRoot, safeUrl } = isolation(instance);
	if (!safeRoot || !safeUrl)
		throw new CliError(
			"refusing an instance outside an isolated /tmp/conduit-verify-* root or on an unsafe URL",
			"inspect instance.json; never use the live server on port 2633",
		);
}

async function control(context, op, args = {}) {
	const instance = instanceFor(context);
	requireIsolation(instance);
	if (
		!alive(instance.launcherPid) ||
		!instance.controlSocket ||
		!existsSync(instance.controlSocket)
	)
		throw new CliError(
			`instance not running for run '${context.id}'`,
			`run \`${executable} up --run ${context.id}\``,
		);
	return new Promise((resolveResult, reject) => {
		const body = JSON.stringify({ op, args });
		const req = request(
			{
				socketPath: instance.controlSocket,
				method: "POST",
				path: "/",
				headers: {
					"content-type": "application/json",
					"content-length": Buffer.byteLength(body),
				},
			},
			(res) => {
				const chunks = [];
				let size = 0;
				res.on("data", (chunk) => {
					size += chunk.length;
					if (size > 16 * 1024 * 1024)
						req.destroy(new Error("control response exceeds 16 MB"));
					else chunks.push(chunk);
				});
				res.on("end", () => {
					try {
						const response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
						if (!response.ok)
							reject(
								new CliError(
									response.error ?? "control command failed",
									response.hint ??
										`run \`${executable} snapshot --run ${context.id}\``,
								),
							);
						else resolveResult(response.result ?? null);
					} catch (error) {
						reject(
							new CliError(
								`invalid control response: ${error.message}`,
								`inspect ${context.logFile}`,
							),
						);
					}
				});
				res.on("error", reject);
			},
		);
		req.setTimeout(Math.max(120000, (args.timeout ?? 0) + 10000), () =>
			req.destroy(new Error("control request timed out")),
		);
		req.on("error", (error) =>
			reject(
				new CliError(
					`control socket failed: ${error.message}`,
					`run \`${executable} doctor --run ${context.id}\`; inspect ${context.logFile}`,
				),
			),
		);
		req.end(body);
	});
}

const launcherSummary = (instance) => ({
	baseUrl: instance.baseUrl,
	runDir: instance.runDir,
	controlSocket: instance.controlSocket,
	cdpUrl: instance.cdpUrl,
});

async function up(context, options) {
	const prior = existsSync(context.instanceFile)
		? instanceFor(context)
		: undefined;
	const priorPid =
		Number(readText(context.pidFile).trim()) || prior?.launcherPid;
	if (alive(priorPid)) {
		const instance = instanceFor(context);
		requireIsolation(instance);
		if (instance.launcherPid !== priorPid)
			throw new CliError(
				"launcher.pid disagrees with instance.json",
				"inspect the run evidence before starting another instance",
			);
		await control(context, "info");
		return { ...launcherSummary(instance), alreadyRunning: true };
	}
	if (
		!existsSync("dist/src/bin/cli.js") ||
		!existsSync("dist/frontend/index.html")
	)
		throw new CliError(
			"no dist/; run `pnpm build`",
			"run `pnpm build` from the repo root, then retry up",
		);
	const { BUILD_ID } = await import(
		pathToFileURL(resolve("dist/src/lib/build-id.js")).href
	);
	if (!frontendHasBuild(BUILD_ID))
		throw new CliError(
			`dist/frontend was not built with server build ${BUILD_ID}`,
			"run a full `pnpm build` (not build:server or build:frontend alone), then retry up",
		);
	mkdirSync(context.runDir, { recursive: true });
	if (existsSync(context.instanceFile)) unlinkSync(context.instanceFile);
	const env = { ...process.env };
	for (const [flag, name] of [
		["claude-turns", "CLAUDE_TURNS"],
		["claude-delay-ms", "CLAUDE_DELAY_MS"],
		["opencode-recording", "OPENCODE_RECORDING"],
		["codex-turn", "CODEX_TURN"],
		["cursor-trace", "CURSOR_TRACE"],
	])
		if (options[flag]) env[name] = options[flag];
	if (options["no-seed-accounts"]) env.SEED_ACCOUNTS = "0";
	if (options.phone) env.VIEWPORT = "phone";
	if (options.headed) env.HEADED = "1";
	if (options.video) env.VIDEO = "1";
	const logFd = openSync(context.logFile, "w");
	let child;
	try {
		child = spawn(
			process.execPath,
			["--import", "tsx", launchPath, context.runDir],
			{ detached: true, stdio: ["ignore", logFd, logFd], env },
		);
	} finally {
		closeSync(logFd);
	}
	await new Promise((done, reject) => {
		child.once("spawn", done);
		child.once("error", reject);
	});
	writeFileSync(context.pidFile, `${child.pid}\n`);
	child.unref();
	const deadline = Date.now() + 120000;
	while (Date.now() < deadline) {
		if (hasMarker(context.logFile, "READY ")) {
			const instance = instanceFor(context);
			requireIsolation(instance);
			await control(context, "info");
			return launcherSummary(instance);
		}
		if (!alive(child.pid)) break;
		await delay(100);
	}
	// This pid was created by this up invocation, so it is safe to signal even
	// when startup failed before instance.json could be written.
	if (alive(child.pid)) {
		try {
			process.kill(child.pid, "SIGTERM");
		} catch (error) {
			if (error.code !== "ESRCH") throw error;
		}
		const cleanupDeadline = Date.now() + 10000;
		while (alive(child.pid) && Date.now() < cleanupDeadline) await delay(100);
	}
	const lines = stripVTControlCharacters(readText(context.logFile)).split("\n");
	const reason = (
		lines.find((line) => /FATAL|Permission denied/.test(line)) ??
		lines.find((line) => /Error:|ERROR:/.test(line)) ??
		lines.filter(Boolean).at(-1) ??
		"no launcher output"
	)
		.trim()
		.slice(0, 500);
	const install = /ffmpeg/.test(reason)
		? "`pnpm exec playwright install ffmpeg` (needed by --video), then "
		: "";
	throw new CliError(
		`launcher did not become READY: ${reason}`,
		`${install}inspect ${context.logFile}; run \`${executable} down --run ${context.id}\``,
	);
}

async function doctor(context) {
	const checks = [];
	const check = (name, ok, detail) =>
		checks.push({ name, ok: Boolean(ok), detail: String(detail) });
	let instance;
	try {
		instance = instanceFor(context);
	} catch (error) {
		check("instance", false, error.message);
		return { healthy: false, checks };
	}
	check("launcher", alive(instance.launcherPid), `pid ${instance.launcherPid}`);
	const { safeRoot, safeUrl } = isolation(instance);
	check("isolatedRoot", safeRoot, instance.root);
	check(
		"safePort",
		safeUrl,
		safeUrl
			? instance.baseUrl
			: "refusing URL: must be loopback HTTP on an explicit port other than 2633",
	);
	// Guard before making any HTTP request, including /health and /info.
	if (safeRoot && safeUrl) {
		for (const endpoint of ["health", "info"]) {
			try {
				const response = await fetch(
					new URL(`/${endpoint}`, instance.baseUrl),
					{ signal: AbortSignal.timeout(5000), redirect: "error" },
				);
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const body = await response.json();
				if (endpoint === "health")
					check(
						"health",
						body.ok !== false && body.healthy !== false,
						JSON.stringify(body),
					);
				else {
					const buildFile = resolve("dist/src/lib/build-id.js");
					if (!existsSync(buildFile))
						throw new Error("no dist/; run `pnpm build`");
					const { BUILD_ID } = await import(pathToFileURL(buildFile).href);
					check(
						"buildId",
						body.buildId === BUILD_ID,
						body.buildId === BUILD_ID
							? BUILD_ID
							: `buildId mismatch: served ${body.buildId}, dist ${BUILD_ID}; run down then up`,
					);
					const bundled = frontendHasBuild(body.buildId);
					check(
						"frontendBuildId",
						bundled,
						bundled
							? body.buildId
							: `dist/frontend lacks served build ${body.buildId}; the page will reload with a builds banner. Run a full pnpm build, then down and up`,
					);
				}
			} catch (error) {
				for (const name of endpoint === "info"
					? ["buildId", "frontendBuildId"]
					: ["health"])
					check(name, false, error.message);
			}
		}
		try {
			const state = await control(context, "info");
			check("controlSocket", true, instance.controlSocket);
			check(
				"pageAttached",
				state.pageAttached,
				state.pageUrl ?? "no attached page",
			);
		} catch (error) {
			check("controlSocket", false, error.message);
			check("pageAttached", false, "control socket unavailable");
		}
	} else {
		for (const name of [
			"health",
			"buildId",
			"frontendBuildId",
			"controlSocket",
			"pageAttached",
		])
			check(name, false, "skipped because instance isolation is invalid");
	}
	return { healthy: checks.every(({ ok }) => ok), checks };
}

function ownedLauncher(pid, context) {
	const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
		encoding: "utf8",
		maxBuffer: 64 * 1024,
	});
	// Exact suffix: run `demo`'s dir is a prefix of run `demo2`'s, so substring checks would match a reused pid.
	return (
		result.status === 0 &&
		result.stdout.trim().endsWith(`${launchPath} ${context.runDir}`)
	);
}

async function down(context, options) {
	const instance = existsSync(context.instanceFile) ? instanceFor(context) : {};
	const pid = Number(readText(context.pidFile).trim()) || instance.launcherPid;
	if (options["dry-run"])
		return {
			stopped: false,
			dryRun: true,
			launcherPid: pid ?? null,
			serverPid: instance.serverPid ?? null,
			browserPid: instance.browserPid ?? null,
			root: instance.root ?? null,
			socket: instance.controlSocket ?? join(context.runDir, "control.sock"),
			evidenceDir: context.runDir,
		};
	const videos = () => {
		const file = join(context.runDir, "videos.json");
		return existsSync(file) ? readJson(file) : [];
	};
	if (!pid)
		return { stopped: false, evidenceDir: context.runDir, videos: videos() };
	if (alive(pid)) {
		if (!ownedLauncher(pid, context))
			throw new CliError(
				`refusing to signal pid ${pid}: its command does not identify this run's launcher`,
				`inspect ${context.pidFile} and ${context.logFile}; stop only pids this run started`,
			);
		process.kill(pid, "SIGTERM");
	}
	const deadline = Date.now() + 60000;
	while (Date.now() < deadline) {
		if (!alive(pid)) {
			if (hasMarker(context.logFile, "STOPPED_DIRTY"))
				throw new CliError(
					`launcher ${pid} stopped but teardown failed`,
					`read the teardown error in ${context.logFile} and harness-proof.json; remove the root it names only if the proof shows it was not disposed`,
				);
			if (!hasMarker(context.logFile, "STOPPED"))
				throw new CliError(
					`launcher ${pid} exited without STOPPED`,
					`inspect ${context.logFile} and harness-proof.json before reusing the run`,
				);
			if (existsSync(context.pidFile)) unlinkSync(context.pidFile);
			return { stopped: true, evidenceDir: context.runDir, videos: videos() };
		}
		await delay(100);
	}
	throw new CliError(
		`launcher ${pid} did not exit and confirm STOPPED within 60 seconds`,
		`inspect ${context.logFile}; only signal this run's recorded pid`,
	);
}

function operationArgs(command, words, options) {
	const args = { ...options };
	for (const name of ["run", "pretty", "help"]) delete args[name];
	for (const [index, name] of commands[command].args.entries())
		if (words[index] !== undefined)
			args[name.replace(/\?$/, "")] = words[index];
	if (command === "send" && args["no-wait"]) {
		args.noWait = true;
		delete args["no-wait"];
	}
	if (args.file) args.file = resolve(args.file);
	return args;
}

async function dispatch(command, words, options, context) {
	if (command === "features")
		return checkFeatures(resolve(scriptDir, ".."), frontendDir, commands);
	if (command === "up") return up(context, options);
	if (command === "doctor") return doctor(context);
	if (command === "down") return down(context, options);
	if (command === "selftest") return selftest(context);
	if (command === "info") {
		const instance = instanceFor(context);
		const state = await control(context, "info");
		return {
			...instance,
			...state,
			playwrightAttach: `playwright-cli -s=verify-${context.id} attach --cdp=${instance.cdpUrl}`,
		};
	}
	return control(context, command, operationArgs(command, words, options));
}

function assert(condition, detail) {
	if (!condition) throw new Error(detail);
}

async function selftest(context) {
	const steps = [];
	let instance;
	let started = false;
	const step = async (name, action) => {
		const start = performance.now();
		try {
			const detail = await action();
			steps.push({
				name,
				ok: true,
				ms: Math.round(performance.now() - start),
				detail: detail ?? "ok",
			});
			return detail;
		} catch (error) {
			steps.push({
				name,
				ok: false,
				ms: Math.round(performance.now() - start),
				detail: error.message,
			});
			throw error;
		}
	};
	// Invoke the actual executable, including argument parsing, exit codes and
	// JSON decoding, rather than testing only this process's internal functions.
	const call = (command, words = [], options = {}) =>
		new Promise((done, reject) => {
			const args = [
				fileURLToPath(import.meta.url),
				command,
				...words,
				"--run",
				context.id,
			];
			for (const [name, value] of Object.entries(options)) {
				args.push(`--${name}`);
				if (value !== true) args.push(String(value));
			}
			const child = spawn(process.execPath, args, {
				stdio: ["ignore", "pipe", "pipe"],
			});
			const chunks = [];
			const errors = [];
			let bytes = 0;
			child.stdout.on("data", (chunk) => {
				bytes += chunk.length;
				if (bytes > 16 * 1024 * 1024) child.kill("SIGTERM");
				else chunks.push(chunk);
			});
			child.stderr.on("data", (chunk) => {
				if (Buffer.concat(errors).length < 4000)
					errors.push(chunk.subarray(0, 4000));
			});
			child.on("error", reject);
			child.on("close", (code) => {
				try {
					const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					if (code !== 0)
						reject(new Error(result.error ?? JSON.stringify(result)));
					else done(result);
				} catch (error) {
					reject(
						new Error(
							`${command}: ${error.message}; ${Buffer.concat(errors).toString("utf8").slice(-4000)}`,
						),
					);
				}
			});
		});
	try {
		await step("features:check", async () => {
			const result = await call("features", ["check"]);
			assert(
				result.ok && result.stale.length === 0,
				"feature map has stale entries",
			);
			return result;
		});
		await step("up", async () => {
			const pid = Number(readText(context.pidFile).trim());
			assert(
				!alive(pid),
				`run '${context.id}' is already running; choose a fresh selftest run id`,
			);
			started = true;
			const result = await call("up", [], { video: true });
			instance = instanceFor(context);
			assert(
				result.baseUrl && result.controlSocket && result.cdpUrl,
				"up omitted connection metadata",
			);
			return result;
		});
		await step("doctor", async () => {
			const result = await call("doctor");
			assert(result.healthy, JSON.stringify(result));
			return result;
		});
		await step("network-log:load", async () => {
			const result = await call("network-log", [], { summary: true });
			assert(
				result.total > 0 &&
					Object.keys(result.byStatus).length > 0 &&
					Object.keys(result.byMethodPath).length > 0,
				"HTTP load summary is empty",
			);
			assert(
				Array.isArray(result.failures) && result.failures.length === 0,
				`HTTP load failures: ${JSON.stringify(result.failures)}`,
			);
			return result;
		});
		for (const state of ["on", "off"]) {
			await step(`feature-flag:debug:${state}`, async () => {
				const before = await call("info");
				assert(before.video === true, "info did not report video recording");
				const result = await call("feature-flag", ["debug", state]);
				assert(
					Array.isArray(result.flags) &&
						result.flags.includes("debug") === (state === "on"),
					`debug flag did not turn ${state}`,
				);
				const after = await call("info");
				assert(
					new URL(before.pageUrl).pathname === new URL(after.pageUrl).pathname,
					"feature-flag changed the current path",
				);
				return result;
			});
		}
		await step("scroll", async () => {
			const list = await call("scroll", ["#session-list-scroller"]);
			// Fixed overflow makes wheel movement independent of the seeded session list.
			try {
				const initial = await call("eval", [
					`() => {
					const fixture = document.createElement("div");
					fixture.id = "conduit-verify-scroll-fixture";
					fixture.style.cssText = "position:fixed;top:16px;left:16px;width:200px;height:200px;overflow:auto;z-index:2147483647;scroll-behavior:auto;overscroll-behavior:contain";
					const content = document.createElement("div");
					content.style.height = "2000px";
					fixture.append(content);
					document.body.append(fixture);
					return { scrollTop: fixture.scrollTop, scrollHeight: fixture.scrollHeight, clientHeight: fixture.clientHeight };
				}`,
				]);
				assert(
					initial.clientHeight > 0 &&
						initial.scrollHeight > initial.clientHeight,
					"scroll fixture does not overflow",
				);
				const selector = "#conduit-verify-scroll-fixture";
				const bottom = await call("scroll", [selector], { to: "bottom" });
				assert(
					bottom.scrollTop > 0 &&
						Math.abs(
							bottom.scrollHeight - bottom.clientHeight - bottom.scrollTop,
						) <= 1,
					"scroll --to bottom did not reach the bottom",
				);
				const wheel = await call("scroll", [selector], { by: -100 });
				assert(
					wheel.scrollTop < bottom.scrollTop,
					"scroll --by -100 did not move up",
				);
				const top = await call("scroll", [selector], { to: "top" });
				assert(top.scrollTop === 0, "scroll --to top did not reach the top");
				const visible = await call("scroll", [selector]);
				return { list, initial, bottom, wheel, top, visible };
			} finally {
				await call("eval", [
					'() => { document.getElementById("conduit-verify-scroll-fixture")?.remove(); return { removed: true }; }',
				]);
			}
		});
		await step("select-project", async () => {
			const before = await call("info");
			const result = await call("select-project", ["process-test"]);
			const url = new URL(result.path, instance.baseUrl);
			assert(
				result.slug === "process-test" &&
					url.searchParams.get("p") === "process-test",
				"project scope did not change",
			);
			assert(
				url.pathname === new URL(before.pageUrl).pathname,
				"project selection changed the current path",
			);
			return result;
		});
		for (const [harness, model, provider, expected] of [
			["claude", "opus", "claude", "pong"],
			["opencode", "claude-opus-4-6", "anthropic", "pong"],
			["codex", "gpt-6.1-sol", "codex", "Hello from the mock model."],
			[
				"cursor",
				"composer-2.5",
				"cursor",
				"Hi David — good to meet you. What would you like to work on today?",
			],
		]) {
			await step(`chat:${harness}`, async () => {
				await call("new-session");
				const result = await call(
					"send",
					["Hello, reply with just the word pong"],
					{ harness, model, provider, timeout: 60000 },
				);
				assert(
					result.reply?.trim() === expected,
					`expected reply ${JSON.stringify(expected)}, got ${JSON.stringify(result.reply)}`,
				);
				assert(result.sessionId, "send returned no session id");
				const sessions = await call("store", ["sessions"]);
				const row = sessions.find(({ id }) => id === result.sessionId);
				assert(
					row?.model_provider === provider && row?.model_id === model,
					`stored model mismatch: ${JSON.stringify(row)}`,
				);
				const messages = await call("store", ["messages"], {
					session: result.sessionId,
				});
				assert(
					messages.some(
						(message) =>
							message.role === "assistant" && message.text?.trim() === expected,
					),
					"store has no matching assistant reply",
				);
				return {
					sessionId: result.sessionId,
					reply: result.reply,
					model_provider: row.model_provider,
					model_id: row.model_id,
				};
			});
		}
		await step("console", async () => {
			const result = await call("console");
			assert(
				Array.isArray(result) &&
					result.every(
						(entry) =>
							typeof entry.level === "string" &&
							typeof entry.text === "string" &&
							typeof entry.time === "number",
					),
				"console did not return structured messages",
			);
			return { messages: result.length };
		});
		await step("ws-log", async () => {
			const result = await call("ws-log", [], { last: 10 });
			assert(
				Array.isArray(result) &&
					result.length > 0 &&
					result.every((entry) => "event" in entry && "time" in entry),
				"WebSocket event buffer is empty or malformed",
			);
			return { events: result.length };
		});
		await step("logs", async () => {
			const result = await call("logs", [], { bytes: 8000 });
			assert(
				Array.isArray(result) &&
					result.some((line) => typeof line === "string" && line.length > 0),
				"server log has no lines",
			);
			return { lines: result.length };
		});
		await step("snapshot", async () => {
			const file = join(context.runDir, "selftest.aria.yml");
			await call("snapshot", [], { file });
			assert(
				existsSync(file) && statSync(file).size > 20,
				"ARIA snapshot missing or empty",
			);
			return { file, bytes: statSync(file).size };
		});
		await step("screenshot", async () => {
			const result = await call("screenshot");
			assert(
				result.file &&
					existsSync(result.file) &&
					statSync(result.file).size > 100,
				"screenshot missing or empty",
			);
			assert(
				readFileSync(result.file)
					.subarray(0, 8)
					.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
				"screenshot is not a PNG",
			);
			return result;
		});
		await step("perf-metrics", async () => {
			const result = await call("perf-metrics");
			assert(
				typeof result === "object" &&
					Object.keys(result).length > 0 &&
					Object.values(result).every((value) => typeof value === "number"),
				"performance metrics missing or invalid",
			);
			return { metrics: Object.keys(result).length };
		});
		await step("down:dry-run", async () => {
			await call("wait-settle");
			// Live logs and SQLite can change independently. Compare the stable
			// launcher metadata and resource identity, then check both pids/page.
			const before = {
				instance: readText(context.instanceFile),
				pid: readText(context.pidFile),
				rootInode: statSync(instance.root).ino,
				socketInode: statSync(instance.controlSocket).ino,
			};
			const pageBefore = await call("info");
			const result = await call("down", [], { "dry-run": true });
			assert(
				result.dryRun &&
					result.launcherPid === instance.launcherPid &&
					result.serverPid === instance.serverPid &&
					result.root === instance.root &&
					result.socket === instance.controlSocket,
				"dry-run omitted stop plan metadata",
			);
			assert(
				alive(instance.launcherPid) &&
					alive(instance.serverPid) &&
					existsSync(instance.root) &&
					existsSync(instance.controlSocket),
				"dry-run stopped or deleted instance resources",
			);
			assert(
				readText(context.instanceFile) === before.instance &&
					readText(context.pidFile) === before.pid &&
					statSync(instance.root).ino === before.rootInode &&
					statSync(instance.controlSocket).ino === before.socketInode,
				"dry-run changed launcher metadata or replaced root/socket resources",
			);
			const pageAfter = await call("info");
			assert(
				pageAfter.pageAttached && pageBefore.pageUrl === pageAfter.pageUrl,
				"dry-run changed or detached the page",
			);
			return result;
		});
	} catch {
		/* Each failure is already recorded; cleanup must still run. */
	} finally {
		if (started) {
			try {
				await step("down", async () => {
					const result = await call("down");
					assert(
						Array.isArray(result.videos) && result.videos.length > 0,
						"down returned no recorded videos",
					);
					for (const file of result.videos)
						assert(
							resolve(file) === file &&
								file.endsWith(".webm") &&
								existsSync(file) &&
								statSync(file).size > 0,
							`video is missing, empty or not an absolute .webm path: ${file}`,
						);
					return result;
				});
			} catch {
				/* Report cleanup failure in steps. */
			}
			try {
				await step("cleanup-evidence", () => {
					for (const file of ["server.log", "daemon.log", "harness-proof.json"])
						assert(existsSync(join(context.runDir, file)), `missing ${file}`);
					const proof = readJson(join(context.runDir, "harness-proof.json"));
					assert(proof.disposed === true, "harness proof is not disposed");
					const remaining = [];
					const visit = (value, name = "") => {
						if (!value || typeof value !== "object") return;
						for (const [key, child] of Object.entries(value)) {
							if (/remaining.*pids/i.test(key) && Array.isArray(child))
								remaining.push(...child);
							else visit(child, `${name}.${key}`);
						}
					};
					visit(proof);
					remaining.push(
						...[
							instance?.launcherPid,
							instance?.serverPid,
							instance?.browserPid,
							...(proof.generations ?? []).map(({ pid }) => pid),
						].filter(alive),
					);
					assert(
						remaining.length === 0,
						`recorded processes are still alive: ${remaining.join(", ")}`,
					);
					const root = instance?.root ?? proof.root;
					assert(
						typeof root === "string" && !existsSync(root),
						`temporary root still exists: ${root ?? "missing root in instance and proof"}`,
					);
					return {
						evidenceDir: context.runDir,
						rootGone: true,
						remainingPids: remaining,
					};
				});
			} catch {
				/* Report cleanup evidence failure in steps. */
			}
		}
	}
	return { ok: steps.length > 0 && steps.every((entry) => entry.ok), steps };
}

try {
	const { command, options, words } = parse(process.argv.slice(2));
	if (options.help) process.stdout.write(help(command, words));
	else {
		const context =
			command === "features"
				? undefined
				: runContext(
						options.run ??
							process.env.RUN_ID ??
							(command === "selftest" ? "selftest" : "default"),
					);
		const result = await dispatch(command, words, options, context);
		process.stdout.write(
			`${JSON.stringify(result, null, options.pretty ? 2 : undefined)}\n`,
		);
		if (
			(command === "doctor" && !result.healthy) ||
			(command === "features" && !result.ok) ||
			(command === "selftest" && !result.ok)
		)
			process.exitCode = 1;
	}
} catch (error) {
	process.stdout.write(
		`${JSON.stringify({ ok: false, error: error.message ?? String(error), hint: error.hint ?? "inspect the run's launcher.log and retry" })}\n`,
	);
	process.exitCode = error.code === 2 ? 2 : 1;
}
