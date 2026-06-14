import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/server.ts"],
	format: ["cjs"],
	target: "node18",
	bundle: true,
	clean: true,
	banner: { js: "#!/usr/bin/env node" },
	// Bundle SDK + dforge-cli/templates into one dist/server.js so users
	// invoking via `npx @dforge-core/dforge-mcp` get a single file with no
	// post-install node_modules tree to materialize.
	noExternal: ["@modelcontextprotocol/sdk", "@dforge-core/dforge-cli", "@dforge-core/metadata", "zod"],
});
