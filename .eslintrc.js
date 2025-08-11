/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const RULES_DIR = require('eslint-plugin-rulesdir');
RULES_DIR.RULES_DIR = './build/eslint-rules';

module.exports = {
	extends: ['.eslintrc.base.json'],
	env: {
		browser: true,
		node: true
	},
	parserOptions: {
		project: 'tsconfig.eslint.json'
	},
	plugins: ['rulesdir'],
	overrides: [
		{
			files: ['webviews/**/*.ts', 'webviews/**/*.tsx'],
			rules: {
				'rulesdir/public-methods-well-defined-types': 'error'
			}
		},
		{
			files: ['**/*.ts', '**/*.tsx'],
			rules: {
				'rulesdir/no-any-except-union-method-signature': 'error'
			}
		}
	]
};
