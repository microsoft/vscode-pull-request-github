/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

/**
 * ESLint rule to enforce that public methods in exported classes return well-defined types.
 * This rule ensures that no inline type (object literal, anonymous type, etc.) is returned
 * from any public method.
 */

const { ESLintUtils } = require('@typescript-eslint/utils');

module.exports = {
	meta: {
		type: 'problem',
		docs: {
			description: 'Enforce that public methods return well-defined types (no inline types)',
			category: 'TypeScript',
			recommended: false,
		},
		schema: [],
		messages: {
			inlineReturnType: 'Public method "{{methodName}}" should return a well-defined type, not an inline type. Consider defining an interface or type alias.',
		},
	},

	create(context) {
		/**
		 * Check if a node represents an inline type that should be flagged
		 */
		function isInlineType(typeNode) {
			if (!typeNode) return false;

			switch (typeNode.type) {
				// Object type literals: { foo: string, bar: number }
				case 'TSTypeLiteral':
					return true;

				// Union types with inline object types: string | { foo: bar }
				case 'TSUnionType':
					return typeNode.types.some(isInlineType);

				// Intersection types with inline object types: Base & { foo: bar }
				case 'TSIntersectionType':
					return typeNode.types.some(isInlineType);

				// Tuple types: [string, number]
				case 'TSTupleType':
					return true;

				// Mapped types: { [K in keyof T]: U }
				case 'TSMappedType':
					return true;

				// Conditional types: T extends U ? X : Y (inline)
				case 'TSConditionalType':
					return true;

				default:
					return false;
			}
		}

		/**
		 * Check if a method is public (not private or protected)
		 */
		function isPublicMethod(node) {
			// If no accessibility modifier is specified, it's public by default
			if (!node.accessibility) return true;
			return node.accessibility === 'public';
		}

		/**
		 * Check if a class is exported
		 */
		function isExportedClass(node) {
			// Check if the class declaration itself is exported
			if (node.parent && node.parent.type === 'ExportNamedDeclaration') {
				return true;
			}
			// Check if it's a default export
			if (node.parent && node.parent.type === 'ExportDefaultDeclaration') {
				return true;
			}
			return false;
		}

		return {
			MethodDefinition(node) {
				// Only check methods in exported classes
				const classNode = node.parent.parent; // MethodDefinition -> ClassBody -> ClassDeclaration
				if (!classNode || classNode.type !== 'ClassDeclaration' || !isExportedClass(classNode)) {
					return;
				}

				// Only check public methods
				if (!isPublicMethod(node)) {
					return;
				}

				// Check if the method has a return type annotation
				const functionNode = node.value;
				if (!functionNode.returnType) {
					return; // No explicit return type, skip
				}

				const returnTypeNode = functionNode.returnType.typeAnnotation;
				
				// Check if the return type is an inline type
				if (isInlineType(returnTypeNode)) {
					const methodName = node.key.type === 'Identifier' ? node.key.name : '<computed>';
					context.report({
						node: functionNode.returnType,
						messageId: 'inlineReturnType',
						data: {
							methodName: methodName,
						},
					});
				}
			},

			// Also check arrow function properties that are public methods
			PropertyDefinition(node) {
				// Only check properties in exported classes
				const classNode = node.parent.parent; // PropertyDefinition -> ClassBody -> ClassDeclaration
				if (!classNode || classNode.type !== 'ClassDeclaration' || !isExportedClass(classNode)) {
					return;
				}

				// Only check public methods
				if (!isPublicMethod(node)) {
					return;
				}

				// Check if the property is an arrow function
				if (node.value && node.value.type === 'ArrowFunctionExpression') {
					const arrowFunction = node.value;
					
					// Check if the arrow function has a return type annotation
					if (!arrowFunction.returnType) {
						return; // No explicit return type, skip
					}

					const returnTypeNode = arrowFunction.returnType.typeAnnotation;
					
					// Check if the return type is an inline type
					if (isInlineType(returnTypeNode)) {
						const methodName = node.key.type === 'Identifier' ? node.key.name : '<computed>';
						context.report({
							node: arrowFunction.returnType,
							messageId: 'inlineReturnType',
							data: {
								methodName: methodName,
							},
						});
					}
				}
			}
		};
	},
};