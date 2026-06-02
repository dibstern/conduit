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

const arrayRefKeys = [
	"needs",
	"contextRefs",
	"inherits",
	"typedContractRefs",
	"fixtureRefs",
	"baselineRefs",
	"evidenceRefs",
	"externalPlanRefs",
	"guardrailRefs",
	"riskRefs",
	"acceptanceMatrixRefs",
	"fileOperationRefs",
	"blockerDecisionRefs",
	"followupTemplateRefs",
	"ownershipMapRefs",
	"validationCatalogRefs",
	"decisionRefs",
	"executorPolicyRefs",
	"guardrailEvidenceRefs",
	"allowedExceptionRefs",
	"featureRefs",
];

const scalarRefKeys = [
	"changeSurfaceRef",
	"criterionRef",
	"executorProfileRef",
	"mergeCheckpointRef",
];

const contextUsePhases = new Set([
	"before-edit",
	"during-edit",
	"verification",
	"handoff",
	"if-blocked",
]);

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

function getInlineString(block, key) {
	const match = block.match(
		new RegExp(`(^|[,\\s])\\s*${key}\\s*=\\s*"([^"]*)"`, "m"),
	);
	return match ? match[2] : "";
}

function isExternalRef(ref) {
	return ref.startsWith("external:");
}

function validateRef(relative, id, key, ref, resolvable) {
	if (!ref || ref.includes("{{")) return;
	if (resolvable.has(ref) || isExternalRef(ref)) return;
	errors.push(`${relative}:${id}: ${key} reference "${ref}" does not resolve.`);
}

function collectProvides(relative, steps) {
	const provides = new Set();
	for (const step of steps) {
		const id =
			getString(step, "id") || getString(step, "logicalId") || "<unknown>";
		for (const ref of getArrayValues(step, "provides")) {
			if (provides.has(ref)) {
				errors.push(
					`${relative}:${id}: duplicate provides reference "${ref}".`,
				);
			}
			provides.add(ref);
		}
	}
	return provides;
}

function validateContextUse(relative, id, step, resolvable) {
	const contextUseBlocks = Array.from(
		step.matchAll(
			/(^|\n)\s*contextUse\s*=\s*\[([\s\S]*?)\]\s*(?=\n\s*[A-Za-z_][A-Za-z0-9_]*\s*=|\n\s*\[|$)/g,
		),
		(match) => match[2],
	);

	for (const block of contextUseBlocks) {
		const entries = Array.from(
			block.matchAll(/\{([^{}]*\bref\s*=\s*"[^"]+"[^{}]*)\}/g),
		);
		for (const entryMatch of entries) {
			const entry = entryMatch[1];
			const ref = getInlineString(entry, "ref");
			const phase = getInlineString(entry, "phase");
			const reason = getInlineString(entry, "reason");
			const failureIfMissing = getInlineString(entry, "failureIfMissing");

			validateRef(relative, id, "contextUse.ref", ref, resolvable);

			if (!contextUsePhases.has(phase)) {
				errors.push(
					`${relative}:${id}: contextUse ref "${ref}" has invalid phase "${phase}".`,
				);
			}
			if (!/\brequired\s*=/.test(entry)) {
				errors.push(
					`${relative}:${id}: contextUse ref "${ref}" is missing required.`,
				);
			}
			if (!reason) {
				errors.push(
					`${relative}:${id}: contextUse ref "${ref}" is missing reason.`,
				);
			}
			if (!failureIfMissing) {
				errors.push(
					`${relative}:${id}: contextUse ref "${ref}" is missing failureIfMissing.`,
				);
			}
		}

		const refs = Array.from(
			block.matchAll(/\bref\s*=\s*"([^"]+)"/g),
			(match) => match[1],
		);
		if (refs.length > 0 && entries.length === 0) {
			errors.push(
				`${relative}:${id}: contextUse entries must be inline tables with ref, phase, required, reason, and failureIfMissing.`,
			);
		}
	}
}

function validateSkillSource() {
	const skillPath = path.join(skillRoot, "SKILL.md");
	const examplesPath = path.join(skillRoot, "EXAMPLES.md");
	const childTemplatePath = path.join(skillRoot, "templates/roles/child.toml");
	const rendererPath = path.join(skillRoot, "scripts/render-plan-to-beads.cjs");
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

	if (!fs.existsSync(rendererPath)) {
		errors.push("scripts/render-plan-to-beads.cjs is missing.");
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

	const steps = splitSteps(text);
	const stepIds = new Set(
		Array.from(text.matchAll(/(^|\n)\s*id\s*=\s*"([^"]+)"/g), (m) => m[2]),
	);
	const provides = collectProvides(relative, steps);
	const resolvable = new Set([...stepIds, ...seen, ...provides]);
	for (const step of steps) {
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

		for (const key of arrayRefKeys) {
			for (const ref of getArrayValues(step, key)) {
				validateRef(relative, id, key, ref, resolvable);
			}
		}

		for (const key of scalarRefKeys) {
			validateRef(relative, id, key, getString(step, key), resolvable);
		}

		validateContextUse(relative, id, step, resolvable);
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
