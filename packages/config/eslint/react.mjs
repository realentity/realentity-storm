// @ts-check
import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Shared ESLint preset for Vite/React apps.
 * @param {string} tsconfigRootDir
 */
export function reactConfig(tsconfigRootDir) {
  return tseslint.config(
    { ignores: ["dist/**", "node_modules/**", "public/**", "eslint.config.js", "vite.config.ts"] },
    {
      files: ["**/*.{ts,tsx}"],
      extends: [eslint.configs.recommended, ...tseslint.configs.recommendedTypeChecked, prettier],
      languageOptions: {
        ecmaVersion: 2020,
        globals: globals.browser,
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
      rules: {
        ...reactHooks.configs.recommended.rules,
        "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
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
        "@typescript-eslint/no-empty-object-type": "off",
      },
    },
  );
}
