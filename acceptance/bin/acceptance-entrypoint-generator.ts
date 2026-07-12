import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type GeneratorOptions = {
	projectRoot?: string;
};

export type GeneratorResult = {
	metadataPath: string;
	generatedFiles: string[];
	implementationHash: string;
};

type Metadata = {
	schema_version: 1;
	feature_path: string;
	ir_path: string;
	implementation_hash: string;
	hash_scope: "generated_files";
	generated_files: string[];
};

function resolveFromRoot(projectRoot: string, path: string): string {
	return isAbsolute(path) ? path : resolve(projectRoot, path);
}

function toPosixPath(path: string): string {
	return path.split(sep).join("/");
}

function relativeToRoot(projectRoot: string, path: string): string {
	return toPosixPath(relative(projectRoot, path));
}

function importPath(
	fromFile: string,
	targetFileWithoutExtension: string,
): string {
	const raw = toPosixPath(
		relative(dirname(fromFile), targetFileWithoutExtension),
	);
	const path = raw.startsWith(".") ? raw : `./${raw}`;
	return `${path}.js`;
}

export function featureMetadataSlug(featurePath: string): string {
	return featurePath
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function generatedContent(
	irPath: string,
	generatedFile: string,
	projectRoot: string,
): string {
	const srcDir = join(projectRoot, "acceptance/src");
	const apsTypesImport = importPath(generatedFile, join(srcDir, "apsTypes"));
	const runtimeImport = importPath(generatedFile, join(srcDir, "runtime"));
	const handlersImport = importPath(
		generatedFile,
		join(srcDir, "stepHandlers"),
	);
	const commandName = `${basename(irPath, ".json")}.acceptance.ts`;

	return `import { readFileSync } from "node:fs";
import type { ApsFeature } from "${apsTypesImport}";
import { runFeature } from "${runtimeImport}";
import { conduitVisualHandlers, conduitVisualLifecycle } from "${handlersImport}";

async function main(): Promise<void> {
\tconst irPath = process.env["ACCEPTANCE_IR_PATH"] ?? process.argv[2];
\tif (!irPath) {
\t\tthrow new Error("Usage: ${commandName} <json-ir>");
\t}

\tconst feature = JSON.parse(readFileSync(irPath, "utf8")) as ApsFeature;
\tawait runFeature(feature, conduitVisualHandlers, conduitVisualLifecycle);
}

main()
\t.then(() => {
\t\tprocess.exit(0);
\t})
\t.catch((error: unknown) => {
\t\tconst message = error instanceof Error ? error.message : String(error);
\t\tconsole.error(message);
\t\tprocess.exit(1);
\t});
`;
}

export function hashGeneratedFiles(
	files: string[],
	projectRoot: string,
): string {
	const hash = createHash("sha256");
	for (const file of [...files].sort()) {
		hash.update(relativeToRoot(projectRoot, file));
		hash.update("\0");
		hash.update(readFileSync(file));
		hash.update("\0");
	}
	return hash.digest("hex");
}

export async function generateEntrypoint(
	irPathInput: string,
	generatedOutputInput: string,
	options: GeneratorOptions = {},
): Promise<GeneratorResult> {
	const projectRoot = resolve(options.projectRoot ?? process.cwd());
	const irPath = resolveFromRoot(projectRoot, irPathInput);
	const generatedOutput = resolveFromRoot(projectRoot, generatedOutputInput);
	const stem = basename(irPath, ".json");
	const featurePath = join(projectRoot, "features", `${stem}.feature`);
	const featurePathRelative = relativeToRoot(projectRoot, featurePath);

	if (!existsSync(irPath)) {
		throw new Error(
			`IR file does not exist: ${relativeToRoot(projectRoot, irPath)}`,
		);
	}
	if (!existsSync(featurePath)) {
		throw new Error(`Feature file does not exist: ${featurePathRelative}`);
	}

	JSON.parse(readFileSync(irPath, "utf8"));

	await mkdir(generatedOutput, { recursive: true });
	const generatedFile = join(generatedOutput, `${stem}.acceptance.ts`);
	await writeFile(
		generatedFile,
		generatedContent(irPath, generatedFile, projectRoot),
	);

	const generatedFiles = [relativeToRoot(projectRoot, generatedFile)];
	const implementationHash = `sha256:${hashGeneratedFiles([generatedFile], projectRoot)}`;
	const metadata: Metadata = {
		schema_version: 1,
		feature_path: featurePathRelative,
		ir_path: relativeToRoot(projectRoot, irPath),
		implementation_hash: implementationHash,
		hash_scope: "generated_files",
		generated_files: generatedFiles,
	};
	const metadataDir = join(generatedOutput, "metadata");
	await mkdir(metadataDir, { recursive: true });
	const metadataPath = join(
		metadataDir,
		`${featureMetadataSlug(featurePathRelative)}.json`,
	);
	await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

	return {
		metadataPath: relativeToRoot(projectRoot, metadataPath),
		generatedFiles,
		implementationHash,
	};
}

export async function main(
	args = process.argv.slice(2),
	options: GeneratorOptions = {},
): Promise<GeneratorResult> {
	const irPath = args[0];
	const generatedOutput = args[1];
	if (args.length !== 2 || !irPath || !generatedOutput) {
		throw new Error(
			"Usage: acceptance-entrypoint-generator <json-ir> <generated-output>",
		);
	}
	return generateEntrypoint(irPath, generatedOutput, options);
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1]
	? fileURLToPath(pathToFileURL(process.argv[1]))
	: "";

if (currentFile === invokedFile) {
	const args = process.argv.slice(2);
	if (args.length !== 2) {
		console.error(
			"Usage: acceptance-entrypoint-generator <json-ir> <generated-output>",
		);
		process.exitCode = 2;
	} else {
		main(args).catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			console.error(message);
			process.exitCode = 1;
		});
	}
}
