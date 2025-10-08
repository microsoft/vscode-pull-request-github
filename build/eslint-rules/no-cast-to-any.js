/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

module.exports = {

	create(context) {
		return {
			'TSTypeAssertion[typeAnnotation.type="TSAnyKeyword"], TSAsExpression[typeAnnotation.type="TSAnyKeyword"]': (node) => {
				context.report({
					node,
					message: `Avoid casting to 'any' type. Consider using a more specific type or type guards for better type safety.`
				});
			}
		};
	}
};