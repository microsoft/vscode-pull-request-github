/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { API } from '../api/api';
import { LiveShareManager } from './vsls';

export function registerLiveShareGitProvider(apiImpl: API): LiveShareManager {
	const liveShareManager = new LiveShareManager(apiImpl);
	return liveShareManager;
}