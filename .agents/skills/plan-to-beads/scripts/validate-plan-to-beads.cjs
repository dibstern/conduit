#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const skillRoot = path.resolve(__dirname, "..");
const errors = [];
const warnings = [];

const childTables = [
	"[steps.metadata.workPacket.goalContract]",
	"[steps.metadata.workPacket.inputContract]",
	"[steps.metadata.workPacket.constraintContract]",
	"[steps.metadata.workPacket.executionContract]",
	"[steps.metadata.workPacket.validationContract]",
	"[steps.metadata.workPacket.outputContract]",
	"[steps.metadata.workPacket.failureContract]",
	"[steps.metadata.workPacket.handoffContract]",
];

const checkpointTables = [
	"[steps.metadata.checkpointContract.gateContract]",
	"[steps.metadata.checkpointContract.fanoutContract]",
	"[steps.metadata.checkpointContract.mergeContract]",
	"[steps.metadata.checkpointContract.validationContract]",
	"[steps.metadata.checkpointContract.escalationContract]",
];

const acceptancePipelineTables = [
	"[steps.metadata.acceptancePipelineContract.gherkinFeatureContract]",
	"[steps.metadata.acceptancePipelineContract.jsonIrContract]",
	"[steps.metadata.acceptancePipelineContract.acceptanceGeneratorContract]",
	"[steps.metadata.acceptancePipelineContract.stepHandlerContract]",
	"[steps.metadata.acceptancePipelineContract.runnerAdapterContract]",
	"[steps.metadata.acceptancePipelineContract.mutationContract]",
	"[steps.metadata.acceptancePipelineContract.mutationReportContract]",
];

function read(file) {
	return fs.readFileSync(file, "utf8");
}

function lineCount(text) {
	return text.trimEnd().split(/\r?\n/).length;
}

function splitSteps(text) {
	return text
		.split(/\n(?=\[\[steps\]\])/g)
		.filter((block) => block.includes("[[steps]]"));
}

function getString(block, key) {
	const match = block.match(
		new RegExp(`(^|\\n)\\s*${key}\\s*=\\s*"([^"]*)"`, "m"),
	);
	return match ? match[2] : "";
}

function getTable(block, heading) {
	const start = block.indexOf(heading);
	if (start === -1) return "";
	const rest = block.slice(start + heading.length);
	const next = rest.search(/\n\s*\[/);
	return next === -1 ? rest : rest.slice(0, next);
}

function getArrayValues(block, key) {
	const match = block.match(
		new RegExp(`(^|\\n)\\s*${key}\\s*=\\s*(\\[[\\s\\S]*?\\])`, "m"),
	);
	if (!match) return [];
	return Array.from(match[2].matchAll(/"([^"]+)"/g), (m) => m[1]);
}

function validateSkillSource() {
	const skillPath = path.join(skillRoot, "SKILL.md");
	const examplesPath = path.join(skillRoot, "EXAMPLES.md");
	const childTemplatePath = path.join(skillRoot, "templates/roles/child.toml");
	const rolesDir = path.join(skillRoot, "templates/roles");

	const skillText = read(skillPath);
	if (lineCount(skillText) > 100) {
		errors.push(
			`SKILL.md has ${lineCount(skillText)} lines; keep it under 100.`,
		);
	}

	if (!fs.existsSync(examplesPath)) {
		errors.push("EXAMPLES.md is missing.");
	}

	const childText = read(childTemplatePath);
	const planMetadata = getTable(childText, "[steps.metadata.planToBeads]");
	if (/\bcontextUse\s*=/.test(planMetadata)) {
		errors.push(
			"Child role template must not render contextUse in planToBeads metadata.",
		);
	}

	for (const file of fs
		.readdirSync(rolesDir)
		.filter((name) => name.endsWith(".toml"))) {
		const roleText = read(path.join(rolesDir, file));
		if (!roleText.includes('contractVersion = "plan-to-beads.v3"')) {
			errors.push(`${file} is missing contractVersion = "plan-to-beads.v3".`);
		}
	}
}

function validateGeneratedFormula(file) {
	const text = read(file);
	const relative = path.relative(process.cwd(), file);

	if (text.includes("{{")) {
		errors.push(`${relative}: unresolved {{...}} placeholder found.`);
	}

	const logicalIds = Array.from(
		text.matchAll(/(^|\n)\s*logicalId\s*=\s*"([^"]+)"/g),
		(m) => m[2],
	);
	const seen = new Set();
	for (const id of logicalIds) {
		if (seen.has(id)) errors.push(`${relative}: duplicate logicalId "${id}".`);
		seen.add(id);
	}

	const stepIds = new Set(
		Array.from(text.matchAll(/(^|\n)\s*id\s*=\s*"([^"]+)"/g), (m) => m[2]),
	);
	const resolvable = new Set([...stepIds, ...seen]);
	for (const step of splitSteps(text)) {
		const role = getString(step, "role");
		const id =
			getString(step, "id") || getString(step, "logicalId") || "<unknown>";

		if (role === "child") {
			for (const table of childTables) {
				if (!step.includes(table))
					errors.push(`${relative}:${id}: missing ${table}.`);
			}

			const planMetadata = getTable(step, "[steps.metadata.planToBeads]");
			const inputContract = getTable(
				step,
				"[steps.metadata.workPacket.inputContract]",
			);
			if (
				/\bcontextUse\s*=/.test(planMetadata) &&
				/\bcontextUse\s*=/.test(inputContract)
			) {
				errors.push(
					`${relative}:${id}: child contextUse appears in both planToBeads and inputContract.`,
				);
			}
		}

		if (role === "checkpoint") {
			for (const table of checkpointTables) {
				if (!step.includes(table))
					errors.push(`${relative}:${id}: missing ${table}.`);
			}
		}

		if (role === "acceptance-pipeline") {
			for (const table of acceptancePipelineTables) {
				if (!step.includes(table))
					errors.push(`${relative}:${id}: missing ${table}.`);
			}
		}

		for (const key of ["needs", "contextRefs", "inherits"]) {
			for (const ref of getArrayValues(step, key)) {
				if (!resolvable.has(ref) && !ref.startsWith("external:")) {
					warnings.push(
						`${relative}:${id}: ${key} reference "${ref}" does not resolve inside this formula.`,
					);
				}
			}
		}
	}
}

const files = process.argv.slice(2);
if (files.length === 0) {
	validateSkillSource();
} else {
	for (const file of files) validateGeneratedFormula(path.resolve(file));
}

for (const warning of warnings) console.warn(`WARN ${warning}`);

if (errors.length > 0) {
	for (const error of errors) console.error(`ERROR ${error}`);
	process.exit(1);
}

console.log("plan-to-beads validation passed");
