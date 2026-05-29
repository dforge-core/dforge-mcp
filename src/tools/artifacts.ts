// Pre-scaffold design artifact tools. These produce docs/REQUIREMENTS.md and
// docs/DESIGN.md and track their state in .dforge-artifacts.json.
// dforge_module_create is gated on designAt being set in that state file.

import * as path from "node:path";
import { z } from "zod";
import { readJsonOrDefault, jsonText, makeResult, type ToolResult } from "./_helpers";

interface ArtifactsState {
	requirementsAt?: string;
	designAt?: string;
}

function stateFilePath(moduleDir: string): string {
	return path.join(path.resolve(moduleDir), ".dforge-artifacts.json");
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

// ── Requirements ────────────────────────────────────────────────────────────

export const requirementsWriteSchema = {
	moduleDir: z
		.string()
		.describe(
			"Absolute path to the module directory (need not exist yet — will be created by dforge_module_create later).",
		),
	content: z.string().describe("Full markdown content for docs/REQUIREMENTS.md."),
};

export function requirementsWrite(
	args: z.infer<z.ZodObject<typeof requirementsWriteSchema>>,
): ToolResult {
	const stateFile = stateFilePath(args.moduleDir);
	const state = readJsonOrDefault<ArtifactsState>(stateFile, {});
	const newState: ArtifactsState = { ...state, requirementsAt: today() };

	return makeResult(
		"Requirements written to docs/REQUIREMENTS.md. Call dforge_design_write next to unblock scaffolding.",
		{
			"docs/REQUIREMENTS.md": args.content,
			".dforge-artifacts.json": jsonText(newState),
		},
	);
}

// ── Design ───────────────────────────────────────────────────────────────────

export const designWriteSchema = {
	moduleDir: z
		.string()
		.describe("Absolute path to the module directory."),
	content: z.string().describe("Full markdown content for docs/DESIGN.md."),
};

export function designWrite(
	args: z.infer<z.ZodObject<typeof designWriteSchema>>,
): ToolResult {
	const stateFile = stateFilePath(args.moduleDir);
	const state = readJsonOrDefault<ArtifactsState>(stateFile, {});

	if (!state.requirementsAt) {
		throw new Error(
			"Requirements document not found. Call dforge_requirements_write before dforge_design_write.",
		);
	}

	const newState: ArtifactsState = { ...state, designAt: today() };

	return makeResult(
		"Design written to docs/DESIGN.md. Module scaffolding is now unblocked — call dforge_module_create.",
		{
			"docs/DESIGN.md": args.content,
			".dforge-artifacts.json": jsonText(newState),
		},
	);
}

// ── Shared helper (re-exported for use in create-module gate) ────────────────

export function readArtifactsState(moduleDir: string): ArtifactsState {
	return readJsonOrDefault<ArtifactsState>(stateFilePath(moduleDir), {});
}
