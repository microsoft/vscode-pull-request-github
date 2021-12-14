/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { SinonSandbox, createSandbox } from 'sinon';
import { CredentialStore } from '../../github/credentials';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { ReviewCommentController } from '../../view/reviewCommentController';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { MockRepository } from '../mocks/mockRepository';
import { GitFileChangeNode } from '../../view/treeNodes/fileChangeNode';
import { PullRequestsTreeDataProvider } from '../../view/prsTreeDataProvider';
import { GitChangeType } from '../../common/file';
import { toReviewUri } from '../../common/uri';
import * as vscode from 'vscode';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { PullRequestModel } from '../../github/pullRequestModel';
import { Protocol } from '../../common/protocol';
import { Remote } from '../../common/remote';
import { GHPRCommentThread } from '../../github/prComment';
import { DiffLine } from '../../common/diffHunk';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';
import { GitApiImpl } from '../../api/api1';
import { DiffSide } from '../../common/comment';
import { ReviewManager, ShowPullRequest } from '../../view/reviewManager';
import { PullRequestChangesTreeDataProvider } from '../../view/prChangesTreeDataProvider';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockSessionState } from '../mocks/mockSessionState';
const schema = require('../../github/queries.gql');

const protocol = new Protocol('https://github.com/github/test.git');
const remote = new Remote('test', 'github/test', protocol);

class TestReviewCommentController extends ReviewCommentController {
	public workspaceFileChangeCommentThreads() {
		return this._workspaceFileChangeCommentThreads;
	}
}

