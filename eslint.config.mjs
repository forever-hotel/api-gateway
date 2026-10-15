import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      '.test-build/**',
      'coverage/**',
      'node_modules/**',
      '.npm-cache/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);  