/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { realpathSync } from 'fs';

/**
 * Returns `path` with symlinks resolved, or `undefined` if it can't be resolved.
 */
export function realpath(path: string): string | undefined {
	try {
		return realpathSync.native(path);
	} catch {
		return undefined;
	}
}
