/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

exports.rules = {
	'public-methods-well-defined-types': require('./public-methods-well-defined-types'),
	'no-any-except-union-method-signature': require('./no-any-except-union-method-signature'),
	'no-pr-in-user-strings': require('./no-pr-in-user-strings'),
};