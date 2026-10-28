import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import { readdirSync } from "node:fs";

const modules = readdirSync(new URL("./src/modules", import.meta.url));

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  ...modules.map((name) => ({
    files: [`src/modules/${name}/**/*.ts`],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: `^@modules/(?!${name}/)[^/]+/`,
              message: "A module must not reach into another module's files.",
            },
          ],
        },
      ],
    },
  })),
  {
    ignores: ["dist", "node_modules"],
  },
);
