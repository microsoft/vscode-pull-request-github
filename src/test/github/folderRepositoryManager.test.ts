/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';

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
import { GitApiImpl, RefType } from '../../api/api1';
import { CredentialStore } from '../../github/credentials';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { commands, env, MessageItem, MessageOptions, Uri, window, workspace } from 'vscode';
import { GitHubServerType } from '../../common/authentication';
import { CreatePullRequestHelper } from '../../view/createPullRequestHelper';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { MockThemeWatcher } from '../mocks/mockThemeWatcher';
import { PullRequestReviewCommon, ReviewContext } from '../../github/pullRequestReviewCommon';
import { IRequestMessage } from '../../common/webview';
import { PullRequestMergeability } from '../../github/interface';
import { PullRequest } from '../../github/views';

describe('PullRequestManager', function () {
	let sinon: SinonSandbox;
	let manager: FolderRepositoryManager;
	let telemetry: MockTelemetry;
	let mockThemeWatcher: MockThemeWatcher;
	let repository: MockRepository;

	beforeEach(function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);

		telemetry = new MockTelemetry();
		mockThemeWatcher = new MockThemeWatcher();
		repository = new MockRepository();
		const context = new MockExtensionContext();
		const credentialStore = new CredentialStore(telemetry, context);
		const repositoriesManager = new RepositoriesManager(credentialStore, telemetry);
		manager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(repositoriesManager), credentialStore, new CreatePullRequestHelper(), mockThemeWatcher);
	});

	afterEach(function () {
		sinon.restore();
	});

	describe('updateRepositories', function () {
		it('skips a repository after a 404 without affecting healthy repositories', async function () {
			const inaccessibleUrl = 'https://github.com/owner/missing';
			const inaccessibleRemote = new GitHubRemote('origin', inaccessibleUrl, new Protocol(inaccessibleUrl), GitHubServerType.GitHubDotCom);
			const inaccessibleRepository = new GitHubRepository(1, inaccessibleRemote, repository.rootUri, manager.credentialStore, telemetry, true);
			const inaccessibleMetadata = sinon.stub(inaccessibleRepository as any, 'getMetadataForRepo').rejects(Object.assign(new Error('Not Found'), { status: 404 }));
			const healthyUrl = 'https://github.com/owner/healthy';
			const healthyRemote = new GitHubRemote('upstream', healthyUrl, new Protocol(healthyUrl), GitHubServerType.GitHubDotCom);
			const healthyRepository = new GitHubRepository(2, healthyRemote, repository.rootUri, manager.credentialStore, telemetry, true);
			const healthyMetadata = sinon.stub(healthyRepository as any, 'getMetadataForRepo').resolves({ clone_url: healthyUrl } as never);
			sinon.stub(manager.credentialStore, 'isAuthenticated').returns(true);
			sinon.stub(manager.credentialStore, 'isAnyAuthenticated').returns(true);
			sinon.stub(manager as any, 'getActiveRemotes').resolves([inaccessibleRemote, healthyRemote] as never);
			sinon.stub(manager as any, 'createAndAddGitHubRepository').callsFake(async (remote: Remote) => remote.remoteName === 'origin' ? inaccessibleRepository : healthyRepository);
			sinon.stub(manager as any, 'checkIfMissingUpstream').resolves(false as never);
			sinon.stub(manager as any, 'associateLocalBranchesWithPRsOnFirstActivation').resolves();
			sinon.stub(manager, 'getAssignableUsers').resolves({});

			await manager.updateRepositories();
			await manager.updateRepositories();

			assert.deepStrictEqual(manager.gitHubRepositories, [healthyRepository]);
			assert.strictEqual(inaccessibleMetadata.calledOnce, true);
			assert.strictEqual(healthyMetadata.calledOnce, true);
			assert.strictEqual((manager as any)._sessionIgnoredRemoteNames.has('origin'), true);
			assert.strictEqual((manager as any)._inaccessibleRepos.has('owner/missing'), true);
			assert.strictEqual((inaccessibleRepository as any)._isDisposed, true);
			await assert.rejects(
				manager.createGitHubRepository(inaccessibleRemote, manager.credentialStore),
				/Repository owner\/missing is not accessible\./,
			);
		});
	});

	describe('getPullRequestDefaults', function () {
		it('uses a GitHub remote when the branch tracks a local sibling branch', async function () {
			const url = 'https://github.com/owner/repo.git';
			const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
			const githubRepository = new GitHubRepository(1, remote, repository.rootUri, manager.credentialStore, telemetry);
			(manager as any)._githubRepositories = [githubRepository];
			sinon.stub(githubRepository, 'getMetadata').resolves({
				owner: { login: 'owner' },
				name: 'repo',
				default_branch: 'main',
			} as any);

			const defaults = await manager.getPullRequestDefaults({
				type: RefType.Head,
				name: 'feature-b',
				upstream: {
					remote: '.',
					name: 'feature-a',
				},
			});

			assert.deepStrictEqual(defaults, {
				owner: 'owner',
				repo: 'repo',
				base: 'main',
			});
		});
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

	describe('tryMergeBaseIntoHead', function () {
		it('updates a conflict-free pull request that is not checked out using GraphQL', async function () {
			const url = 'https://github.com/aaa/bbb.git';
			const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
			const repository = new GitHubRepository(1, remote, Uri.file('C:\\users\\test\\repo'), manager.credentialStore, telemetry);
			const prItem = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().build(), repository);
			const pr = new PullRequestModel(manager.credentialStore, telemetry, repository, remote, prItem);
			sinon.stub(manager, 'isHeadUpToDateWithBase').resolves(false);
			const updateBranchWithGraphQL = sinon.stub(pr, 'updateBranchWithGraphQL').resolves(true);
			const updateBranch = sinon.stub(pr, 'updateBranch').resolves(true);

			const result = await manager.tryMergeBaseIntoHead(pr, true);

			assert.strictEqual(result, true);
			assert.strictEqual(updateBranchWithGraphQL.calledOnce, true);
			assert.strictEqual(updateBranch.notCalled, true);
		});
	});

	describe('updateBranch', function () {
		it('reports that the branch is up to date after a successful update', async function () {
			const url = 'https://github.com/aaa/bbb.git';
			const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
			const repository = new GitHubRepository(1, remote, Uri.file('C:\\users\\test\\repo'), manager.credentialStore, telemetry);
			const prItem = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().build(), repository);
			const pr = new PullRequestModel(manager.credentialStore, telemetry, repository, remote, prItem);
			sinon.stub(manager, 'tryMergeBaseIntoHead').resolves(true);
			sinon.stub(pr, 'getMergeability').resolves({ mergeability: PullRequestMergeability.Mergeable });
			let reply: Partial<PullRequest> | undefined;
			const context: ReviewContext = {
				item: pr,
				folderRepositoryManager: manager,
				existingReviewers: [],
				postMessage: sinon.stub().resolves(),
				replyMessage: (_message, response) => reply = response,
				throwError: sinon.stub(),
				getTimeline: sinon.stub().resolves([]),
			};
			const message: IRequestMessage<string> = { req: '1', command: 'pr.update-branch', args: '' };

			await PullRequestReviewCommon.updateBranch(context, message, sinon.stub().resolves());

			assert.strictEqual(reply?.canUpdateBranch, false);
			assert.strictEqual(reply?.mergeable, PullRequestMergeability.Mergeable);
		});
	});

	describe('deleteBranches', function () {
		const noopProgress = { report: () => { } };

		it('removes leftover branch config after deleting a branch', async function () {
			await repository.createBranch('feature', false, 'commit-hash');
			await repository.setConfig('branch.feature.github-pr-base-branch', 'owner#repo#main');
			await repository.setConfig('branch.feature.vscode-merge-base', 'origin/main');
			await repository.setConfig('branch.feature.remote', 'origin');
			await repository.setConfig('branch.feature.merge', 'refs/heads/feature');
			await repository.setConfig('branch.feature.github-pr-owner-number', 'owner#repo#1');
			await repository.setConfig('branch.feature.github-pr-owner-number', 'owner#repo#1');
			await repository.setConfig('branch.feature.github-pr-owner-number', 'owner#repo#1');
			await repository.setConfig('branch.feature.github-pr-owner-number', 'owner#repo#1');
			repository.preserveConfigOnNextBranchDelete = true;

			const nonExistant = new Set<string>();
			await (manager as any).deleteBranches([{ label: 'feature' }], nonExistant, noopProgress, 1, 0, []);

			const configs = await repository.getConfigs();
			assert.strictEqual(configs.filter(c => c.key.startsWith('branch.feature.')).length, 0);
			assert.strictEqual(nonExistant.has('feature'), false);
		});

		it('removes leftover branch config for a branch that no longer exists', async function () {
			// The branch ref is already gone, but stale [branch "gone"] config remains.
			await repository.setConfig('branch.gone.remote', 'origin');
			await repository.setConfig('branch.gone.merge', 'refs/heads/gone');
			await repository.setConfig('branch.gone.github-pr-owner-number', 'owner#repo#2');
			await repository.setConfig('branch.gone.github-pr-owner-number', 'owner#repo#2');
			await repository.setConfig('branch.gone.github-pr-owner-number', 'owner#repo#2');
			await repository.setConfig('branch.gone.github-pr-owner-number', 'owner#repo#2');

			const nonExistant = new Set<string>();
			await (manager as any).deleteBranches([{ label: 'gone' }], nonExistant, noopProgress, 1, 0, []);

			const configs = await repository.getConfigs();
			assert.strictEqual(configs.filter(c => c.key.startsWith('branch.gone.')).length, 0);
			assert.strictEqual(nonExistant.has('gone'), true);
		});
	});

	describe('deleteBranch modal', function () {
		let pr: PullRequestModel;
		let showWarningMessage: SinonStub;
		let deleteRemoteBranch: SinonStub;
		let getBranchInfo: SinonStub;

		beforeEach(async function () {
			const url = 'https://github.com/aaa/bbb.git';
			const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
			const githubRepository = new GitHubRepository(1, remote, repository.rootUri, manager.credentialStore, telemetry);
			const prItem = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().head(head => head.ref('feature')).build(), githubRepository);
			pr = new PullRequestModel(manager.credentialStore, telemetry, githubRepository, remote, prItem);
			await repository.createBranch('local-feature', false);
			getBranchInfo = sinon.stub(manager, 'getBranchNameForPullRequest').resolves({
				branch: 'local-feature',
				createdForPullRequest: false,
			});
			sinon.stub(manager, 'getPullRequestRepositoryDefaultBranch').resolves('main');
			sinon.stub(manager, 'findRepo').returns(githubRepository);
			sinon.stub(env, 'remoteName').value(undefined);
			sinon.stub(workspace, 'workspaceFolders').value([]);
			showWarningMessage = sinon.stub(window, 'showWarningMessage').resolves(undefined);
			deleteRemoteBranch = sinon.stub(manager, 'deleteBranch').resolves();
			sinon.stub(repository, 'fetch').resolves();
		});

		it('shows concise buttons and branch details in a modal, and cancels without deleting', async function () {
			const showQuickPick = sinon.stub(window, 'showQuickPick');
			const deleteLocalBranch = sinon.spy(repository, 'deleteBranch');

			const result = await PullRequestReviewCommon.deleteBranch(manager, pr);

			assert.deepStrictEqual(result, { isReply: true, message: { cancelled: true } });
			assert.strictEqual(showWarningMessage.calledOnce, true);
			assert.strictEqual(showWarningMessage.firstCall.args[0], `Choose what to delete for Pull Request #${pr.number}`);
			const options = showWarningMessage.firstCall.args[1] as MessageOptions;
			assert.strictEqual(options.modal, true);
			assert.strictEqual(options.detail, [
				'Choose an action below to clean up the resources associated with this pull request.',
				'',
				'Remote branch: origin/feature',
				'Remote repository: github.com/aaa/bbb',
				'Local branch: local-feature',
			].join('\n'));
			assert.deepStrictEqual(showWarningMessage.firstCall.args.slice(2).map((item: MessageItem) => item.title),
				['Delete All', 'Delete Remote Branch', 'Delete Local Branch']);
			assert.strictEqual(showQuickPick.notCalled, true);
			assert.strictEqual(deleteRemoteBranch.notCalled, true);
			assert.strictEqual(deleteLocalBranch.notCalled, true);
		});

		for (const [title, expectedTypes] of [
			['Delete Remote Branch', ['remoteHead']],
			['Delete Local Branch', ['local']],
			['Delete All', ['local', 'remoteHead']],
		] as const) {
			it(`executes only the actions for "${title}"`, async function () {
				showWarningMessage.callsFake(async (_message, _options, ...items: MessageItem[]) => items.find(item => item.title === title));
				const deleteLocalBranch = sinon.spy(repository, 'deleteBranch');

				const result = await PullRequestReviewCommon.deleteBranch(manager, pr);

				assert.strictEqual(result.isReply, false);
				assert.strictEqual(result.message.command, 'pr.deleteBranch');
				assert.deepStrictEqual(result.message.branchTypes.sort(), [...expectedTypes]);
				assert.strictEqual(deleteRemoteBranch.calledOnce, expectedTypes.some(type => type === 'remoteHead'));
				assert.strictEqual(deleteLocalBranch.calledOnce, expectedTypes.some(type => type === 'local'));
				if (deleteLocalBranch.calledOnce) {
					sinon.assert.calledWithExactly(deleteLocalBranch, 'local-feature', true);
				}
			});
		}

		it('offers only local deletion when the remote branch has been deleted', async function () {
			pr.isRemoteHeadDeleted = true;

			await PullRequestReviewCommon.deleteBranch(manager, pr);

			assert.deepStrictEqual(showWarningMessage.firstCall.args.slice(2).map((item: MessageItem) => item.title), ['Delete Local Branch']);
		});

		it('treats a local branch that no longer exists as deleted', async function () {
			await repository.deleteBranch('local-feature', true);
			showWarningMessage.callsFake(async (_message, _options, ...items: MessageItem[]) => items.find(item => item.title === 'Delete Local Branch'));

			const result = await PullRequestReviewCommon.deleteBranch(manager, pr);

			assert.deepStrictEqual(result.message.branchTypes, ['local']);
		});

		it('rethrows other local branch deletion errors', async function () {
			const error = new Error('Unable to delete local branch');
			sinon.stub(repository, 'deleteBranch').rejects(error);
			showWarningMessage.callsFake(async (_message, _options, ...items: MessageItem[]) => items.find(item => item.title === 'Delete Local Branch'));

			await assert.rejects(PullRequestReviewCommon.deleteBranch(manager, pr), error);
		});

		it('offers only remote branch deletion when there is no local branch', async function () {
			getBranchInfo.resolves(undefined);
			showWarningMessage.callsFake(async (_message, _options, ...items: MessageItem[]) => items[0]);

			const result = await PullRequestReviewCommon.deleteBranch(manager, pr);

			assert.deepStrictEqual(showWarningMessage.firstCall.args.slice(2).map((item: MessageItem) => item.title), ['Delete Remote Branch']);
			assert.deepStrictEqual(result.message.branchTypes, ['remoteHead']);
		});

		it('does not offer deletion of the default remote branch', async function () {
			assert.ok(pr.head);
			pr.head.ref = 'main';

			await PullRequestReviewCommon.deleteBranch(manager, pr);

			assert.deepStrictEqual(showWarningMessage.firstCall.args.slice(2).map((item: MessageItem) => item.title), ['Delete Local Branch']);
		});

		it('warns without showing a modal when there are no actions', async function () {
			pr.isRemoteHeadDeleted = true;
			getBranchInfo.resolves(undefined);

			const result = await PullRequestReviewCommon.deleteBranch(manager, pr);

			assert.deepStrictEqual(result, { isReply: true, message: { cancelled: true } });
			sinon.assert.calledOnce(showWarningMessage);
			assert.strictEqual(showWarningMessage.firstCall.args.length, 1);
			assert.strictEqual(deleteRemoteBranch.notCalled, true);
		});

		for (const title of ['Delete Remote', 'Remove Worktree', 'Delete All']) {
			it(`supports unused remote and worktree cleanup with "${title}"`, async function () {
				getBranchInfo.resolves({ branch: 'local-feature', remote: 'fork', createdForPullRequest: true, remoteInUse: false });
				const worktreePath = Uri.file('/worktrees/local-feature');
				sinon.stub(manager, 'getWorktreeForBranch').returns(worktreePath);
				const removeWorktree = sinon.stub(manager, 'removeWorktree').resolves();
				const removeRemote = sinon.stub(repository, 'removeRemote').resolves();
				const deleteLocalBranch = sinon.spy(repository, 'deleteBranch');
				showWarningMessage.callsFake(async (_message, _options, ...items: MessageItem[]) => items.find(item => item.title === title));

				const result = await PullRequestReviewCommon.deleteBranch(manager, pr);

				assert.deepStrictEqual(showWarningMessage.firstCall.args.slice(2).map((item: MessageItem) => item.title),
					['Delete All', 'Delete Remote Branch', 'Delete Local Branch', 'Delete Remote', 'Remove Worktree']);
				assert.strictEqual((showWarningMessage.firstCall.args[1] as MessageOptions).detail, [
					'Choose an action below to clean up the resources associated with this pull request.',
					'',
					'Remote branch: origin/feature',
					'Remote repository: github.com/aaa/bbb',
					'Local branch: local-feature',
					'Unused Git remote: fork',
					`Worktree: ${worktreePath.fsPath}`,
				].join('\n'));
				const expectedTypes = title === 'Delete All' ? ['local', 'remote', 'remoteHead', 'worktree'] : title === 'Delete Remote' ? ['remote'] : ['worktree'];
				assert.deepStrictEqual(result.message.branchTypes.sort(), expectedTypes);
				assert.strictEqual(removeRemote.calledOnce, title !== 'Remove Worktree');
				assert.strictEqual(removeWorktree.calledOnce, title !== 'Delete Remote');
				if (removeWorktree.calledOnce) {
					sinon.assert.calledWithExactly(removeWorktree, worktreePath.fsPath);
				}
				if (title === 'Delete All') {
					sinon.assert.callOrder(removeWorktree, deleteLocalBranch);
				}
			});
		}

		it('does not offer removal of an in-use remote or a worktree in the workspace', async function () {
			getBranchInfo.resolves({ branch: 'local-feature', remote: 'fork', createdForPullRequest: true, remoteInUse: true });
			const worktreePath = Uri.file('/worktrees/local-feature');
			sinon.stub(manager, 'getWorktreeForBranch').returns(worktreePath);
			sinon.stub(workspace, 'workspaceFolders').value([{ uri: worktreePath, name: 'local-feature', index: 0 }]);

			await PullRequestReviewCommon.deleteBranch(manager, pr);

			assert.deepStrictEqual(showWarningMessage.firstCall.args.slice(2).map((item: MessageItem) => item.title),
				['Delete All', 'Delete Remote Branch', 'Delete Local Branch']);
		});

		for (const title of ['Suspend Codespace', 'Delete All']) {
			it(`keeps Codespace suspension separate from deletion with "${title}"`, async function () {
				sinon.stub(env, 'remoteName').value('codespaces');
				const executeCommand = sinon.stub(commands, 'executeCommand').resolves();
				showWarningMessage.callsFake(async (_message, _options, ...items: MessageItem[]) => items.find(item => item.title === title));

				const result = await PullRequestReviewCommon.deleteBranch(manager, pr);

				assert.ok(showWarningMessage.firstCall.args.slice(2).some((item: MessageItem) => item.title === 'Suspend Codespace'));
				assert.deepStrictEqual(result.message.branchTypes.sort(), title === 'Suspend Codespace' ? ['suspend'] : ['local', 'remoteHead']);
				assert.strictEqual(executeCommand.calledOnce, title === 'Suspend Codespace');
				if (executeCommand.calledOnce) {
					sinon.assert.calledWithExactly(executeCommand, 'github.codespaces.disconnectSuspend');
				}
			});
		}
	});

	describe('deleteRemotes', function () {
		it('continues deleting remotes after one fails', async function () {
			await repository.addRemote('locked', 'https://github.com/owner/locked');
			await repository.addRemote('deletable', 'https://github.com/owner/deletable');
			const removeRemote = repository.removeRemote.bind(repository);
			sinon.stub(repository, 'removeRemote').callsFake(async name => {
				if (name === 'locked') {
					throw new Error('Repository is locked');
				}
				await removeRemote(name);
			});

			const failures = await (manager as any).deleteRemotes([{ label: 'locked' }, { label: 'deletable' }]);

			assert.strictEqual(failures.length, 1);
			assert.strictEqual(failures[0].label, 'locked');
			assert.deepStrictEqual(repository.state.remotes.map(remote => remote.name), ['locked']);
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

	it('unwraps list item continuations', async function () {
		const message = Promise.resolve('title\n\n- This is a list item that is long\n  and continues on the next line\n- Second item');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, '- This is a list item that is long and continues on the next line\n- Second item');
	});

	it('preserves indented code blocks but not list continuations', async function () {
		const message = Promise.resolve('title\n\nRegular paragraph.\n\n    This is code\n    More code\n\nAnother paragraph.');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, 'Regular paragraph.\n\n    This is code\n    More code\n\nAnother paragraph.');
	});

	it('unwraps regular text and list item continuations', async function () {
		const message = Promise.resolve('title\n\nThis is wrapped text\nthat should be joined.\n\n- List item with\n  continuation\n- Another item');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, 'This is wrapped text that should be joined.\n\n- List item with continuation\n- Another item');
	});

	it('handles complex nested lists with wrapped paragraphs', async function () {
		const message = Promise.resolve('title\n\nWrapped paragraph\nacross lines.\n\n- Item 1\n  - Nested item\n    More nested content\n- Item 2\n\nAnother wrapped paragraph\nhere.');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, 'Wrapped paragraph across lines.\n\n- Item 1\n  - Nested item More nested content\n- Item 2\n\nAnother wrapped paragraph here.');
	});

	it('handles nested lists', async function () {
		const message = Promise.resolve('title\n\n* This is a list item with two lines\n  that have a line break between them\n  * This is a nested list item that also has\n    two lines that should have been merged');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, '* This is a list item with two lines that have a line break between them\n  * This is a nested list item that also has two lines that should have been merged');
	});

	it('handles basic numeric list continuation', async function () {
		const message = Promise.resolve('title\n\n1.  Basic numeric list\n    continuation.\n    Third line');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, '1.  Basic numeric list continuation. Third line');
	});

	it('handles additional spaces OK for continuation', async function () {
		const message = Promise.resolve('title\n\n2.  Additional spaces are\n    OK for a continuation (unless it\'s 4 spaces which would be a code block).\n    Third line');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, '2.  Additional spaces are OK for a continuation (unless it\'s 4 spaces which would be a code block). Third line');
	});

	it('handles asterisk list with extra spaces', async function () {
		const message = Promise.resolve('title\n\n*   Additional spaces are\n    OK for a continuation (unless it\'s 4 spaces which would be a code block).\n    Third line');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, '*   Additional spaces are OK for a continuation (unless it\'s 4 spaces which would be a code block). Third line');
	});

	it('handles multi-digit numbers (10.)', async function () {
		const message = Promise.resolve('title\n\n10.  Multi-digit numbers should also\n     work for a continuation.\n     Third line');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, '10.  Multi-digit numbers should also work for a continuation. Third line');
	});

	it('handles multi-paragraph list - numbered', async function () {
		const message = Promise.resolve('title\n\n11.  Multi-paragraph lists are also supported.\n\n     Second paragraph in the same list item.\n     Third line');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, '11.  Multi-paragraph lists are also supported.\n\n     Second paragraph in the same list item. Third line');
	});

	it('handles multi-paragraph list - asterisk', async function () {
		const message = Promise.resolve('title\n\n*   Multi-paragraph lists are also supported.\n\n    Second paragraph in the same list item.\n    Third line');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, '*   Multi-paragraph lists are also supported.\n\n    Second paragraph in the same list item. Third line');
	});

	it('handles item with code block - numbered', async function () {
		const message = Promise.resolve('title\n\n1.  Item with code:\n\n    ```\n    code line\n    code line\n    ```');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, '1.  Item with code:\n\n    ```\n    code line\n    code line\n    ```');
	});

	it('handles item with code block - asterisk', async function () {
		const message = Promise.resolve('title\n\n*   Item with code:\n\n    ```\n    code line\n    code line\n    ```');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, '*   Item with code:\n\n    ```\n    code line\n    code line\n    ```');
	});

	it('handles fewer spaces OK - numbered (1 space)', async function () {
		const message = Promise.resolve('title\n\n1.  Fewer spaces are also OK\n for a list continuation (as long as there\'s at least one space)');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, '1.  Fewer spaces are also OK for a list continuation (as long as there\'s at least one space)');
	});

	it('handles fewer spaces OK - asterisk (1 space)', async function () {
		const message = Promise.resolve('title\n\n*   Fewer spaces are also OK\n for a list continuation (as long as there\'s at least one space)');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, '*   Fewer spaces are also OK for a list continuation (as long as there\'s at least one space)');
	});

	it('handles nested numbered lists', async function () {
		const message = Promise.resolve('title\n\n1.  First level item\n    continuation of first level\n    1.  Nested numbered item\n        with continuation');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, '1.  First level item continuation of first level\n    1.  Nested numbered item with continuation');
	});

	it('handles nested multi-digit numbered lists', async function () {
		const message = Promise.resolve('title\n\n10.  First level item with\n     multi-line content\n     10.  Nested with multi-digit\n          number and continuation');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, '10.  First level item with multi-line content\n     10.  Nested with multi-digit number and continuation');
	});

	it('handles nested multi-paragraph lists', async function () {
		const message = Promise.resolve('title\n\n*   Outer item\n\n    Second paragraph of outer\n    with continuation\n    *   Inner item\n\n        Second paragraph of inner\n        with continuation');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, '*   Outer item\n\n    Second paragraph of outer with continuation\n    *   Inner item\n\n        Second paragraph of inner with continuation');
	});

	it('handles first list item needs to be unwrapped', async function () {
		const message = Promise.resolve('This is a test\n\n- A fslilenfilnf flen felslnf lsefl fnels  Leknef\nLkdfnle  lfkenSlefn Lnkef LefnLienf LIfnels\n- B\n- C');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'This is a test');
		assert.strictEqual(result?.body, '- A fslilenfilnf flen felslnf lsefl fnels  Leknef Lkdfnle  lfkenSlefn Lnkef LefnLienf LIfnels\n- B\n- C');
	});

	it('strips Co-authored-by trailer lines from body', async function () {
		const message = Promise.resolve('title\n\nSome description.\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, 'Some description.');
	});

	it('strips multiple Co-authored-by trailer lines', async function () {
		const message = Promise.resolve('title\n\nSome description.\n\nCo-authored-by: Alice <alice@example.com>\nCo-authored-by: Bob <bob@example.com>');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, 'Some description.');
	});

	it('strips Co-authored-by case-insensitively', async function () {
		const message = Promise.resolve('title\n\nSome description.\n\nco-authored-by: Alice <alice@example.com>');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, 'Some description.');
	});

	it('preserves other trailers when stripping Co-authored-by', async function () {
		const message = Promise.resolve('title\n\nSome description.\n\nSigned-off-by: Alice <alice@example.com>\nCo-authored-by: Bob <bob@example.com>');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, 'Some description.\n\nSigned-off-by: Alice <alice@example.com>');
	});

	it('returns empty body when only Co-authored-by trailers are present', async function () {
		const message = Promise.resolve('title\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, '');
	});
});
