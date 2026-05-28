// ESLint flat config (ESLint 9+). Minimal: @eslint/js recommended + typescript-eslint recommended.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["node_modules/**", "openspec/**", "agents/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      "@typescript-eslint/ban-ts-comment": ["warn", { "ts-ignore": "allow-with-description", "ts-expect-error": "allow-with-description" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-useless-escape": "warn",
      "no-control-regex": "off",
      "prefer-const": "warn",
      "no-useless-assignment": "off",
    },
  },
];
