/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox } from 'sinon';
import * as vscode from 'vscode';

import { CredentialStore } from '../../../github/credentials';
import { FolderRepositoryManager } from '../../../github/folderRepositoryManager';
import { GitHubRepository } from '../../../github/githubRepository';
import { AccountType, Issue } from '../../../github/interface';
import { RepositoriesManager } from '../../../github/repositoriesManager';
import { SearchTool, SearchToolResult } from '../../../lm/tools/searchTools';

describe('SearchTool', function () {
	let sinon: SinonSandbox;

	beforeEach(function () {
		sinon = createSandbox();
	});

	afterEach(function () {
		sinon.restore();
	});

	it('uses the explicit repository when the query has a repository qualifier', async function () {
		const tool = new SearchTool({} as CredentialStore, {} as RepositoriesManager);

		const invocation = await tool.prepareInvocation({
			input: {
				repo: { owner: 'microsoft', name: 'vscode' },
				query: 'is:open repo:other/repository',
			},
		});

		const message = invocation.invocationMessage as vscode.MarkdownString;
		assert.strictEqual(message.value.includes('repo:microsoft/vscode'), true);
		assert.strictEqual(message.value.includes('repo:other/repository'), false);
	});

	it('searches the explicit repository when it is not an active workspace remote', async function () {
		const credentialStore = sinon.createStubInstance(CredentialStore);
		credentialStore.isAnyAuthenticated.returns(true);
		const repositoriesManager = sinon.createStubInstance(RepositoriesManager);
		const folderManager = sinon.createStubInstance(FolderRepositoryManager);
		const githubRepository = sinon.createStubInstance(GitHubRepository);
		const issue: Issue = {
			id: 332663,
			graphNodeId: 'I_332663',
			title: 'Known matching issue',
			titleHTML: 'Known matching issue',
			body: '',
			url: 'https://github.com/microsoft/vscode/issues/332663',
			number: 332663,
			labels: [],
			state: 'OPEN',
			assignees: [{ login: 'jruales', id: 'jruales', url: 'https://github.com/jruales', accountType: AccountType.User }],
			createdAt: '2026-09-01T00:00:00Z',
			updatedAt: '2026-09-07T00:00:00Z',
			user: { login: 'author', id: 'author', url: 'https://github.com/author', accountType: AccountType.User },
			commentCount: 0,
			reactionCount: 0,
			reactions: [],
		};

		repositoriesManager.getManagerForRepository.returns(folderManager as unknown as FolderRepositoryManager);
		folderManager.findExistingGitHubRepository.returns(githubRepository as unknown as GitHubRepository);
		githubRepository.getIssues.resolves({
			items: [issue],
			hasMorePages: false,
			totalCount: 1,
		});

		const tokenSource = new vscode.CancellationTokenSource();
		const result = await new SearchTool(
			credentialStore as unknown as CredentialStore,
			repositoriesManager as unknown as RepositoriesManager,
		).invoke({
			input: {
				repo: { owner: 'microsoft', name: 'vscode' },
				query: 'is:issue is:open assignee:jruales',
			},
			toolInvocationToken: undefined,
		}, tokenSource.token);
		tokenSource.dispose();

		assert.strictEqual(githubRepository.getIssues.calledOnceWith(
			undefined,
			'is:issue is:open assignee:jruales repo:microsoft/vscode',
		), true);
		assert.strictEqual(folderManager.getIssues.notCalled, true);
		const searchResult = JSON.parse((result!.content[0] as vscode.LanguageModelTextPart).value) as SearchToolResult;
		assert.strictEqual(searchResult.totalIssues, 1);
		assert.strictEqual(searchResult.arrayOfIssues![0].number, 332663);
	});
});
