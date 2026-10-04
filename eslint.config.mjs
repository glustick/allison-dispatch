import tseslint from 'typescript-eslint'

// Ported from allison-web-iptv's eslint.config.mjs — deliberately minimal, not a general
// style-linting pass. no-floating-promises/no-misused-promises are the one rule pair that
// caught a real crash in the sibling (a Promise-returning call fired fire-and-forget becoming
// an unhandled rejection); this server has the same shape of risk (Express handlers, fs
// promises, sockets), so it carries forward from day one. no-duplicate-case/no-unreachable
// exist there because unreachable dead code once shipped a release past a green gate —
// a minimal config is still a config that should catch code which cannot run.
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'public/**'] },
  {
    files: ['src/server/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname }
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error'
    }
  },
  {
    files: ['src/client/src/**/*.ts', 'src/client/src/**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: './tsconfig.client.json', tsconfigRootDir: import.meta.dirname }
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      'no-duplicate-case': 'error',
      'no-unreachable': 'error'
    }
  }
)
