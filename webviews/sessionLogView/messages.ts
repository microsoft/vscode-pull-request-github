/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SessionInfo } from './sessionsApi';

export interface InitMessage {
	type: 'init';
	info: SessionInfo;
	logs: string;
	themeData: any;
}

export interface ChangeThemeMessage {
	type: 'changeTheme';
	themeData: any;
}
