/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { InMemFileChange } from '../../common/file';
import { PullRequestModel } from '../../github/pullRequestModel';
import { MimeTypes, RepoToolBase } from './toolsUtils';

interface FetchNotificationToolParameters {
	thread_id: number;
}

interface FileChange {
	fileName: string;
	patch: string;
}

export interface FetchNotificationResult {
	lastReadAt?: string;
	lastUpdatedAt: string;
	unread: boolean;
	title: string;
	body: string;
	unreadComments: {
		body: string;
	}[];
	fileChanges?: FileChange[];
}

export class FetchNotificationTool extends RepoToolBase<FetchNotificationToolParameters> {

	async invoke(options: vscode.LanguageModelToolInvocationOptions<FetchNotificationToolParameters>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		const github = this.getGitHub();
		if (!github) {
			return undefined;
		}
		const thread = await github.octokit.api.activity.getThread({
			thread_id: options.parameters.thread_id
		});
		const threadData = thread.data;
		const issueNumber = threadData.subject.url.split('/').pop();
		if (issueNumber === undefined) {
			return undefined;
		}
		const lastUpdatedAt = threadData.updated_at;
		const lastReadAt = threadData.last_read_at ?? undefined;
		const unread = threadData.unread;
		const owner = threadData.repository.owner.login;
		const name = threadData.repository.name;
		const { folderManager } = this.getRepoInfo({ owner, name });
		const issueOrPR = await folderManager.resolveIssueOrPullRequest(owner, name, Number(issueNumber));
		if (!issueOrPR) {
			throw new Error(`No notification found with thread ID #${options.parameters.thread_id}.`);
		}
		const comments = issueOrPR.item.comments ?? [];
		let unreadComments: { body: string; }[];
		if (lastReadAt !== undefined && comments) {
			unreadComments = comments.filter(comment => {
				return comment.createdAt > lastReadAt;
			}).map(comment => { return { body: comment.body }; });
		} else {
			unreadComments = comments.map(comment => { return { body: comment.body }; });
		}
		const result: FetchNotificationResult = {
			lastReadAt,
			lastUpdatedAt,
			unread,
			unreadComments,
			title: issueOrPR.title,
			body: issueOrPR.body,
		};
		if (issueOrPR instanceof PullRequestModel) {
			const fileChanges = await issueOrPR.getFileChangesInfo();
			const fetchedFileChanges: FileChange[] = [];
			for (const fileChange of fileChanges) {
				if (fileChange instanceof InMemFileChange) {
					fetchedFileChanges.push({
						fileName: fileChange.fileName,
						patch: fileChange.patch
					});
				}
			}
			result.fileChanges = fetchedFileChanges;
		}
		return {
			[MimeTypes.textJson]: result
		};
	}
}