// @ts-check
import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Shared ESLint preset for Node/Nest code.
 * `tsconfigRootDir` must be passed by the consumer so type-aware rules resolve the right project.
 * @param {string} tsconfigRootDir
 */
export function nodeConfig(tsconfigRootDir) {
  return tseslint.config(
    { ignores: ["dist/**", "coverage/**", "node_modules/**", "src/generated/**", "eslint.config.mjs", "jest.config.*"] },
    eslint.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    prettier,
    {
      languageOptions: {
        globals: { ...globals.node, ...globals.jest },
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      rules: {
        // The workspace rule: no `any` escapes. `as any` and explicit `any` are errors.
        "@typescript-eslint/no-explicit-any": "error",
        "@typescript-eslint/no-unsafe-assignment": "error",
        "@typescript-eslint/no-unsafe-argument": "error",
        "@typescript-eslint/no-unsafe-call": "error",
        "@typescript-eslint/no-unsafe-member-access": "error",
        "@typescript-eslint/no-unsafe-return": "error",
        "@typescript-eslint/no-floating-promises": "error",
        "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],
        "@typescript-eslint/require-await": "off",
        "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
        "@typescript-eslint/consistent-type-imports": ["warn", { prefer: "type-imports", fixStyle: "inline-type-imports" }],
        "@typescript-eslint/no-extraneous-class": "off",
        "no-console": ["warn", { allow: ["warn", "error"] }],
      },
    },
  );
}
