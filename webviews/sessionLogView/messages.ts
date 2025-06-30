/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SessionLinkInfo } from '../../src/common/timelineEvent';
import { SessionInfo } from './sessionsApi';

export type PullInfo = SessionLinkInfo & {
	title: string;
};

export interface InitMessage {
	type: 'init';
	themeData: any;
}

export interface LoadedMessage {
	type: 'loaded';
	pullInfo: PullInfo | undefined;
	info: SessionInfo;
	logs: string;
}

export interface UpdateMessage {
	type: 'update';
	pullInfo: PullInfo | undefined;
	info: SessionInfo;
	logs: string;
}

export interface ResetMessage {
	type: 'reset';
}

export interface ChangeThemeMessage {
	type: 'changeTheme';
	themeData: any;
}

export interface ErrorMessage {
	type: 'error';
	logsWebLink: string | undefined;
}

export interface WebviewState {
	readonly sessionId: string;
	readonly pullInfo: PullInfo | undefined;
}