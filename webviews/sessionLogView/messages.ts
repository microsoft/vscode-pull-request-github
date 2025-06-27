/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SessionPullInfo } from '../../src/common/timelineEvent';
import { SessionInfo } from './sessionsApi';

export type PullInfo = SessionPullInfo & {
	title: string;
};

export interface InitMessage {
	type: 'init';
	sessionId: string;
	pullInfo: PullInfo | undefined;
	themeData: any;
}

export interface LoadedMessage {
	type: 'loaded';
	info: SessionInfo;
	logs: string;
}

export interface UpdateMessage {
	type: 'update';
	info: SessionInfo;
	logs: string;
}

export interface ChangeThemeMessage {
	type: 'changeTheme';
	themeData: any;
}

export interface WebviewState {
	readonly sessionId: string;
	readonly pullInfo: PullInfo | undefined;
}