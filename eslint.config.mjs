import js from '@eslint/js'
import globals from 'globals'
import ts from 'typescript-eslint'
import prettier from 'eslint-plugin-prettier'
import { importX } from 'eslint-plugin-import-x'
import prettierConfig from 'eslint-config-prettier'
import perfectionist from 'eslint-plugin-perfectionist'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig(
  globalIgnores(['dist/', 'node_modules/', 'coverage/']),
  {
    files: ['**/*.{js,mjs,ts}'],
    extends: [js.configs.recommended],
    plugins: {
      prettier,
      perfectionist,
      import: importX,
    },
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.node,
    },
    rules: {
      'import/first': 'error',
      'prefer-template': 'error',
      'object-shorthand': 'error',
      'prettier/prettier': 'error',
      'import/newline-after-import': 'error',
      'arrow-body-style': ['error', 'as-needed'],
      'perfectionist/sort-objects': [
        'error',
        { order: 'asc', type: 'line-length' },
      ],
      'perfectionist/sort-exports': [
        'error',
        { order: 'asc', type: 'line-length' },
      ],
      'perfectionist/sort-interfaces': [
        'error',
        { order: 'asc', type: 'line-length' },
      ],
      'perfectionist/sort-object-types': [
        'error',
        { order: 'asc', type: 'line-length' },
      ],
      'perfectionist/sort-named-imports': [
        'error',
        { order: 'asc', type: 'line-length' },
      ],
      'perfectionist/sort-named-exports': [
        'error',
        { order: 'asc', type: 'line-length' },
      ],
      'perfectionist/sort-imports': [
        'error',
        {
          order: 'asc',
          newlinesBetween: 1,
          type: 'line-length',
          groups: [
            ['type-builtin', 'value-builtin'],
            ['type-external', 'value-external'],
            ['type-internal', 'value-internal', 'tsconfig-path'],
            [
              'type-parent',
              'type-index',
              'value-index',
              'type-sibling',
              'value-parent',
              'value-sibling',
            ],
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.ts'],
    extends: [ts.configs.recommended],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  prettierConfig,
  { rules: { curly: 'error' } },
)