describe('ReviewCommentController', function () {
	let sinon: SinonSandbox;
	let credentialStore: CredentialStore;
	let repository: MockRepository;
	let telemetry: MockTelemetry;
	let provider: PullRequestsTreeDataProvider;
	let manager: FolderRepositoryManager;
	let activePullRequest: PullRequestModel;
	let githubRepo: MockGitHubRepository;
	let reviewManager: ReviewManager;

	beforeEach(async function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);

		telemetry = new MockTelemetry();
		credentialStore = new CredentialStore(telemetry);

		repository = new MockRepository();
		repository.addRemote('origin', 'git@github.com:aaa/bbb');

		provider = new PullRequestsTreeDataProvider(telemetry);
		const context = new MockExtensionContext();
		manager = new FolderRepositoryManager(context, repository, telemetry, new GitApiImpl(), credentialStore, new MockSessionState());
		const tree = new PullRequestChangesTreeDataProvider(context);
		reviewManager = new ReviewManager(context, repository, manager, telemetry, tree, new ShowPullRequest(), new MockSessionState());
		sinon.stub(manager, 'createGitHubRepository').callsFake((r, cStore) => {
			return new MockGitHubRepository(r, cStore, telemetry, sinon);
		});
		sinon.stub(credentialStore, 'isAuthenticated').returns(false);
		await manager.updateRepositories();

		const pr = new PullRequestBuilder().build();
		githubRepo = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);
		activePullRequest = new PullRequestModel(
			telemetry,
			githubRepo,
			remote,
			convertRESTPullRequestToRawPullRequest(pr, githubRepo),
		);

		manager.activePullRequest = activePullRequest;
	});

	afterEach(function () {
		sinon.restore();
	});

	function createLocalFileChange(uri: vscode.Uri, fileName: string, rootUri: vscode.Uri): GitFileChangeNode {
		return new GitFileChangeNode(
			provider,
			manager,
			activePullRequest,
			{
				status: GitChangeType.MODIFY,
				fileName,
				blobUrl: 'https://example.com',
				diffHunks:
				[
					{
						oldLineNumber: 22,
						oldLength: 5,
						newLineNumber: 22,
						newLength: 11,
						positionInHunk: 0,
						diffLines: [
							new DiffLine(3, -1, -1, 0, '@@ -22,5 +22,11 @@', true),
							new DiffLine(0, 22, 22, 1, "     'title': 'Papayas',", true),
							new DiffLine(0, 23, 23, 2, "     'title': 'Papayas',", true),
							new DiffLine(0, 24, 24, 3, "     'title': 'Papayas',", true),
							new DiffLine(1, -1, 25, 4, '+  {', true),
							new DiffLine(1, -1, 26, 5, '+  {', true),
							new DiffLine(1, -1, 27, 6, '+  {', true),
							new DiffLine(1, -1, 28, 7, '+  {', true),
							new DiffLine(1, -1, 29, 8, '+  {', true),
							new DiffLine(1, -1, 30, 9, '+  {', true),
							new DiffLine(0, 25, 31, 10, '+  {', true),
							new DiffLine(0, 26, 32, 11, '+  {', true),
						],
					},
				]
			},
			uri,
			toReviewUri(uri, fileName, undefined, '1', false, { base: true }, rootUri),
			[],
			'abcd',
		);
	}

	function createGHPRCommentThread(threadId: string, uri: vscode.Uri): GHPRCommentThread {
		return {
			gitHubThreadId: threadId,
			uri,
			range: new vscode.Range(new vscode.Position(21, 0), new vscode.Position(21, 0)),
			comments: [],
			collapsibleState: vscode.CommentThreadCollapsibleState.Expanded,
			label: 'Start discussion',
			isResolved: false,
			canReply: false,
			dispose: () => {},
		};
	}

	describe('initializes workspace thread data', async function () {
		const fileName = 'data/products.json';
		const uri = vscode.Uri.parse(`${repository.rootUri.toString()}/${fileName}`);
		const localFileChanges = [createLocalFileChange(uri, fileName, repository.rootUri)];
		const reviewCommentController = new TestReviewCommentController(reviewManager, manager, repository, localFileChanges, new MockSessionState());

		sinon.stub(activePullRequest, 'validateDraftMode').returns(Promise.resolve(false));
		sinon.stub(activePullRequest, 'getReviewThreads').returns(
			Promise.resolve([
				{
					id: '1',
					isResolved: false,
					viewerCanResolve: false,
					viewerCanUnresolve: false,
					path: fileName,
					diffSide: DiffSide.RIGHT,
					line: 372,
					originalLine: 372,
					isOutdated: false,
					comments: [
						{
							id: 1,
							url: '',
							diffHunk: '',
							body: '',
							createdAt: '',
							htmlUrl: '',
							graphNodeId: '',
						}
					],
				},
			]),
		);

		sinon.stub(manager, 'getCurrentUser').returns({
			login: 'rmacfarlane',
			url: 'https://github.com/rmacfarlane',
		});

		sinon.stub(vscode.workspace, 'getWorkspaceFolder').returns({
			uri: repository.rootUri,
			name: '',
			index: 0,
		});

		await reviewCommentController.initialize();
		const workspaceFileChangeCommentThreads = reviewCommentController.workspaceFileChangeCommentThreads();
		assert.strictEqual(Object.keys(workspaceFileChangeCommentThreads).length, 1);
		assert.strictEqual(Object.keys(workspaceFileChangeCommentThreads)[0], fileName);
		assert.strictEqual(workspaceFileChangeCommentThreads[fileName].length, 1);
	});

	describe('createOrReplyComment', function () {
		it('creates a new comment on an empty thread in a local file', async function () {
			const fileName = 'data/products.json';
			const uri = vscode.Uri.parse(`${repository.rootUri.toString()}/${fileName}`);
			await activePullRequest.initializeReviewThreadCache();
			const localFileChanges = [createLocalFileChange(uri, fileName, repository.rootUri)];
			const reviewCommentController = new TestReviewCommentController(
				reviewManager,
				manager,
				repository,
				localFileChanges,
				new MockSessionState()
			);
			const thread = createGHPRCommentThread('review-1.1', uri);

			sinon.stub(activePullRequest, 'validateDraftMode').returns(Promise.resolve(false));
			sinon.stub(activePullRequest, 'getReviewThreads').returns(Promise.resolve([]));
			sinon.stub(activePullRequest, 'getPendingReviewId').returns(Promise.resolve(undefined));

			sinon.stub(manager, 'getCurrentUser').returns({
				login: 'rmacfarlane',
				url: 'https://github.com/rmacfarlane',
			});

			sinon.stub(vscode.workspace, 'getWorkspaceFolder').returns({
				uri: repository.rootUri,
				name: '',
				index: 0,
			});

			sinon.stub(vscode.workspace, 'asRelativePath').callsFake((pathOrUri: string | vscode.Uri): string => {
				const path = pathOrUri.toString();
				return path.substring('/root/'.length);
			});

			sinon.stub(repository, 'diffWith').returns(Promise.resolve(''));

			await reviewCommentController.initialize();
			const workspaceFileChangeCommentThreads = reviewCommentController.workspaceFileChangeCommentThreads();
			assert.strictEqual(Object.keys(workspaceFileChangeCommentThreads).length, 0);

			githubRepo.queryProvider.expectGraphQLMutation(
				{
					mutation: schema.AddReviewThread,
					variables: {
						input: {
							path: fileName,
							body: 'hello world',
							pullRequestId: activePullRequest.graphNodeId,
							pullRequestReviewId: undefined,
							line: 22,
							side: 'RIGHT'
						}
					}
				},
				{
					data: {
						addPullRequestReviewThread: {
							thread: {
								id: 1,
								isResolved: false,
								viewCanResolve: true,
								path: fileName,
								line: 22,
								originalLine: 22,
								diffSide: 'RIGHT',
								isOutdated: false,
								comments: {
									nodes: [
										{
											databaseId: 1,
											id: 1,
											body: 'hello world',
											commit: {},
											diffHunk: '',
											reactionGroups: [],
											author: {}
										}
									]
								}
							}
						}
					}
				}
			)

			await reviewCommentController.createOrReplyComment(thread, 'hello world', false);

			assert.strictEqual(thread.comments.length, 1);
			assert.strictEqual(thread.comments[0].parent, thread);

			assert.strictEqual(Object.keys(workspaceFileChangeCommentThreads).length, 1);
			assert.strictEqual(Object.keys(workspaceFileChangeCommentThreads)[0], fileName);
			assert.strictEqual(workspaceFileChangeCommentThreads[fileName].length, 1);
		});
	});
});
