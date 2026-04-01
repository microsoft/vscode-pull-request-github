/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { PullRequestModel } from '../../github/pullRequestModel';
import { RepositoriesManager } from '../../github/repositoriesManager';

interface ResolveReviewThreadToolParameters {
	threadId: string;
}

export class ResolveReviewThreadTool implements vscode.LanguageModelTool<ResolveReviewThreadToolParameters> {
	public static readonly toolId = 'github-pull-request_resolveReviewThread';

	constructor(private readonly folderManagers: RepositoriesManager) { }

	private _findActivePullRequest(): PullRequestModel | undefined {
		const folderManager = this.folderManagers.folderManagers.find((manager) => manager.activePullRequest);
		return folderManager?.activePullRequest;
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ResolveReviewThreadToolParameters>): Promise<vscode.PreparedToolInvocation> {
		const pullRequest = this._findActivePullRequest();
		const threadId = options.input?.threadId;

		if (!pullRequest) {
			return {
				invocationMessage: vscode.l10n.t('Resolving review thread'),
			};
		}

		const thread = pullRequest.reviewThreadsCache.find(t => t.id === threadId);
		const file = thread?.path ? ` in \`${thread.path}\`` : '';
		const firstComment = thread?.comments[0]?.body;
		const snippet = firstComment ? `: "${firstComment.length > 60 ? firstComment.slice(0, 57) + '...' : firstComment}"` : '';

		return {
			invocationMessage: vscode.l10n.t('Resolving review thread{0}{1}', file, snippet),
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<ResolveReviewThreadToolParameters>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const pullRequest = this._findActivePullRequest();
		if (!pullRequest) {
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('There is no active pull request.')]);
		}

		const { threadId } = options.input;
		if (!threadId) {
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No threadId provided.')]);
		}

		const thread = pullRequest.reviewThreadsCache.find(t => t.id === threadId);
		if (!thread) {
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Review thread with id "${threadId}" not found on the active pull request.`)]);
		}

		if (thread.isResolved) {
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Review thread "${threadId}" is already resolved.`)]);
		}

		if (!thread.viewerCanResolve) {
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`You do not have permission to resolve review thread "${threadId}".`)]);
		}

		await pullRequest.resolveReviewThread(threadId);
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Review thread "${threadId}" resolved successfully.`)]);
	}
}
