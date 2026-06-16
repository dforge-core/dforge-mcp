import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";

const SCRIPT_PATH = path.resolve(
	__dirname,
	"..",
	"skills",
	"dforge-mcp-author",
	"scripts",
	"xlsx_to_model.py",
);

export const xlsxExtractSchema = {
	filePath: z.string().describe("Absolute path to the .xlsx file to extract."),
	maxDataRows: z
		.number()
		.int()
		.min(1)
		.max(200)
		.default(15)
		.describe("Max sample data rows per sheet (default 15)."),
};

function resolvePython(): string {
	for (const cmd of ["python3", "python"]) {
		const probe = spawnSync(cmd, ["--version"], { encoding: "utf8" });
		if (!probe.error && (probe.status ?? 1) === 0) return cmd;
	}
	throw new Error(
		"Python 3 not found on PATH. Install Python 3, then retry. " +
			"Fallback: ask the user to export each sheet as CSV (plain text — read it directly).",
	);
}

export interface XlsxSheet {
	name: string;
	headers: string[];
	rows: unknown[][];
}

export interface XlsxModel {
	sheets: XlsxSheet[];
}

export function xlsxExtract(
	args: z.infer<z.ZodObject<typeof xlsxExtractSchema>>,
): XlsxModel {
	const { filePath, maxDataRows } = args;

	if (!fs.existsSync(filePath)) {
		throw new Error(`File not found: ${filePath}`);
	}

	if (!fs.existsSync(SCRIPT_PATH)) {
		throw new Error(
			`Bundled extractor script missing at ${SCRIPT_PATH} — check the package 'files' list.`,
		);
	}

	const python = resolvePython();
	const r = spawnSync(python, [SCRIPT_PATH, filePath, String(maxDataRows)], {
		encoding: "utf8",
	});

	if (r.error) {
		throw new Error(`Failed to run Python extractor: ${r.error.message}`);
	}

	const stdout = (r.stdout ?? "").trim();
	if (!stdout) {
		const stderr = (r.stderr ?? "").trim();
		throw new Error(
			`Extractor produced no output (exit ${r.status}).${stderr ? ` Stderr: ${stderr}` : ""}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error(`Extractor output is not valid JSON: ${stdout.slice(0, 200)}`);
	}

	if (
		parsed !== null &&
		typeof parsed === "object" &&
		"error" in parsed
	) {
		throw new Error(`Extractor error: ${(parsed as { error: string }).error}`);
	}

	return parsed as XlsxModel;
}
