import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  // scripts/verify-contract.mjs belongs to the read-only contract bundle
  // (hash-pinned in contracts/v1/manifest.json) and is not linted here.
  { ignores: ['dist/', 'node_modules/', 'coverage/', 'contracts/', 'scripts/verify-contract.mjs'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  { languageOptions: { globals: globals.node } },
);
