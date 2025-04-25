/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { InMemFileChange } from '../../common/file';
import { PullRequestModel } from '../../github/pullRequestModel';
import { getNotificationKey } from '../../github/utils';
import { RepoToolBase } from './toolsUtils';

interface FetchNotificationToolParameters {
	thread_id?: number;
}

interface FileChange {
	fileName?: string;
	patch?: string;
}

export interface FetchNotificationResult {
	lastReadAt?: string;
	lastUpdatedAt?: string;
	unread?: boolean;
	title?: string;
	body?: string;
	comments?: {
		author?: string;
		body?: string;
	}[];
	owner?: string;
	repo?: string;
	itemNumber?: string;
	itemType?: 'issue' | 'pr';
	fileChanges?: FileChange[];
	threadId?: number,
	notificationKey?: string
}

export class FetchNotificationTool extends RepoToolBase<FetchNotificationToolParameters> {
	public static readonly toolId = 'github-pull-request_notification_fetch';

	async prepareInvocation(_options: vscode.LanguageModelToolInvocationPrepareOptions<FetchNotificationToolParameters>): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: vscode.l10n.t('Fetching notification from GitHub')
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<FetchNotificationToolParameters>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		const github = this.getGitHub();
		if (!github) {
			return undefined;
		}
		const threadId = options.input.thread_id;
		if (threadId === undefined) {
			return undefined;
		}
		const thread = await github.octokit.api.activity.getThread({
			thread_id: threadId
		});
		const threadData = thread.data;
		const itemNumber = threadData.subject.url.split('/').pop();
		if (itemNumber === undefined) {
			return undefined;
		}
		const lastUpdatedAt = threadData.updated_at;
		const lastReadAt = threadData.last_read_at ?? undefined;
		const unread = threadData.unread;
		const owner = threadData.repository.owner.login;
		const name = threadData.repository.name;
		const { folderManager } = await this.getRepoInfo({ owner, name });
		const issueOrPR = await folderManager.resolveIssueOrPullRequest(owner, name, Number(itemNumber));
		if (!issueOrPR) {
			throw new Error(`No notification found with thread ID #${threadId}.`);
		}
		const itemType = issueOrPR instanceof PullRequestModel ? 'pr' : 'issue';
		const notificationKey = getNotificationKey(owner, name, String(issueOrPR.number));
		const itemComments = issueOrPR.item.comments ?? [];
		let comments: { body: string; author: string }[];
		if (lastReadAt !== undefined && itemComments) {
			comments = itemComments.filter(comment => {
				return comment.createdAt > lastReadAt;
			}).map(comment => { return { body: comment.body, author: comment.author.login }; });
		} else {
			comments = itemComments.map(comment => { return { body: comment.body, author: comment.author.login }; });
		}
		const result: FetchNotificationResult = {
			lastReadAt,
			lastUpdatedAt,
			unread,
			comments,
			threadId,
			notificationKey,
			title: issueOrPR.title,
			body: issueOrPR.body,
			owner,
			repo: name,
			itemNumber,
			itemType
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
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result)),
		new vscode.LanguageModelTextPart('Above is a stringified JSON representation of the notification. This can be passed to other tools for further processing or display.')
		]);
	}

}