/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
import js from '@eslint/js';
import tsparser from '@typescript-eslint/parser';
import * as importPlugin from 'eslint-plugin-import';
import { defineConfig } from 'eslint/config';
import rulesdir from './build/eslint-rules/index.js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default defineConfig([
	// Global ignore patterns
	{
		ignores: [
			'build',
			'dist/**/*',
			'out/**/*',
			'src/@types/**/*.d.ts',
			'src/api/api*.d.ts',
			'src/test/**',
			'**/*.{js,mjs,cjs}',
			'.vscode-test/**/*'
		]
	},

	// Base configuration for all TypeScript files
	{
		files: ['**/*.{ts,tsx,mts,cts}'],
		languageOptions: {
			parser: tsparser,
			parserOptions: {
				ecmaVersion: 2019,
				sourceType: 'module',
				project: 'tsconfig.base.json'
			},
		},
		plugins: {
			'import': /** @type {any} */(importPlugin),
			'rulesdir': /** @type {any} */(rulesdir),
			'@typescript-eslint': tseslint.plugin,
		},
		settings: {
			// Let plugin-import resolve TS paths (including d.ts, type packages, etc.)
			'import/resolver': {
				typescript: {
					project: [
						'tsconfig.base.json',
						'tsconfig.json',
						'tsconfig.webviews.json'
					],
					alwaysTryTypes: true
				},
				node: {
					extensions: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.d.ts']
				}
			},
			// For rules like import/extensions (list everything you consider "module" extensions)
			'import/extensions': ['.js', '.mjs', '.cjs', '.ts', '.tsx']
		},
		rules: {
			// ESLint recommended rules
			...js.configs.recommended.rules,

			// Custom rules
			'new-parens': 'error',
			'no-async-promise-executor': 'off',
			'no-console': 'off',
			'no-constant-condition': ['warn', { 'checkLoops': false }],
			'no-caller': 'error',
			'no-case-declarations': 'off', // TODO@alexr00 revisit
			'no-debugger': 'warn',
			'no-dupe-class-members': 'off',
			'no-duplicate-imports': 'error',
			'no-else-return': 'off', // TODO@alexr00 revisit
			'no-empty': 'off', // TODO@alexr00 revisit
			'no-eval': 'error',
			'no-ex-assign': 'warn',
			'no-extend-native': 'error',
			'no-extra-bind': 'error',
			'no-extra-boolean-cast': 'off', // TODO@alexr00 revisit
			'no-floating-decimal': 'error',
			'no-implicit-coercion': 'off',
			'no-implied-eval': 'error',
			'no-inner-declarations': 'off',
			'no-lone-blocks': 'error',
			'no-lonely-if': 'off',
			'no-loop-func': 'error',
			'no-multi-spaces': 'off',
			'no-prototype-builtins': 'off',
			'no-return-assign': 'error',
			'no-return-await': 'off', // TODO@alexr00 revisit
			'no-self-compare': 'error',
			'no-sequences': 'error',
			'no-template-curly-in-string': 'warn',
			'no-throw-literal': 'error',
			'no-undef': 'off',
			'no-unneeded-ternary': 'error',
			'no-use-before-define': 'off',
			'no-useless-call': 'error',
			'no-useless-catch': 'error',
			'no-useless-computed-key': 'error',
			'no-useless-concat': 'error',
			'no-useless-escape': 'off',
			'no-useless-rename': 'error',
			'no-useless-return': 'off',
			'no-var': 'error',
			'no-with': 'error',
			'no-redeclare': 'off',
			'no-restricted-syntax': [
				'error',
				{
					'selector': 'BinaryExpression[operator=\'in\']',
					'message': 'Avoid using the \'in\' operator for type checks.'
				}
			],
			'no-unused-vars': "off", // Disable the base rule so we can use the TS version
			'object-shorthand': 'off',
			'one-var': 'off', // TODO@alexr00 revisit
			'prefer-arrow-callback': 'off', // TODO@alexr00 revisit
			'prefer-const': 'off',
			'prefer-numeric-literals': 'error',
			'prefer-object-spread': 'error',
			'prefer-rest-params': 'error',
			'prefer-spread': 'error',
			'prefer-template': 'off', // TODO@alexr00 revisit
			'quotes': ['error', 'single', { 'avoidEscape': true, 'allowTemplateLiterals': true }],
			'require-atomic-updates': 'off',
			'semi': ['error', 'always'],
			'semi-style': ['error', 'last'],
			'yoda': 'error',
			'sort-imports': [
				'error',
				{
					'ignoreCase': true,
					'ignoreDeclarationSort': true,
					'ignoreMemberSort': false,
					'memberSyntaxSortOrder': ['none', 'all', 'multiple', 'single']
				}
			],

			// Import plugin rules
			'import/export': 'off',
			'import/extensions': ['error', 'ignorePackages', {
				js: 'never',
				mjs: 'never',
				cjs: 'never',
				ts: 'never',
				tsx: 'never'
			}],
			'import/named': 'off',
			'import/namespace': 'off',
			'import/newline-after-import': 'warn',
			'import/no-cycle': 'off',
			'import/no-dynamic-require': 'error',
			'import/no-default-export': 'off', // TODO@alexr00 revisit
			'import/no-duplicates': 'error',
			'import/no-self-import': 'error',
			'import/no-unresolved': ['warn', { 'ignore': ['vscode', 'ghpr', 'git', 'extensionApi', '@octokit/rest', '@octokit/types'] }],
			'import/order': [
				'warn',
				{
					'groups': ['builtin', 'external', 'internal', ['parent', 'sibling', 'index']],
					'newlines-between': 'ignore',
					'alphabetize': {
						'order': 'asc',
						'caseInsensitive': true
					}
				}
			],

			// TypeScript ESLint rules
			'@typescript-eslint/await-thenable': 'error',
			'@typescript-eslint/ban-types': 'off', // TODO@alexr00 revisit

			'@typescript-eslint/consistent-type-assertions': [
				'warn',
				{
					'assertionStyle': 'as',
					'objectLiteralTypeAssertions': 'allow-as-parameter'
				}
			],
			'@typescript-eslint/explicit-function-return-type': 'off',
			'@typescript-eslint/explicit-member-accessibility': 'off',
			'@typescript-eslint/explicit-module-boundary-types': 'off', // TODO@alexr00 revisit

			'@typescript-eslint/no-empty-function': 'off',
			'@typescript-eslint/no-empty-interface': 'error',
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-floating-promises': 'off', // TODO@alexr00 revisit
			'@typescript-eslint/no-implied-eval': 'error',
			'@typescript-eslint/no-inferrable-types': 'off', // TODO@alexr00 revisit
			'@typescript-eslint/no-misused-promises': ['error', { 'checksConditionals': false, 'checksVoidReturn': false }],
			'@typescript-eslint/no-namespace': 'off',
			'@typescript-eslint/no-non-null-assertion': 'off',
			"@typescript-eslint/no-redeclare": ["error", { "ignoreDeclarationMerge": true }],
			'@typescript-eslint/no-redundant-type-constituents': 'off',
			'@typescript-eslint/no-this-alias': 'off',
			'@typescript-eslint/no-unnecessary-condition': 'off',
			'@typescript-eslint/no-unnecessary-type-assertion': 'off', // TODO@alexr00 revisit
			'@typescript-eslint/no-unsafe-argument': 'off',
			'@typescript-eslint/no-unsafe-assignment': 'off', // TODO@alexr00 revisit
			'@typescript-eslint/no-unsafe-call': 'off', // TODO@alexr00 revisit
			'@typescript-eslint/no-unsafe-enum-comparison': 'off',
			'@typescript-eslint/no-unsafe-member-access': 'off', // TODO@alexr00 revisit
			'@typescript-eslint/no-unsafe-return': 'off', // TODO@alexr00 revisit
			'@typescript-eslint/no-unused-expressions': ['warn', { 'allowShortCircuit': true }],
			'@typescript-eslint/no-unused-vars': ['error', { 'argsIgnorePattern': '^_', caughtErrors: 'none' }],
			'@typescript-eslint/no-use-before-define': 'off',
			'@typescript-eslint/prefer-regexp-exec': 'off', // TODO@alexr00 revisit
			'@typescript-eslint/prefer-nullish-coalescing': 'off',
			'@typescript-eslint/prefer-optional-chain': 'off',
			'@typescript-eslint/require-await': 'off', // TODO@alexr00 revisit
			'@typescript-eslint/restrict-plus-operands': 'error',
			'@typescript-eslint/restrict-template-expressions': 'off', // TODO@alexr00 revisit
			'@typescript-eslint/strict-boolean-expressions': 'off',
			'@typescript-eslint/unbound-method': 'off',

			// Custom rules
			'rulesdir/no-any-except-union-method-signature': 'error',
			'rulesdir/no-pr-in-user-strings': 'error',
			'rulesdir/no-cast-to-any': 'error',
		}
	},

	// Node.js environment specific config (exclude browser-specific files)
	{
		files: ['src/**/*.ts', '!src/env/browser/**/*'],
		languageOptions: {
			parser: tsparser,
			parserOptions: {
				ecmaVersion: 2019,
				sourceType: 'module',
				project: 'tsconfig.json'
			},
			globals: {
				...globals.node,
				...globals.mocha,
				'RequestInit': true,
				'NodeJS': true,
				'Thenable': true,
			},
		},
	},

	// Browser environment specific config
	{
		files: ['src/env/browser/**/*.ts'],
		languageOptions: {
			parser: tsparser,
			parserOptions: {
				ecmaVersion: 2019,
				sourceType: 'module',
				project: 'tsconfig.json'
			},
			globals: {
				...globals.browser,
				'Thenable': true,
			},
		}
	},

	// Webviews
	{
		files: ['webviews/**/*.{ts,tsx}'],
		languageOptions: {
			parser: tsparser,
			parserOptions: {
				ecmaVersion: 2019,
				sourceType: 'module',
				project: 'tsconfig.webviews.json'
			},
			globals: {
				...globals.browser,
				'JSX': true,
			},
		},
		rules: {
			'rulesdir/public-methods-well-defined-types': 'error'
		},
	},
]);