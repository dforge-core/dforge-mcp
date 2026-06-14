import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// @dforge-core/metadata's published dist uses extensionless ESM relative
		// imports (e.g. `import "./aggregation"`), which only a bundler resolves —
		// plain Node ESM throws ERR_MODULE_NOT_FOUND. Inline it so Vite transforms
		// it for the test run. The server bundles it via tsup at build time, so
		// runtime is unaffected; this is only for vitest's Node loader.
		server: { deps: { inline: ["@dforge-core/metadata"] } },
	},
});
