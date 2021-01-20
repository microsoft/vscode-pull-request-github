/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert = require('assert');
import { SinonSandbox, createSandbox } from 'sinon';
import { CredentialStore } from '../../azdo/credentials';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { ReviewCommentController } from '../../view/reviewCommentController';
import { FolderRepositoryManager } from '../../azdo/folderRepositoryManager';
import { MockRepository } from '../mocks/mockRepository';
import { GitFileChangeNode, RemoteFileChangeNode } from '../../view/treeNodes/fileChangeNode';
import { PullRequestsTreeDataProvider } from '../../view/prsTreeDataProvider';
import { GitChangeType } from '../../common/file';
import { toReviewUri } from '../../common/uri';
import * as vscode from 'vscode';
import { convertAzdoPullRequestToRawPullRequest } from '../../azdo/utils';
import { PullRequestModel } from '../../azdo/pullRequestModel';
import { AzdoRepository } from '../../azdo/azdoRepository';
import { Protocol } from '../../common/protocol';
import { Remote } from '../../common/remote';
import { GHPRCommentThread } from '../../azdo/prComment';
import { DiffLine } from '../../common/diffHunk';
import { GitApiImpl } from '../../api/api1';
import { createFakeSecretStorage } from '../mocks/mockExtensionContext';
import { MockAzdoRepository } from '../mocks/mockAzdoRepository';
import { GitPullRequest, GitPullRequestCommentThread, Comment, CommentType, CommentThreadStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { createMock } from 'ts-auto-mock';
import { Repository } from '../../api/api';
import { CommentPermissions } from '../../azdo/interface';
import { CommonCommentHandler } from '../../common/commonCommentHandler';

const protocol = new Protocol('https://github.com/github/test.git');
const remote = new Remote('test', 'github/test', protocol);

class TestReviewCommentController extends ReviewCommentController {
	/**
	 *
	 */
	constructor(
		_reposManager: FolderRepositoryManager,
		_repository: Repository,
		_localFileChanges: GitFileChangeNode[],
		_obsoleteFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[],
		_comments: GitPullRequestCommentThread[],
		_getCommentPermissions: (comment: Comment) => CommentPermissions,
		commonCommentHandler: CommonCommentHandler) {
		super(_reposManager, _repository, _localFileChanges, _obsoleteFileChanges, _comments, _getCommentPermissions);
		this._commonCommentHandler = commonCommentHandler;
	}
	public workspaceFileChangeCommentThreads() {
		return this._workspaceFileChangeCommentThreads;
	}

	public buildCommonCommentHandler(handler: CommonCommentHandler) {
		this._commonCommentHandler = handler;
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

	beforeEach(async function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);

		telemetry = new MockTelemetry();
		credentialStore = new CredentialStore(telemetry, createFakeSecretStorage());

		repository = new MockRepository();
		repository.addRemote('origin', 'git@dev.azure.com.com:aaa/aaa/bbb_git/bbb');

		provider = new PullRequestsTreeDataProvider(telemetry);
		manager = new FolderRepositoryManager(repository, telemetry, new GitApiImpl(), credentialStore);
		sinon.stub(manager, 'createGitHubRepository').callsFake((r, cStore) => {
			return new MockAzdoRepository(r, cStore, telemetry, sinon);
		});
		sinon.stub(credentialStore, 'isAuthenticated').returns(false);
		await manager.updateRepositories();

		const pr = createMock<GitPullRequest>();
		const repo = new AzdoRepository(remote, credentialStore, telemetry);
		activePullRequest = new PullRequestModel(telemetry, repo, remote, await convertAzdoPullRequestToRawPullRequest(pr, repo));

		manager.activePullRequest = activePullRequest;
	});

	afterEach(function () {
		sinon.restore();
	});

	function createLocalFileChange(uri: vscode.Uri, fileName: string, rootUri: vscode.Uri): GitFileChangeNode {
		return new GitFileChangeNode(
			provider.view,
			activePullRequest as any,
			GitChangeType.MODIFY,
			fileName,
			'https://example.com',
			uri,
			toReviewUri(uri, fileName, undefined, '1', false, { base: true }, rootUri),
			[
				{
					oldLineNumber: 22,
					oldLength: 5,
					newLineNumber: 22,
					newLength: 11,
					positionInHunk: 0,
					diffLines: [
						new DiffLine(3, -1, -1, 0, '@@ -22,5 +22,11 @@', true),
						new DiffLine(0, 22, 22, 1, '     \'title\': \'Papayas\',', true),
						new DiffLine(0, 23, 23, 2, '     \'title\': \'Papayas\',', true),
						new DiffLine(0, 24, 24, 3, '     \'title\': \'Papayas\',', true),
						new DiffLine(1, -1, 25, 4, '+  {', true),
						new DiffLine(1, -1, 26, 5, '+  {', true),
						new DiffLine(1, -1, 27, 6, '+  {', true),
						new DiffLine(1, -1, 28, 7, '+  {', true),
						new DiffLine(1, -1, 29, 8, '+  {', true),
						new DiffLine(1, -1, 30, 9, '+  {', true),
						new DiffLine(0, 25, 31, 10, '+  {', true),
						new DiffLine(0, 26, 32, 11, '+  {', true)
					],
				}],
			[],
			'abcd'
		);
	}

	function createGHPRCommentThread(threadId: string, uri: vscode.Uri): GHPRCommentThread {
		return {
			threadId: Number.parseInt(threadId),
			uri,
			range: new vscode.Range(new vscode.Position(21, 0), new vscode.Position(21, 0)),
			comments: [],
			collapsibleState: vscode.CommentThreadCollapsibleState.Expanded,
			label: 'Start discussion',
			canReply: false,
			dispose: () => { },
			rawThread: createMock<GitPullRequestCommentThread>()
		};
	}

	describe('createOrReplyComment', function () {
		it('creates a new comment on an empty thread in a local file', async function () {
			const fileName = 'data/products.json';
			const uri = vscode.Uri.parse(`${repository.rootUri.toString()}/${fileName}`);
			const localFileChanges = [createLocalFileChange(uri, fileName, repository.rootUri)];
			const commonCommentHandler = new CommonCommentHandler(manager.activePullRequest!, manager);
			const reviewCommentController = new TestReviewCommentController(manager, repository, localFileChanges, [], [], undefined as any, commonCommentHandler);
			const thread = createGHPRCommentThread('review-1.1', uri);

			// sinon.stub(activePullRequest, 'validateDraftMode').returns(Promise.resolve(false));

			sinon.stub(manager, 'getCurrentUser').returns({
				email: 'alias@microsoft.com',
				id: '111-222-333-444',
				url: 'https://github.com/rmacfarlane',
			});

			sinon.stub(activePullRequest, 'createThread').resolves({
				id: 1,
				comments: [{ id: 1, commentType: CommentType.Text, content: 'text'}],
				status: CommentThreadStatus.Active
			});

			sinon.stub(vscode.workspace, 'getWorkspaceFolder').returns({
				uri: repository.rootUri,
				name: '',
				index: 0
			});

			sinon.stub(vscode.workspace, 'asRelativePath').callsFake((pathOrUri: string | vscode.Uri): string => {
				const path = pathOrUri.toString();
				return path.substring('/root/'.length);
			});

			sinon.stub(repository, 'diffWith').returns(Promise.resolve(''));

			const replaceCommentSpy = sinon.spy(commonCommentHandler, 'replaceTemporaryComment');

			await reviewCommentController.initialize();
			const workspaceFileChangeCommentThreads = reviewCommentController.workspaceFileChangeCommentThreads();
			assert.strictEqual(Object.keys(workspaceFileChangeCommentThreads).length, 1);
			assert.strictEqual(Object.keys(workspaceFileChangeCommentThreads)[0], fileName);
			assert.strictEqual(workspaceFileChangeCommentThreads[fileName].length, 0);

			await reviewCommentController.createOrReplyComment(thread, 'hello world');

			assert.strictEqual(thread.comments.length, 1);
			assert(replaceCommentSpy.calledOnce);
			assert.strictEqual(thread.comments[0].parent, thread);

			assert.strictEqual(Object.keys(workspaceFileChangeCommentThreads).length, 1);
			assert.strictEqual(Object.keys(workspaceFileChangeCommentThreads)[0], fileName);
			assert.strictEqual(workspaceFileChangeCommentThreads[fileName].length, 1);
		});
	});
});