/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

/**
 * ESLint rule to detect the string "PR" in user-facing strings and suggest using "pull request" instead.
 * This rule checks:
 * - String literals passed to vscode.l10n.t() calls
 * - String literals passed to l10n.t() calls
 */

module.exports = {
	meta: {
		type: 'problem',
		docs: {
			description: 'Detect "PR" in user-facing strings and suggest using "pull request" instead',
			category: 'Best Practices',
			recommended: true,
		},
		schema: [],
		messages: {
			noPrInUserString: 'Use "pull request" instead of "PR" in user-facing strings. Found: {{foundText}}',
		},
	},

	create(context) {
		/**
		 * Check if a string contains "PR" as a standalone word
		 */
		function containsPR(str) {
			// Use word boundary regex to match "PR" as a standalone word
			const prRegex = /\bPR\b/;
			return prRegex.test(str);
		}

		/**
		 * Check if a node is a call to vscode.l10n.t or l10n.t
		 */
		function isL10nTCall(node) {
			if (node.type !== 'CallExpression') {
				return false;
			}

			const callee = node.callee;
			
			// Handle l10n.t() calls
			if (callee.type === 'MemberExpression' && 
				callee.property && 
				callee.property.name === 't') {
				
				// Check for vscode.l10n.t
				if (callee.object.type === 'MemberExpression' &&
					callee.object.object &&
					callee.object.object.name === 'vscode' &&
					callee.object.property &&
					callee.object.property.name === 'l10n') {
					return true;
				}
				
				// Check for l10n.t
				if (callee.object.type === 'Identifier' &&
					callee.object.name === 'l10n') {
					return true;
				}
			}
			
			return false;
		}

		return {
			// Check CallExpression nodes for l10n.t calls
			CallExpression(node) {
				if (isL10nTCall(node)) {
					// Check the first argument (string literal)
					if (node.arguments && node.arguments.length > 0) {
						const firstArg = node.arguments[0];
						if (firstArg.type === 'Literal' && typeof firstArg.value === 'string') {
							if (containsPR(firstArg.value)) {
								context.report({
									node: firstArg,
									messageId: 'noPrInUserString',
									data: {
										foundText: firstArg.value
									}
								});
							}
						}
					}
				}
			}
		};
	}
};