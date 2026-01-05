/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox } from 'sinon';

import { FolderRepositoryManager, titleAndBodyFrom } from '../../github/folderRepositoryManager';
import { MockRepository } from '../mocks/mockRepository';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { PullRequestModel } from '../../github/pullRequestModel';
import { GitHubRemote, Remote } from '../../common/remote';
import { Protocol } from '../../common/protocol';
import { GitHubRepository } from '../../github/githubRepository';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { GitApiImpl } from '../../api/api1';
import { CredentialStore } from '../../github/credentials';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { Uri } from 'vscode';
import { GitHubServerType } from '../../common/authentication';
import { CreatePullRequestHelper } from '../../view/createPullRequestHelper';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { MockThemeWatcher } from '../mocks/mockThemeWatcher';

describe('PullRequestManager', function () {
	let sinon: SinonSandbox;
	let manager: FolderRepositoryManager;
	let telemetry: MockTelemetry;
	let mockThemeWatcher: MockThemeWatcher;

	beforeEach(function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);

		telemetry = new MockTelemetry();
		mockThemeWatcher = new MockThemeWatcher();
		const repository = new MockRepository();
		const context = new MockExtensionContext();
		const credentialStore = new CredentialStore(telemetry, context);
		const repositoriesManager = new RepositoriesManager(credentialStore, telemetry);
		manager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(repositoriesManager), credentialStore, new CreatePullRequestHelper(), mockThemeWatcher);
	});

	afterEach(function () {
		sinon.restore();
	});

	describe('activePullRequest', function () {
		it('gets and sets the active pull request', function () {
			assert.strictEqual(manager.activePullRequest, undefined);

			const changeFired = sinon.spy();
			manager.onDidChangeActivePullRequest(changeFired);

			const url = 'https://github.com/aaa/bbb.git';
			const protocol = new Protocol(url);
			const remote = new GitHubRemote('origin', url, protocol, GitHubServerType.GitHubDotCom);
			const rootUri = Uri.file('C:\\users\\test\\repo');
			const repository = new GitHubRepository(1, remote, rootUri, manager.credentialStore, telemetry);
			const prItem = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().build(), repository);
			const pr = new PullRequestModel(manager.credentialStore, telemetry, repository, remote, prItem);

			manager.activePullRequest = pr;
			assert(changeFired.called);
			assert.deepStrictEqual(manager.activePullRequest, pr);
		});
	});
});

describe('titleAndBodyFrom', function () {
	it('separates title and body', async function () {
		const message = Promise.resolve('title\n\ndescription 1\n\ndescription 2\n');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, 'description 1\n\ndescription 2');
	});

	it('returns only title with no body', async function () {
		const message = Promise.resolve('title');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, '');
	});

	it('returns only title when body contains only whitespace', async function () {
		const message = Promise.resolve('title\n\n');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, '');
	});

	it('unwraps wrapped lines in body', async function () {
		const message = Promise.resolve('title\n\nThis is a long line that has been wrapped at 72 characters\nto fit the conventional commit message format.');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, 'This is a long line that has been wrapped at 72 characters to fit the conventional commit message format.');
	});

	it('preserves blank lines as paragraph breaks', async function () {
		const message = Promise.resolve('title\n\nFirst paragraph that is wrapped\nacross multiple lines.\n\nSecond paragraph that is also wrapped\nacross multiple lines.');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, 'First paragraph that is wrapped across multiple lines.\n\nSecond paragraph that is also wrapped across multiple lines.');
	});

	it('preserves list items', async function () {
		const message = Promise.resolve('title\n\n- First item\n- Second item\n- Third item');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, '- First item\n- Second item\n- Third item');
	});

	it('preserves numbered list items', async function () {
		const message = Promise.resolve('title\n\n1. First item\n2. Second item\n3. Third item');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, '1. First item\n2. Second item\n3. Third item');
	});

	it('preserves indented lines', async function () {
		const message = Promise.resolve('title\n\nNormal paragraph.\n\n    Indented code block\n    More code');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, 'Normal paragraph.\n\n    Indented code block\n    More code');
	});

	it('unwraps but preserves asterisk list items', async function () {
		const message = Promise.resolve('title\n\n* First item\n* Second item');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, '* First item\n* Second item');
	});

	it('handles mixed content with wrapped paragraphs and lists', async function () {
		const message = Promise.resolve('title\n\nThis is a paragraph that has been wrapped\nat 72 characters.\n\n- Item 1\n- Item 2\n\nAnother wrapped paragraph\nthat continues here.');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, 'This is a paragraph that has been wrapped at 72 characters.\n\n- Item 1\n- Item 2\n\nAnother wrapped paragraph that continues here.');
	});

	it('preserves lines with special characters at the start', async function () {
		const message = Promise.resolve('title\n\n> Quote line 1\n> Quote line 2');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, '> Quote line 1\n> Quote line 2');
	});

	it('handles wrapped lines with punctuation', async function () {
		const message = Promise.resolve('title\n\nThis is a sentence.\nThis is another sentence on a new line.');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, 'This is a sentence. This is another sentence on a new line.');
	});

	it('preserves fenced code blocks', async function () {
		const message = Promise.resolve('title\n\nSome text before.\n\n```\ncode line 1\ncode line 2\n```\n\nSome text after.');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, 'Some text before.\n\n```\ncode line 1\ncode line 2\n```\n\nSome text after.');
	});

	it('preserves fenced code blocks with language', async function () {
		const message = Promise.resolve('title\n\nSome text.\n\n```javascript\nconst x = 1;\nconst y = 2;\n```\n\nMore text.');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, 'Some text.\n\n```javascript\nconst x = 1;\nconst y = 2;\n```\n\nMore text.');
	});

	it('preserves nested list items with proper indentation', async function () {
		const message = Promise.resolve('title\n\n- Item 1\n  - Nested item 1.1\n  - Nested item 1.2\n- Item 2');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, '- Item 1\n  - Nested item 1.1\n  - Nested item 1.2\n- Item 2');
	});

	it('preserves list item continuations', async function () {
		const message = Promise.resolve('title\n\n- This is a list item that is long\n  and continues on the next line\n- Second item');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, '- This is a list item that is long\n  and continues on the next line\n- Second item');
	});

	it('preserves indented code blocks but not list continuations', async function () {
		const message = Promise.resolve('title\n\nRegular paragraph.\n\n    This is code\n    More code\n\nAnother paragraph.');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, 'Regular paragraph.\n\n    This is code\n    More code\n\nAnother paragraph.');
	});

	it('unwraps regular text but preserves list item continuations', async function () {
		const message = Promise.resolve('title\n\nThis is wrapped text\nthat should be joined.\n\n- List item with\n  continuation\n- Another item');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, 'This is wrapped text that should be joined.\n\n- List item with\n  continuation\n- Another item');
	});

	it('handles complex nested lists with wrapped paragraphs', async function () {
		const message = Promise.resolve('title\n\nWrapped paragraph\nacross lines.\n\n- Item 1\n  - Nested item\n    More nested content\n- Item 2\n\nAnother wrapped paragraph\nhere.');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, 'Wrapped paragraph across lines.\n\n- Item 1\n  - Nested item\n    More nested content\n- Item 2\n\nAnother wrapped paragraph here.');
	});
});
