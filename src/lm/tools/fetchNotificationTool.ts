/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { MimeTypes, RepoToolBase } from './toolsUtils';

interface FetchNotificationToolParameters {
	thread_id: number;
	repo?: {
		owner: string;
		name: string;
	};
}

interface FileChange {
	fileName: string;
	patch: string;
}

export interface FetchNotificationResult {
	title: string;
	body: string;
	comments: {
		body: string;
	}[];
	fileChanges?: FileChange[];
}

export class FetchNotificationTool extends RepoToolBase<FetchNotificationToolParameters> {

	async invoke(options: vscode.LanguageModelToolInvocationOptions<FetchNotificationToolParameters>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		console.log('options : ', options);

		const github = this.getGitHub();
		if (!github) {
			return undefined;
		}
		const thread = await github.octokit.api.activity.getThread({
			thread_id: options.parameters.thread_id
		});
		console.log('thread : ', thread);
		const result = '';
		return {
			[MimeTypes.textPlain]: JSON.stringify(result),
			[MimeTypes.textJson]: result
		};
	}
}