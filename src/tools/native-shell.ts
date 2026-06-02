import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import archiver from "archiver";

// All three tools below shell out to the native C# dforge-cli binary. They
// resolve the binary via DFORGE_CLI_BINARY env var or by trying the
// `dforge-cli` command on PATH. We deliberately don't try to require()
// @dforge-core/dforge-cli's sidecar packages — those have native binaries
// per platform that may not be installed alongside dforge-mcp.

function resolveDforgeCli(): string {
	const override = process.env.DFORGE_CLI_BINARY;
	if (override) {
		if (!fs.existsSync(override)) {
			throw new Error(
				`DFORGE_CLI_BINARY points at non-existent path: ${override}`,
			);
		}
		return override;
	}
	// Trust PATH lookup. dforge-cli installed via `npm install -g
	// @dforge-core/dforge-cli` exposes itself there.
	return "dforge-cli";
}

// ─── pack ────────────────────────────────────────────────────────────

export const packModuleSchema = {
	moduleDir: z.string().describe("Path to module directory (containing manifest.json)."),
	outPath: z
		.string()
		.optional()
		.describe("Output file or directory. Defaults to cwd, naming the file <code>-<version>.dforge."),
};

export async function packModule(
	args: z.infer<z.ZodObject<typeof packModuleSchema>>,
): Promise<{ tarballPath: string; sizeBytes: number; output: string }> {
	const moduleDir = path.resolve(args.moduleDir);

	const manifestPath = path.join(moduleDir, "manifest.json");
	if (!fs.existsSync(manifestPath)) {
		throw new Error(`manifest.json not found in: ${moduleDir}`);
	}
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { code: string; version: string };
	const defaultName = `${manifest.code}-${manifest.version}.dforge`;

	let outResolved: string;
	if (args.outPath) {
		outResolved = path.resolve(args.outPath);
		if (fs.existsSync(outResolved) && fs.statSync(outResolved).isDirectory()) {
			outResolved = path.join(outResolved, defaultName);
		}
	} else {
		outResolved = path.join(process.cwd(), defaultName);
	}

	await new Promise<void>((resolve, reject) => {
		const output = fs.createWriteStream(outResolved);
		const archive = archiver("zip", { zlib: { level: 6 } });

		output.on("close", resolve);
		archive.on("error", reject);
		archive.pipe(output);

		// Normalize backslashes to forward slashes so the archive is valid on
		// all platforms — Windows path.join uses backslashes but ZIP spec
		// requires forward slashes and the dForge installer relies on them.
		archive.directory(moduleDir, false, (entry) => {
			entry.name = entry.name.replace(/\\/g, "/");
			return entry;
		});

		archive.finalize();
	});

	const sizeBytes = fs.statSync(outResolved).size;
	return {
		tarballPath: outResolved,
		sizeBytes,
		output: `Packed ${outResolved} (${sizeBytes} bytes)`,
	};
}

// ─── install ─────────────────────────────────────────────────────────

export const installModuleSchema = {
	pathOrTarball: z
		.string()
		.describe("Module directory OR path to a .dforge tarball."),
	tenantUrl: z
		.string()
		.url()
		.optional()
		.describe("Tenant URL. Falls back to DFORGE_URL env var."),
	token: z
		.string()
		.optional()
		.describe("Auth token. Falls back to DFORGE_TOKEN env var."),
	tenantCode: z
		.string()
		.optional()
		.describe("Optional --code sanity check; server rejects if token's tenant doesn't match."),
};

export function installModule(
	args: z.infer<z.ZodObject<typeof installModuleSchema>>,
): { ok: boolean; output: string } {
	const argList = ["module", "install", "--path", args.pathOrTarball];
	if (args.tenantCode) {
		argList.push("--code", args.tenantCode);
	}
	const env: Record<string, string> = {};
	if (args.tenantUrl) env.DFORGE_URL = args.tenantUrl;
	if (args.token) env.DFORGE_TOKEN = args.token;

	const bin = resolveDforgeCli();
	const r = spawnSync(bin, argList, {
		encoding: "utf8",
		env: { ...process.env, ...env },
		shell: false,
	});
	if (r.error) {
		throw new Error(`Failed to exec ${bin}: ${r.error.message}`);
	}
	const ok = r.status === 0;
	const output = (r.stdout ?? "") + (r.stderr ?? "");
	return { ok, output };
}

// ─── dbml-import (stub) ──────────────────────────────────────────────

export const dbmlImportSchema = {
	dbmlText: z.string().describe("DBML source text."),
	moduleCode: z
		.string()
		.regex(/^[a-z][a-z0-9_-]*$/)
		.describe("Module code for the generated module."),
};

export function dbmlImport(
	_args: z.infer<z.ZodObject<typeof dbmlImportSchema>>,
): { ok: false; message: string } {
	return {
		ok: false,
		message:
			"dbml-import is not yet implemented in dforge-cli. The CLI command " +
			"`dforge-cli dbml-import --from-dbml <file>` is a stub. When it lands, " +
			"this tool will shell out to it and return the generated module file map.",
	};
}
