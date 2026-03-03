/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

module.exports = {
	meta: {
		type: 'suggestion',
		docs: {
			description: 'Disallow the use of any except in union types within method signatures',
			category: 'Best Practices',
			recommended: true,
		},
		fixable: null,
		schema: [],
		messages: {
			unexpectedAny: 'Unexpected any. Use a more specific type instead.',
		},
	},

	create(context) {
		return {
			// Target the 'any' type annotation
			TSAnyKeyword(node) {
				// Get the parent nodes to determine context
				const parent = node.parent;

				if (parent) {
					// Check if this type is part of a method signature
					let currentNode = parent;
					let isMethodSignature = false;

					while (currentNode) {
						// Check if we're in a method signature or function type
						if (
							currentNode.type === 'TSMethodSignature' ||
							currentNode.type === 'TSFunctionType' ||
							currentNode.type === 'FunctionDeclaration' ||
							currentNode.type === 'FunctionExpression' ||
							currentNode.type === 'ArrowFunctionExpression' ||
							currentNode.type === 'MethodDefinition'
						) {
							isMethodSignature = true;
							break;
						}

						currentNode = currentNode.parent;
					}

					// If it's part of a method signature, it's allowed
					if (isMethodSignature) {
						return;
					}
				}

				// Report any other use of 'any'
				context.report({
					node,
					messageId: 'unexpectedAny',
				});
			}
		};
	}
};
