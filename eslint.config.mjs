import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules", "bun.lock"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.commonjs,
      },
    },
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["bin/plugin-manifest-tool.js"],
    rules: {
      "no-unused-vars": "off",
    },
  },
];
