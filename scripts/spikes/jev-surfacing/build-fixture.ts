/**
 * SPIKE for conduit-test-ahu8.1: build the labelled fixture for the Jev surfacing eval.
 * Run: node --import tsx scripts/spikes/jev-surfacing/build-fixture.ts
 *
 * 1. Samples mid-turn assistant text parts (a text part that a tool call follows in
 *    the same turn) from conduit's events.db files (Claude) and OpenCode's own
 *    opencode.db (conduit's stores hold almost no OpenCode turns). Read-only.
 * 2. Two models label each part independently with the same prompt, blind to Jev:
 *    opus (claude -p) and gpt-6.1-sol (codex exec).
 * 3. Keeps parts both agree on; samples and labels more until TARGET_AGREED.
 * Work files (unagreed parts, raw labels) stay in JEV_EVAL_WORK; only the agreed,
 * scrubbed set is written to the fixture.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, openSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
	criteriaMap,
	type Fixture,
	type FixturePart,
	instructions,
	LABELS,
	type Label,
} from "./rubric.js";

const work = process.env["JEV_EVAL_WORK"] ?? "/tmp/jev-surfacing-eval";
const fixturePath = resolve("test/fixtures/jev-surfacing/labelled-parts.json");
const initialSample = Number(process.env["INITIAL_SAMPLE"] ?? 150);
const step = Number(process.env["SAMPLE_STEP"] ?? 50);
const targetAgreed = Number(process.env["TARGET_AGREED"] ?? 100);
const batchSize = 25;
const opencodeShare = 0.4;
const perSessionCap = 2;

type Sampled = Omit<FixturePart, "label"> & { session: string };
type Labels = Record<string, { opus?: Label | null; sol?: Label | null }>;

const run = promisify(execFile);
const sqlite = async <T>(db: string, sql: string): Promise<T[]> => {
	const { stdout } = await run("sqlite3", ["-readonly", "-json", db, sql], {
		maxBuffer: 1 << 30,
	});
	return stdout.trim() ? (JSON.parse(stdout) as T[]) : [];
};
const quote = (ids: readonly string[]) =>
	ids.map((id) => `'${id.replaceAll("'", "''")}'`).join(",");

// --- sampling ---------------------------------------------------------------

type Candidate = { sid: string; pid: string; user_id: string };

const claudeCandidatesSql = `
WITH ev AS (
  SELECT m.session_id sid, m.created_at mc, coalesce(p.created_at, m.created_at) pc, coalesce(p.sort_order, 0) so,
         m.role role, coalesce(p.type, 'user') ptype, coalesce(p.id, m.id) pid
  FROM messages m JOIN sessions s ON s.id = m.session_id AND s.parent_id IS NULL
  LEFT JOIN message_parts p ON p.message_id = m.id AND m.role = 'assistant' AND p.type IN ('text', 'tool')
  WHERE m.role = 'user' OR p.id IS NOT NULL
), o1 AS (
  SELECT *, SUM(role = 'user') OVER w turn_no, ROW_NUMBER() OVER w rn
  FROM ev WINDOW w AS (PARTITION BY sid ORDER BY mc, pc, so, pid ROWS UNBOUNDED PRECEDING)
), o2 AS (
  SELECT *, MAX(CASE WHEN ptype = 'tool' THEN rn END) OVER (PARTITION BY sid, turn_no) last_tool,
            MIN(CASE WHEN ptype = 'user' THEN pid END) OVER (PARTITION BY sid, turn_no) user_id
  FROM o1
)
SELECT sid, pid, user_id FROM o2 WHERE ptype = 'text' AND turn_no > 0 AND rn < last_tool`;

const opencodeCandidatesSql = `
WITH ss AS (SELECT id FROM session WHERE parent_id IS NULL AND tokens_output > 2000),
ev AS (
  SELECT m.session_id sid, m.time_created mc, p.time_created pc, p.id pid,
         json_extract(m.data, '$.role') role, json_extract(p.data, '$.type') ptype
  FROM message m JOIN ss ON ss.id = m.session_id JOIN part p ON p.message_id = m.id
  WHERE json_extract(p.data, '$.type') IN ('text', 'tool') AND coalesce(json_extract(p.data, '$.synthetic'), 0) = 0
), ev2 AS (
  SELECT sid, mc, pc, pid, role, CASE WHEN role = 'user' THEN 'user' ELSE ptype END ptype FROM ev
  WHERE role = 'assistant' OR pid IN (SELECT min(pid) FROM ev e2 WHERE e2.role = 'user' GROUP BY e2.sid, e2.mc)
), o1 AS (
  SELECT *, SUM(role = 'user') OVER w turn_no, ROW_NUMBER() OVER w rn
  FROM ev2 WINDOW w AS (PARTITION BY sid ORDER BY mc, pc, pid ROWS UNBOUNDED PRECEDING)
), o2 AS (
  SELECT *, MAX(CASE WHEN ptype = 'tool' THEN rn END) OVER (PARTITION BY sid, turn_no) last_tool,
            MIN(CASE WHEN ptype = 'user' THEN pid END) OVER (PARTITION BY sid, turn_no) user_id
  FROM o1
)
SELECT sid, pid, user_id FROM o2 WHERE ptype = 'text' AND turn_no > 0 AND rn < last_tool`;

const conduitDbs = () => {
	const root = join(homedir(), ".config/conduit/projects");
	return readdirSync(root)
		.map((slug) => join(root, slug, "events.db"))
		.filter(existsSync);
};
const opencodeDb = join(homedir(), ".local/share/opencode/opencode.db");

/** Deterministic shuffle (mulberry32) so a rerun samples the same parts. */
const shuffle = <T>(items: T[], seed: number): T[] => {
	let a = seed;
	const rand = () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j] as T, out[i] as T];
	}
	return out;
};

