/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { FetchIssueResult } from './fetchIssueTool';
import { FetchNotificationResult } from './fetchNotificationTool';
import { MimeTypes } from './toolsUtils';

export class NotificationSummarizationTool implements vscode.LanguageModelTool<FetchNotificationResult> {

	async invoke(options: vscode.LanguageModelToolInvocationOptions<FetchIssueResult>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		console.log('options : ', options);
		return {
			[MimeTypes.textPlain]: ''
		};
	}
}