import { nodeConfig } from "@ai-me/config/eslint/base.mjs";

export default [...nodeConfig(import.meta.dirname), { ignores: ["test-results/**", "playwright-report/**", ".auth/**"] }];
