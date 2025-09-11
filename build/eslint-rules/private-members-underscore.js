/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

/**
 * ESLint rule to enforce that private class members start with underscore (_).
 * This rule checks private properties, methods, getters, and setters in TypeScript classes.
 */

module.exports = {
	meta: {
		type: 'problem',
		docs: {
			description: 'Enforce that private class members start with underscore (_)',
			category: 'TypeScript',
			recommended: true,
		},
		schema: [],
		messages: {
			privateUnderscore: 'Private member "{{memberName}}" should start with underscore (_).',
		},
		fixable: 'code',
	},

	create(context) {
		/**
		 * Check if a member is private
		 */
		function isPrivateMember(node) {
			// Check for explicit private modifier
			if (node.accessibility === 'private') {
				return true;
			}

			// Check for private modifier in the modifiers array (for different AST node types)
			if (node.modifiers) {
				return node.modifiers.some(modifier => modifier.kind === 'private');
			}

			return false;
		}

		/**
		 * Check if a member name starts with underscore
		 */
		function startsWithUnderscore(name) {
			return name && name.startsWith('_');
		}

		/**
		 * Get the member name from various node types
		 */
		function getMemberName(node) {
			if (node.key) {
				// For method definitions, property definitions
				if (node.key.type === 'Identifier') {
					return node.key.name;
				}
			}
			return null;
		}

		/**
		 * Report and potentially fix a private member naming violation
		 */
		function reportViolation(node, memberName) {
			context.report({
				node,
				messageId: 'privateUnderscore',
				data: {
					memberName,
				},
				fix(fixer) {
					// Only provide auto-fix for simple identifier cases
					if (node.key && node.key.type === 'Identifier') {
						return fixer.replaceText(node.key, `_${memberName}`);
					}
					return null;
				},
			});
		}

		return {
			// Handle class property definitions
			PropertyDefinition(node) {
				if (isPrivateMember(node)) {
					const memberName = getMemberName(node);
					if (memberName && !startsWithUnderscore(memberName)) {
						reportViolation(node, memberName);
					}
				}
			},

			// Handle method definitions (including getters/setters)
			MethodDefinition(node) {
				if (isPrivateMember(node)) {
					const memberName = getMemberName(node);
					if (memberName && !startsWithUnderscore(memberName)) {
						reportViolation(node, memberName);
					}
				}
			},

			// Handle constructor parameters with private modifier
			TSParameterProperty(node) {
				if (isPrivateMember(node)) {
					if (node.parameter && node.parameter.type === 'Identifier') {
						const memberName = node.parameter.name;
						if (memberName && !startsWithUnderscore(memberName)) {
							context.report({
								node,
								messageId: 'privateUnderscore',
								data: {
									memberName,
								},
								fix(fixer) {
									return fixer.replaceText(node.parameter, `_${memberName}`);
								},
							});
						}
					}
				}
			},
		};
	},
};