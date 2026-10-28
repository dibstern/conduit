import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const dynamic = (value) => /[${*]|^<|^(?:\.{3}|…)$/.test(value);
const globalOptions = { run: "value", pretty: "flag", help: "flag" };
const unescapeQuotes = (value) => value.replace(/\\(["'`\\])/g, "$1");

// Prove the finite Svelte case instead of accepting a dynamic prefix: every
// object in a const array supplies literal fields, and an each-bound property
// supplies the template's only interpolation. Removing a choice removes its ID.
function addEachLiterals(source, literals) {
	const collections = new Map();
	for (const declaration of source.matchAll(
		/\bconst\s+([\w$]+)\s*(?::[^=]*?)?=\s*\[([\s\S]*?)\]\s*(?:as\s+const\s*)?;/g,
	)) {
		const objects = [...declaration[2].matchAll(/\{([^{}]*)\}/g)];
		if (
			!objects.length ||
			declaration[2].replace(/\{[^{}]*\}/g, "").replace(/[,\s]/g, "")
		)
			continue;
		const rows = objects.map((object) => {
			const row = new Map();
			const field =
				/\s*([\w$]+)\s*:\s*(["'`])((?:\\.|(?!\2)[^\\])*)\2\s*(?:,|$)/gy;
			let offset = 0;
			while (offset < object[1].length) {
				if (!object[1].slice(offset).trim()) break;
				field.lastIndex = offset;
				const match = field.exec(object[1]);
				if (!match || row.has(match[1]) || dynamic(match[3])) return undefined;
				row.set(match[1], unescapeQuotes(match[3]));
				offset = field.lastIndex;
			}
			return row;
		});
		if (rows.every(Boolean)) collections.set(declaration[1], rows);
	}
	for (const each of source.matchAll(
		/\{#each\s+([\w$]+)\s+as\s+([\w$]+)\b[^}]*\}([\s\S]*?)\{\/each\}/g,
	)) {
		const rows = collections.get(each[1]);
		if (!rows) continue;
		for (const attribute of each[3].matchAll(
			/\b(?:id|data-testid)\s*=\s*\{\s*`([^`]+)`\s*\}/g,
		)) {
			const template = attribute[1].match(
				/^([^$`{}]*)\$\{([\w$]+)\.([\w$]+)\}([^$`{}]*)$/,
			);
			if (
				!template ||
				template[2] !== each[2] ||
				!rows.every((row) => row.has(template[3]))
			)
				continue;
			for (const row of rows)
				literals.add(template[1] + row.get(template[3]) + template[4]);
		}
	}
}

function frontendLiterals(directory, literals = new Set()) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const file = join(directory, entry.name);
		if (entry.isDirectory()) frontendLiterals(file, literals);
		else if (/\.(?:svelte|ts)$/.test(entry.name)) {
			const source = readFileSync(file, "utf8");
			for (const match of source.matchAll(
				/(["'`])((?:\\.|(?!\1)[^\\\r\n])*)\1/g,
			)) {
				literals.add(unescapeQuotes(match[2]));
			}
			// Include quoted attributes inside escaped querySelector strings too.
			for (const match of source.matchAll(
				/\b(?:id|data-testid)\s*=\s*\\*(["'])(.*?)\\*\1/g,
			))
				literals.add(match[2]);
			if (entry.name.endsWith(".svelte")) addEachLiterals(source, literals);
		}
	}
	return literals;
}

// Read only this invocation. Quotes keep eval/text arguments together; shell
// separators, comments and the closing Markdown backtick end the invocation.
function shellWords(text, offset) {
	const words = [];
	const quotedRanges = [];
	let value = "";
	let start = offset;
	let active = false;
	let quote;
	let quoteStart;
	let index = offset;
	const finish = () => {
		if (active) words.push({ value, offset: start });
		value = "";
		active = false;
	};
	for (; index < text.length; index++) {
		const char = text[index];
		if (quote) {
			if (char === quote) {
				quotedRanges.push([quoteStart, index + 1]);
				quote = undefined;
			} else if (char === "\\" && quote !== "'" && index + 1 < text.length) {
				if (text[index + 1] !== "\n") value += text[index + 1];
				index++;
			} else value += char;
			continue;
		}
		if (char === "\\" && text[index + 1] === "\n") {
			index++;
			continue;
		}
		if (char === "\n" || "`;|&>()".includes(char) || (char === "#" && !active))
			break;
		if (char === "<") {
			const placeholder = text.slice(index).match(/^<[^<>\s]+>/)?.[0];
			if (!placeholder) break;
			if (!active) start = index;
			active = true;
			value += placeholder;
			index += placeholder.length - 1;
			continue;
		}
		if (/\s/.test(char)) {
			finish();
			continue;
		}
		if (!active) start = index;
		active = true;
		if (char === '"' || char === "'") {
			quote = char;
			quoteStart = index;
		} else if (char === "\\" && index + 1 < text.length) value += text[++index];
		else value += char;
	}
	if (quote) quotedRanges.push([quoteStart, index]);
	finish();
	return { words, quotedRanges };
}

export function checkFeatures(skillDir, frontendDir, commands) {
	const documents = [
		join(skillDir, "SKILL.md"),
		...readdirSync(join(skillDir, "features"))
			.filter((name) => name.endsWith(".md"))
			.sort()
			.map((name) => join(skillDir, "features", name)),
	];
	const literals = frontendLiterals(frontendDir);
	const checked = { ids: 0, testIds: 0, commands: 0, links: 0 };
	const skipped = { ids: 0, testIds: 0, commands: 0, links: 0 };
	const stale = [];
	const reported = new Set();
	for (const document of documents) {
		const file = relative(skillDir, document);
		const text = readFileSync(document, "utf8");
		const lineAt = (offset) => text.slice(0, offset).split("\n").length;
		const report = (offset, kind, value, hint) => {
			const line = lineAt(offset);
			const key = JSON.stringify([file, line, kind, value]);
			if (reported.has(key)) return;
			reported.add(key);
			stale.push({ file, line, kind, value, hint });
		};
		const checkSelector = (offset, value, kind, counter) => {
			if (dynamic(value)) skipped[counter]++;
			else {
				checked[counter]++;
				if (!literals.has(value)) {
					report(
						offset,
						kind,
						value,
						`Update this ${kind} selector in ${file} to a frontend literal, or restore the missing frontend literal.`,
					);
				}
			}
		};

		// Mask link destinations before scanning selectors: a URL fragment is not
		// an element selector. Reference-style destinations are checked too.
		const destinations = [
			...text.matchAll(
				/!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\s*\)/g,
			),
			...text.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|[^\s]+)/gm),
		];
		const masked = text.split("");
		for (const match of destinations) {
			const destination = match[1].replace(/^<|>$/g, "");
			const offset = match.index + match[0].indexOf(match[1]);
			masked.fill(" ", offset, offset + match[1].length);
			if (
				!destination ||
				/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(destination) ||
				isAbsolute(destination)
			)
				continue;
			if (dynamic(destination)) {
				skipped.links++;
				continue;
			}
			checked.links++;
			let target;
			try {
				target = decodeURIComponent(destination.split(/[?#]/, 1)[0]);
			} catch {
				report(
					offset,
					"link",
					destination,
					`Fix the URL encoding of this relative link in ${file}.`,
				);
				continue;
			}
			if (!existsSync(resolve(dirname(document), target))) {
				report(
					offset,
					"link",
					destination,
					`Update this relative link in ${file}, or restore the linked file.`,
				);
			}
		}
		const selectors = masked
			.join("")
			.replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>`"']+/gi, (url) =>
				" ".repeat(url.length),
			)
			.replace(/\bhref\s*=\s*\\*["']#[^\s"']+\\*["']/g, (anchor) =>
				" ".repeat(anchor.length),
			);
		for (const match of selectors.matchAll(
			/(?<![\w/:?&=.%])#([a-zA-Z_${*][\w${}*-]*)/g,
		)) {
			const prefix = selectors.slice(
				Math.max(0, match.index - 200),
				match.index,
			);
			const selectorContext =
				/\b(?:querySelector(?:All)?|locator)\s*\([^)]*$/.test(prefix) ||
				/\$V\s+(?:click|hover|fill|scroll)\b[^;\n`]*$/.test(prefix);
			if (
				/^(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(match[1]) &&
				!selectorContext &&
				!literals.has(match[1])
			)
				continue;
			checkSelector(match.index, match[1], "id", "ids");
		}
		for (const match of selectors.matchAll(
			/\bdata-testid\s*=\s*(?:\\*(["'])(.*?)\\*\1|([^\\\s\]"'`<>]+))/g,
		)) {
			checkSelector(match.index, match[2] ?? match[3], "testId", "testIds");
		}

		const checkCommand = (words) => {
			let index = 0;
			while (words[index]?.value.startsWith("--")) {
				const argument = words[index];
				const flag = argument.value.slice(2).split("=", 1)[0];
				if (!Object.hasOwn(globalOptions, flag)) break;
				index++;
				if (globalOptions[flag] === "value" && !argument.value.includes("=")) {
					if (words[index]?.value && !words[index].value.startsWith("--"))
						index++;
					else
						report(
							argument.offset,
							"option",
							`--${flag}`,
							`Provide a value for --${flag} in ${file}.`,
						);
				}
			}
			const word = words[index];
			if (!word) return;
			if (dynamic(word.value)) {
				skipped.commands++;
				return;
			}
			checked.commands++;
			const command = Object.hasOwn(commands, word.value)
				? commands[word.value]
				: undefined;
			if (!command) {
				report(
					word.offset,
					"command",
					word.value,
					`Update the command in ${file}; choose a command from conduit-verify --help.`,
				);
				return;
			}
			const options = { ...globalOptions, ...command.options };
			let subcommand;
			for (index++; index < words.length; index++) {
				const argument = words[index];
				if (argument.value === "--") break;
				if (argument.value.startsWith("--")) {
					const flag = argument.value.slice(2).split("=", 1)[0];
					if (dynamic(flag)) skipped.commands++;
					else if (!Object.hasOwn(options, flag)) {
						report(
							argument.offset,
							"option",
							`--${flag}`,
							`Update this option in ${file}; run conduit-verify ${word.value} --help for accepted options.`,
						);
					}
					if (options[flag] === "value" && !argument.value.includes("=")) {
						const next = words[index + 1];
						if (next?.value && !next.value.startsWith("--")) index++;
						else
							report(
								argument.offset,
								"option",
								`--${flag}`,
								`Provide a value for --${flag} in ${file}; run conduit-verify ${word.value} --help.`,
							);
					}
				} else if (!subcommand) subcommand = argument;
			}
			if (command.subcommands && subcommand) {
				if (dynamic(subcommand.value)) skipped.commands++;
				else if (!command.subcommands.includes(subcommand.value)) {
					report(
						subcommand.offset,
						"command",
						`${word.value} ${subcommand.value}`,
						`Update the subcommand in ${file}; valid ${word.value} subcommands: ${command.subcommands.join(", ")}.`,
					);
				}
			}
		};
		const quotedRanges = [];
		for (const match of text.matchAll(/\$V\b/g)) {
			if (
				quotedRanges.some(
					([start, end]) => match.index >= start && match.index < end,
				)
			)
				continue;
			const parsed = shellWords(text, match.index + match[0].length);
			quotedRanges.push(...parsed.quotedRanges);
			checkCommand(parsed.words);
		}
		for (const match of text.matchAll(/`([^`\n]+)`/g)) {
			if (
				!quotedRanges.some(
					([start, end]) => match.index >= start && match.index < end,
				) &&
				/^(?:store|trace|features)\s+/.test(match[1])
			) {
				checkCommand(shellWords(text, match.index + 1).words);
			}
		}
	}
	return {
		ok: stale.length === 0,
		files: documents.length,
		checked,
		skipped,
		stale,
	};
}