const scrub = (text: string) =>
	text
		.replace(/\/(?:Users|home)\/[^/\s"'`]+/g, "~")
		.replace(/\/(?:private\/)?var\/folders\/[^\s"'`]+/g, "<tmpdir>")
		.replace(/\b(?:dibstern|dstern)\b/gi, "user")
		.replace(/\b[\w-]+\.[\w-]+\.ts\.net\b/g, "<host>")
		.replace(/\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "<host>")
		.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
		.replace(
			/\b(?:sk-[\w-]{16,}|gh[pousr]_\w{20,}|xox[abpr]-[\w-]{10,}|AKIA[0-9A-Z]{16}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]+)/g,
			"<secret>",
		)
		.replace(/\b(Bearer\s+)[\w.~+/-]{12,}=*/g, "$1<secret>")
		.replace(
			/\b((?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?)[^\s"']{8,}/gi,
			"$1<secret>",
		);

/** Decision 4's truncation: request first 1,000 chars; message first 2,000 + last 500. */
const truncateMessage = (text: string) =>
	text.length <= 2500 ? text : `${text.slice(0, 2000)}\n…\n${text.slice(-500)}`;

const shortId = (raw: string) =>
	createHash("sha256").update(raw).digest("hex").slice(0, 12);

const capPerSession = <T extends Candidate>(candidates: T[]) => {
	const taken = new Map<string, number>();
	return candidates.filter((c) => {
		const n = taken.get(c.sid) ?? 0;
		taken.set(c.sid, n + 1);
		return n < perSessionCap;
	});
};

async function loadCandidates() {
	const claude: Array<Candidate & { db: string }> = [];
	for (const db of conduitDbs())
		for (const c of await sqlite<Candidate>(db, claudeCandidatesSql))
			claude.push({ ...c, db });
	const opencode = (
		await sqlite<Candidate>(opencodeDb, opencodeCandidatesSql)
	).map((c) => ({ ...c, db: opencodeDb }));
	return {
		claude: capPerSession(shuffle(claude, 1)),
		opencode: capPerSession(shuffle(opencode, 2)),
	};
}

async function fetchClaude(c: Candidate & { db: string }) {
	const [part] = await sqlite<{ text: string }>(
		c.db,
		`SELECT text FROM message_parts WHERE id IN (${quote([c.pid])})`,
	);
	const [req] = await sqlite<{ text: string | null }>(
		c.db,
		`SELECT coalesce(nullif(m.text, ''), (SELECT group_concat(text, char(10)) FROM message_parts WHERE message_id = m.id AND type = 'text')) text
		 FROM messages m WHERE id IN (${quote([c.user_id])})`,
	);
	return { message: part?.text ?? "", request: req?.text ?? "" };
}

async function fetchOpencode(c: Candidate) {
	const rows = await sqlite<{ id: string; text: string | null }>(
		opencodeDb,
		`SELECT id, json_extract(data, '$.text') text FROM part WHERE id IN (${quote([c.pid, c.user_id])})`,
	);
	const text = (id: string) => rows.find((r) => r.id === id)?.text ?? "";
	return { message: text(c.pid), request: text(c.user_id) };
}

/** Takes the next `count` unsampled candidates (40% OpenCode) and resolves their text. */
async function sampleMore(
	candidates: Awaited<ReturnType<typeof loadCandidates>>,
	existing: Sampled[],
	count: number,
): Promise<Sampled[]> {
	const seen = new Set(existing.map((p) => p.id));
	const out: Sampled[] = [];
	const want = {
		opencode: Math.round(count * opencodeShare),
		claude: count - Math.round(count * opencodeShare),
	};
	for (const provider of ["claude", "opencode"] as const) {
		let got = 0;
		for (const c of candidates[provider]) {
			if (got >= want[provider]) break;
			const id = shortId(c.pid);
			if (seen.has(id)) continue;
			seen.add(id);
			const raw =
				provider === "claude" ? await fetchClaude(c) : await fetchOpencode(c);
			if (raw.message.trim().length === 0) continue;
			out.push({
				id,
				provider,
				session: shortId(c.sid),
				request: scrub(raw.request.trim().slice(0, 1000)),
				message: scrub(truncateMessage(raw.message.trim())),
			});
			got++;
		}
	}
	return out;
}

// --- labelling --------------------------------------------------------------

const labelPrompt = (parts: Sampled[]) => {
	const items = parts.map((p) => ({
		id: p.id,
		request: p.request,
		message: p.message,
	}));
	return `You are labelling data for an evaluation. Work only from the text below; do not use tools or read files.

Each item is a \`message\` an AI coding agent wrote to the user partway through a turn, between tool calls (it is not the agent's final reply). \`request\` is the user's prompt for that turn, truncated to 1,000 characters. Messages over 2,500 characters show the first 2,000 and last 500.

For each item, answer this question by choosing exactly one category id:
${JSON.stringify(instructions(true), null, 2)}

Categories (id: definition):
${JSON.stringify(criteriaMap(), null, 2)}

Items:
${JSON.stringify(items, null, 2)}

Return only a JSON object that maps every item id to one category id from: ${LABELS.join(", ")}. Example: {"${items[0]?.id ?? "abc"}": "routine"}. No prose, no code fence.`;
};

const runProcess = (
	cmd: string,
	args: string[],
	stdinFile: string | null,
	timeoutMs: number,
) =>
	new Promise<string>((done, fail) => {
		const child = spawn(cmd, args, {
			cwd: join(work, "label-cwd"),
			stdio: [stdinFile ? openSync(stdinFile, "r") : "ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		child.stdout?.on("data", (d: Buffer) => {
			out += d;
		});
		child.stderr?.on("data", (d: Buffer) => {
			err += d;
		});
		const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) done(out);
			else fail(new Error(`${cmd} exited ${code}: ${err.slice(-500)}`));
		});
	});

const parseLabels = (raw: string): Record<string, Label | null> => {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end < start) return {};
	const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<
		string,
		unknown
	>;
	return Object.fromEntries(
		Object.entries(parsed).map(([id, v]) => [
			id,
			typeof v === "string" && (LABELS as readonly string[]).includes(v)
				? (v as Label)
				: null,
		]),
	);
};

async function labelWithOpus(batch: Sampled[], tag: string) {
	const prompt = labelPrompt(batch);
	await writeFile(join(work, `prompt-${tag}.txt`), prompt);
	const out = await runProcess(
		"claude",
		[
			"-p",
			"--model",
			"opus",
			"--tools",
			"",
			"--output-format",
			"json",
			"--no-session-persistence",
			prompt,
		],
		null,
		15 * 60_000,
	);
	const result = JSON.parse(out) as { result?: string };
	return parseLabels(result.result ?? "");
}

async function labelWithSol(batch: Sampled[], tag: string) {
	const promptFile = join(work, `prompt-${tag}.txt`);
	await writeFile(promptFile, labelPrompt(batch));
	const outFile = join(work, `sol-${tag}.txt`);
	await runProcess(
		"codex",
		[
			"exec",
			"-m",
			"gpt-6.1-sol",
			"-c",
			'model_reasoning_effort="high"',
			"-s",
			"read-only",
			"--skip-git-repo-check",
			"--ephemeral",
			"-o",
			outFile,
			"-",
		],
		promptFile,
		30 * 60_000,
	);
	return parseLabels(await readFile(outFile, "utf8"));
}

/** Runs async tasks with at most `limit` in flight. */
async function pool<T>(tasks: Array<() => Promise<T>>, limit: number) {
	const results: T[] = [];
	let next = 0;
	const worker = async () => {
		while (next < tasks.length) {
			const i = next++;
			results[i] = await (tasks[i] as () => Promise<T>)();
		}
	};
	await Promise.all(Array.from({ length: limit }, worker));
	return results;
}

async function labelMissing(parts: Sampled[], labels: Labels) {
	for (const who of ["opus", "sol"] as const) {
		const todo = parts.filter((p) => labels[p.id]?.[who] === undefined);
		const batches = Array.from(
			{ length: Math.ceil(todo.length / batchSize) },
			(_, i) => todo.slice(i * batchSize, (i + 1) * batchSize),
		);
		console.error(`${who}: ${todo.length} parts in ${batches.length} batches`);
		await pool(
			batches.map((batch, i) => async () => {
				const tag = `${who}-${Date.now()}-${i}`;
				const got = await (who === "opus"
					? labelWithOpus(batch, tag)
					: labelWithSol(batch, tag)
				).catch((e: unknown) => {
					console.error(`${who} batch ${i} failed: ${String(e)}`);
					return {} as Record<string, Label | null>;
				});
				for (const p of batch)
					if (p.id in got)
						labels[p.id] = { ...labels[p.id], [who]: got[p.id] ?? null };
				console.error(
					`${who} batch ${i}: ${Object.keys(got).length}/${batch.length}`,
				);
			}),
			6,
		);
	}
}

// --- main -------------------------------------------------------------------

const readJson = async <T>(file: string, fallback: T): Promise<T> =>
	existsSync(file) ? (JSON.parse(await readFile(file, "utf8")) as T) : fallback;

await mkdir(join(work, "label-cwd"), { recursive: true });
const partsFile = join(work, "parts.json");
const labelsFile = join(work, "labels.json");
const parts = await readJson<Sampled[]>(partsFile, []);
const labels = await readJson<Labels>(labelsFile, {});
const candidates = await loadCandidates();
console.error(
	`candidates after per-session cap: claude ${candidates.claude.length}, opencode ${candidates.opencode.length}`,
);

const agreed = () =>
	parts.filter((p) => {
		const l = labels[p.id];
		return l?.opus != null && l.opus === l.sol;
	});

for (let round = 0; round < 8; round++) {
	const need =
		parts.length === 0
			? initialSample
			: agreed().length < targetAgreed
				? step
				: 0;
	if (need > 0) {
		parts.push(...(await sampleMore(candidates, parts, need)));
		await writeFile(partsFile, JSON.stringify(parts, null, 2));
	}
	await labelMissing(parts, labels);
	await writeFile(labelsFile, JSON.stringify(labels, null, 2));
	const both = parts.filter(
		(p) => labels[p.id]?.opus != null && labels[p.id]?.sol != null,
	);
	console.error(
		`round ${round}: sampled ${parts.length}, both labelled ${both.length}, agreed ${agreed().length}`,
	);
	if (agreed().length >= targetAgreed && both.length === parts.length) break;
}

const both = parts.filter(
	(p) => labels[p.id]?.opus != null && labels[p.id]?.sol != null,
);
const fixture: Fixture = {
	description:
		"Mid-turn assistant text parts from real Claude (conduit events.db) and OpenCode (opencode.db) sessions, labelled independently by two models with the same prompt and kept only where both agree. Request/message truncated per plan decision 4; paths, names, emails and secrets scrubbed. Built by scripts/spikes/jev-surfacing/build-fixture.ts (conduit-test-ahu8.1).",
	labellers: [
		"claude-opus-5-5 via claude -p --model opus",
		"gpt-6.1-sol (high) via codex exec",
	],
	sampled: parts.length,
	bothLabelled: both.length,
	agreed: agreed().length,
	// Scrub again on write so rule changes reach parts sampled by an earlier run.
	parts: agreed().map(({ id, provider, request, message }) => ({
		id,
		provider,
		request: scrub(request),
		message: scrub(message),
		label: labels[id]?.opus as Label,
	})),
};
await mkdir(resolve("test/fixtures/jev-surfacing"), { recursive: true });
await writeFile(fixturePath, `${JSON.stringify(fixture, null, "\t")}\n`);
console.log(
	JSON.stringify({
		sampled: parts.length,
		bothLabelled: both.length,
		agreed: fixture.agreed,
		agreementRate: both.length ? fixture.agreed / both.length : 0,
	}),
);
