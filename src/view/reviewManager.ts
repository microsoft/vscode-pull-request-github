/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nodePath from 'path';
import * as vscode from 'vscode';
import { parseDiff, parsePatch, DiffHunk } from '../common/diffHunk';
import { toReviewUri, fromReviewUri } from '../common/uri';
import { groupBy, formatError } from '../common/utils';
import { IComment } from '../common/comment';
import { GitChangeType, InMemFileChange, SlimFileChange } from '../common/file';
import { Repository, GitErrorCodes, Branch } from '../api/api';
import { PullRequestChangesTreeDataProvider } from './prChangesTreeDataProvider';
import { GitContentProvider } from './gitContentProvider';
import { DiffChangeType } from '../common/diffHunk';
import { GitFileChangeNode, RemoteFileChangeNode, gitFileChangeNodeFilter } from './treeNodes/fileChangeNode';
import Logger from '../common/logger';
import { PullRequestsTreeDataProvider } from './prsTreeDataProvider';
import { PRNode } from './treeNodes/pullRequestNode';
import { PullRequestOverviewPanel } from '../github/pullRequestOverview';
import { Remote, parseRepositoryRemotes } from '../common/remote';
import { RemoteQuickPickItem, PullRequestTitleSourceQuickPick, PullRequestTitleSource, PullRequestTitleSourceEnum } from './quickpick';
import { PullRequestManager, titleAndBodyFrom } from '../github/pullRequestManager';
import { PullRequestModel, IResolvedPullRequestModel } from '../github/pullRequestModel';
import { ReviewCommentController } from './reviewCommentController';
import { ITelemetry } from '../common/telemetry';

export class ReviewManager {
	public static ID = 'Review';
	private static _instance: ReviewManager;
	private _localToDispose: vscode.Disposable[] = [];
	private _disposables: vscode.Disposable[];

	private _comments: IComment[] = [];
	private _localFileChanges: (GitFileChangeNode)[] = [];
	private _obsoleteFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[] = [];
	private _lastCommitSha?: string;
	private _updateMessageShown: boolean = false;
	private _validateStatusInProgress?: Promise<void>;
	private _reviewCommentController: ReviewCommentController;

	private _prFileChangesProvider: PullRequestChangesTreeDataProvider | undefined;
	private _statusBarItem: vscode.StatusBarItem;
	private _prNumber?: number;
	private _previousRepositoryState: {
		HEAD: Branch | undefined;
		remotes: Remote[];
	};

	private _switchingToReviewMode: boolean;

	public get switchingToReviewMode(): boolean {
		return this._switchingToReviewMode;
	}

	public set switchingToReviewMode(newState: boolean) {
		this._switchingToReviewMode = newState;
		if (!newState) {
			this.updateState();
		}
	}

	constructor(
		private _context: vscode.ExtensionContext,
		private _repository: Repository,
		private _prManager: PullRequestManager,
		private _prsTreeDataProvider: PullRequestsTreeDataProvider,
		private _telemetry: ITelemetry
	) {
		this._switchingToReviewMode = false;
		this._disposables = [];
		const gitContentProvider = new GitContentProvider(_repository);
		gitContentProvider.registerTextDocumentContentFallback(this.provideTextDocumentContent.bind(this));
		this._disposables.push(vscode.workspace.registerTextDocumentContentProvider('review', gitContentProvider));

		this._previousRepositoryState = {
			HEAD: _repository.state.HEAD,
			remotes: parseRepositoryRemotes(this._repository)
		};

		this.registerCommands();
		this.registerListeners();

		this._disposables.push(this._prsTreeDataProvider);

		this.updateState();
		this.pollForStatusChange();
	}

	private registerCommands(): void {
		this._disposables.push(vscode.commands.registerCommand('review.openFile', (value: GitFileChangeNode | vscode.Uri) => {
			const uri = value instanceof GitFileChangeNode ? value.filePath : value;

			if (value instanceof GitFileChangeNode) {
				value.reveal(value, { select: true, focus: true });
			}

			const activeTextEditor = vscode.window.activeTextEditor;
			const opts: vscode.TextDocumentShowOptions = {
				preserveFocus: true,
				viewColumn: vscode.ViewColumn.Active
			};

			// Check if active text editor has same path as other editor. we cannot compare via
			// URI.toString() here because the schemas can be different. Instead we just go by path.
			if (activeTextEditor && activeTextEditor.document.uri.path === uri.path) {
				opts.selection = activeTextEditor.selection;
			}

			vscode.commands.executeCommand('vscode.open', uri, opts);
		}));
		this._disposables.push(vscode.commands.registerCommand('pr.openChangedFile', (value: GitFileChangeNode) => {
			const openDiff = vscode.workspace.getConfiguration().get('git.openDiffOnClick');
			if (openDiff) {
				return vscode.commands.executeCommand('pr.openDiffView', value);
			} else {
				return vscode.commands.executeCommand('review.openFile', value);
			}
		}));

		this._disposables.push(vscode.commands.registerCommand('pr.refreshChanges', _ => {
			this.updateComments();
			PullRequestOverviewPanel.refresh();
			this.prFileChangesProvider.refresh();
		}));

		this._disposables.push(vscode.commands.registerCommand('pr.refreshPullRequest', (prNode: PRNode) => {
			if (prNode.pullRequestModel.equals(this._prManager.activePullRequest)) {
				this.updateComments();
			}

			PullRequestOverviewPanel.refresh();
			this._prsTreeDataProvider.refresh(prNode);
		}));
	}

	private registerListeners(): void {
		this._disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('githubPullRequests.showInSCM')) {
				if (this._prFileChangesProvider) {
					this._prFileChangesProvider.dispose();
					this._prFileChangesProvider = undefined;

					if (this._prManager.activePullRequest) {
						this.prFileChangesProvider.showPullRequestFileChanges(this._prManager, this._prManager.activePullRequest, this._localFileChanges, this._comments);
					}
				}

				this._prsTreeDataProvider.dispose();
				this._prsTreeDataProvider = new PullRequestsTreeDataProvider(this._telemetry);
				this._prsTreeDataProvider.initialize(this._prManager);
				this._disposables.push(this._prsTreeDataProvider);
			}
		}));

		this._disposables.push(this._repository.state.onDidChange(e => {
			const oldHead = this._previousRepositoryState.HEAD;
			const newHead = this._repository.state.HEAD;

			if (!oldHead && !newHead) {
				// both oldHead and newHead are undefined
				return;
			}

			let sameUpstream;

			if (!oldHead || !newHead) {
				sameUpstream = false;
			} else {
				sameUpstream = !!oldHead.upstream
					? newHead.upstream && oldHead.upstream.name === newHead.upstream.name && oldHead.upstream.remote === newHead.upstream.remote
					: !newHead.upstream;
			}

			const sameHead = sameUpstream // falsy if oldHead or newHead is undefined.
				&& oldHead!.ahead === newHead!.ahead
				&& oldHead!.behind === newHead!.behind
				&& oldHead!.commit === newHead!.commit
				&& oldHead!.name === newHead!.name
				&& oldHead!.remote === newHead!.remote
				&& oldHead!.type === newHead!.type;

			const remotes = parseRepositoryRemotes(this._repository);
			const sameRemotes = this._previousRepositoryState.remotes.length === remotes.length
				&& this._previousRepositoryState.remotes.every(remote => remotes.some(r => remote.equals(r)));

			if (!sameHead || !sameRemotes) {
				this._previousRepositoryState = {
					HEAD: this._repository.state.HEAD,
					remotes: remotes
				};

				this.updateState();
			}
		}));
	}

	static get instance() {
		return ReviewManager._instance;
	}

	get prFileChangesProvider() {
		if (!this._prFileChangesProvider) {
			this._prFileChangesProvider = new PullRequestChangesTreeDataProvider(this._context);
			this._disposables.push(this._prFileChangesProvider);
		}

		return this._prFileChangesProvider;
	}

	get statusBarItem() {
		if (!this._statusBarItem) {
			this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
		}

		return this._statusBarItem;
	}

	set repository(repository: Repository) {
		this._repository = repository;
		this.updateState();
	}

	private pollForStatusChange() {
		setTimeout(async () => {
			if (!this._validateStatusInProgress) {
				await this.updateComments();
			}
			this.pollForStatusChange();
		}, 1000 * 60 * 5);
	}

	public async updateState() {
		if (this.switchingToReviewMode) {
			return;
		}
		if (!this._validateStatusInProgress) {
			Logger.appendLine('Review> Validate state in progress');
			this._validateStatusInProgress = this.validateState();
			return this._validateStatusInProgress;
		} else {
			Logger.appendLine('Review> Queuing additional validate state');
			this._validateStatusInProgress = this._validateStatusInProgress.then(async _ => {
				return await this.validateState();
			});

			return this._validateStatusInProgress;
		}
	}

	private async validateState() {
		Logger.appendLine('Review> Validating state...');
		await this._prManager.updateRepositories();

		if (!this._repository.state.HEAD) {
			this.clear(true);
			return;
		}

		const branch = this._repository.state.HEAD;
		const matchingPullRequestMetadata = await this._prManager.getMatchingPullRequestMetadataForBranch();

		if (!matchingPullRequestMetadata) {
			Logger.appendLine(`Review> no matching pull request metadata found for current branch ${this._repository.state.HEAD.name}`);
			this.clear(true);
			return;
		}

		const hasPushedChanges = branch.commit !== this._lastCommitSha && branch.ahead === 0 && branch.behind === 0;
		if (this._prNumber === matchingPullRequestMetadata.prNumber && !hasPushedChanges) {
			vscode.commands.executeCommand('pr.refreshList');
			return;
		}

		const remote = branch.upstream ? branch.upstream.remote : null;
		if (!remote) {
			Logger.appendLine(`Review> current branch ${this._repository.state.HEAD.name} hasn't setup remote yet`);
			this.clear(true);
			return;
		}

		// we switch to another PR, let's clean up first.
		Logger.appendLine(`Review> current branch ${this._repository.state.HEAD.name} is associated with pull request #${matchingPullRequestMetadata.prNumber}`);
		this.clear(false);
		this._prNumber = matchingPullRequestMetadata.prNumber;
		this._lastCommitSha = undefined;

		const { owner, repositoryName } = matchingPullRequestMetadata;
		Logger.appendLine('Review> Resolving pull request');
		const pr = await this._prManager.resolvePullRequest(owner, repositoryName, matchingPullRequestMetadata.prNumber);
		if (!pr || !pr.isResolved()) {
			this._prNumber = undefined;
			Logger.appendLine('Review> This PR is no longer valid');
			return;
		}

		this._prManager.activePullRequest = pr;
		this._lastCommitSha = pr.head.sha;

		Logger.appendLine('Review> Fetching pull request data');
		await this.getPullRequestData(pr);
		await this.prFileChangesProvider.showPullRequestFileChanges(this._prManager, pr, this._localFileChanges, this._comments);

		Logger.appendLine(`Review> register comments provider`);
		await this.registerCommentController();

		this.statusBarItem.text = '$(git-branch) Pull Request #' + this._prNumber;
		this.statusBarItem.command = 'pr.openDescription';
		Logger.appendLine(`Review> display pull request status bar indicator and refresh pull request tree view.`);
		this.statusBarItem.show();
		vscode.commands.executeCommand('pr.refreshList');
		this._validateStatusInProgress = undefined;
	}

	private async updateComments(): Promise<void> {
		const branch = this._repository.state.HEAD;
		if (!branch) { return; }

		const matchingPullRequestMetadata = await this._prManager.getMatchingPullRequestMetadataForBranch();
		if (!matchingPullRequestMetadata) { return; }

		const remote = branch.upstream ? branch.upstream.remote : null;
		if (!remote) { return; }

		if (this._prNumber === undefined || !this._prManager.activePullRequest) {
			return;
		}

		const pr = await this._prManager.resolvePullRequest(matchingPullRequestMetadata.owner, matchingPullRequestMetadata.repositoryName, this._prNumber);

		if (!pr || !pr.isResolved()) {
			Logger.appendLine('Review> This PR is no longer valid');
			return;
		}

		if ((pr.head.sha !== this._lastCommitSha || (branch.behind !== undefined && branch.behind > 0)) && !this._updateMessageShown) {
			this._updateMessageShown = true;
			const result = await vscode.window.showInformationMessage('There are updates available for this branch.', {}, 'Pull');

			if (result === 'Pull') {
				await vscode.commands.executeCommand('git.pull');
				this._updateMessageShown = false;
			}
		}

		await this.getPullRequestData(pr);
		await this._reviewCommentController.update(this._localFileChanges, this._obsoleteFileChanges);

		return Promise.resolve(void 0);
	}

	private async getLocalChangeNodes(pr: PullRequestModel & IResolvedPullRequestModel, contentChanges: (InMemFileChange | SlimFileChange)[], activeComments: IComment[]): Promise<GitFileChangeNode[]> {
		const nodes: GitFileChangeNode[] = [];
		const mergeBase = pr.mergeBase || pr.base.sha;
		const headSha = pr.head.sha;

		for (let i = 0; i < contentChanges.length; i++) {
			const change = contentChanges[i];
			let isPartial = false;
			let diffHunks: DiffHunk[] = [];

			if (change instanceof InMemFileChange) {
				isPartial = change.isPartial;
				diffHunks = change.diffHunks;
			} else if (change.status !== GitChangeType.RENAME) {
				try {
					const patch = await this._repository.diffBetween(pr.base.sha, pr.head.sha, change.fileName);
					diffHunks = parsePatch(patch);
				} catch (e) {
					Logger.appendLine(`Failed to parse patch for outdated comments: ${e}`);
				}
			}

			const filePath = nodePath.join(this._repository.rootUri.path, change.fileName).replace(/\\/g, '/');
			const uri = this._repository.rootUri.with({ path: filePath });

			const modifiedFileUri = change.status === GitChangeType.DELETE
				? toReviewUri(uri, undefined, undefined, '', false, { base: false })
				: uri;

			const originalFileUri = toReviewUri(
				uri,
				change.status === GitChangeType.RENAME ? change.previousFileName : change.fileName,
				undefined,
				change.status === GitChangeType.ADD ? '' : mergeBase,
				false,
				{ base: true }
			);

			const changedItem = new GitFileChangeNode(
				this.prFileChangesProvider.view,
				pr,
				change.status,
				change.fileName,
				change.blobUrl,
				modifiedFileUri,
				originalFileUri,
				isPartial,
				diffHunks,
				activeComments.filter(comment => comment.path === change.fileName),
				headSha
			);
			nodes.push(changedItem);
		}

		return nodes;
	}

	private async getPullRequestData(pr: PullRequestModel & IResolvedPullRequestModel): Promise<void> {
		try {
			this._comments = await this._prManager.getPullRequestComments(pr);
			const activeComments = this._comments.filter(comment => comment.position);
			const outdatedComments = this._comments.filter(comment => !comment.position);

			const data = await this._prManager.getPullRequestFileChangesInfo(pr);
			const mergeBase = pr.mergeBase || pr.base.sha;

			const contentChanges = await parseDiff(data, this._repository, mergeBase!);
			this._localFileChanges = await this.getLocalChangeNodes(pr, contentChanges, activeComments);

			const commitsGroup = groupBy(outdatedComments, comment => comment.originalCommitId!);
			this._obsoleteFileChanges = [];
			for (const commit in commitsGroup) {
				const commentsForCommit = commitsGroup[commit];
				const commentsForFile = groupBy(commentsForCommit, comment => comment.path!);

				for (const fileName in commentsForFile) {

					let diffHunks: DiffHunk[] = [];
					try {
						const patch = await this._repository.diffBetween(pr.base.sha, commit, fileName);
						diffHunks = parsePatch(patch);
					} catch (e) {
						Logger.appendLine(`Failed to parse patch for outdated comments: ${e}`);
					}

					const oldComments = commentsForFile[fileName];
					const uri = vscode.Uri.file(nodePath.join(`commit~${commit.substr(0, 8)}`, fileName));
					const obsoleteFileChange = new GitFileChangeNode(
						this.prFileChangesProvider.view,
						pr,
						GitChangeType.MODIFY,
						fileName,
						undefined,
						toReviewUri(uri, fileName, undefined, oldComments[0].originalCommitId!, true, { base: false }),
						toReviewUri(uri, fileName, undefined, oldComments[0].originalCommitId!, true, { base: true }),
						false,
						diffHunks,
						oldComments,
						commit
					);

					this._obsoleteFileChanges.push(obsoleteFileChange);
				}
			}

			return Promise.resolve(void 0);
		} catch (e) {
			Logger.appendLine(`Review> ${e}`);
		}

	}

	private async registerCommentController() {
		this._reviewCommentController = new ReviewCommentController(this._prManager,
			this._repository,
			this._localFileChanges,
			this._obsoleteFileChanges,
			this._comments);

		await this._reviewCommentController.initialize();

		this._localToDispose.push(this._reviewCommentController);
		this._localToDispose.push(this._reviewCommentController.onDidChangeComments(comments => {
			this._comments = comments;
		}));
	}

	public async switch(pr: PullRequestModel): Promise<void> {
		Logger.appendLine(`Review> switch to Pull Request #${pr.number} - start`);
		this.statusBarItem.text = '$(sync~spin) Switching to Review Mode';
		this.statusBarItem.command = undefined;
		this.statusBarItem.show();
		this.switchingToReviewMode = true;

		try {
			const didLocalCheckout = await this._prManager.checkoutExistingPullRequestBranch(pr);

			if (!didLocalCheckout) {
				await this._prManager.fetchAndCheckout(pr);
			}
		} catch (e) {
			Logger.appendLine(`Review> checkout failed #${JSON.stringify(e)}`);
			this.switchingToReviewMode = false;

			if (e.gitErrorCode) {
				// for known git errors, we should provide actions for users to continue.
				if (e.gitErrorCode === GitErrorCodes.LocalChangesOverwritten || e.gitErrorCode === GitErrorCodes.DirtyWorkTree) {
					vscode.window.showErrorMessage('Your local changes would be overwritten by checkout, please commit your changes or stash them before you switch branches');
					return;
				}
			}

			vscode.window.showErrorMessage(formatError(e));
			// todo, we should try to recover, for example, git checkout succeeds but set config fails.
			return;
		}

		try {
			this.statusBarItem.text = `$(sync~spin) Fetching additional data: pr/${pr.number}`;
			this.statusBarItem.command = undefined;
			this.statusBarItem.show();

			await this._prManager.fullfillPullRequestMissingInfo(pr);

			/* __GDPR__
				"pr.checkout" : {}
			*/
			this._telemetry.sendTelemetryEvent('pr.checkout');
			Logger.appendLine(`Review> switch to Pull Request #${pr.number} - done`, ReviewManager.ID);
		} finally {
			this.switchingToReviewMode = false;
			this.statusBarItem.text = `Pull Request #${pr.number}`;
			this.statusBarItem.command = undefined;
			this.statusBarItem.show();
			await this._repository.status();
		}
	}

	public async publishBranch(branch: Branch): Promise<Branch | undefined> {
		const potentialTargetRemotes = this._prManager.getGitHubRemotes();
		const selectedRemote = (await this.getRemote(potentialTargetRemotes, `Pick a remote to publish the branch '${branch.name}' to:`))!.remote;

		if (!selectedRemote || branch.name === undefined) {
			return;
		}

		return new Promise<Branch | undefined>(async (resolve) => {
			const inputBox = vscode.window.createInputBox();
			inputBox.value = branch.name!;
			inputBox.ignoreFocusOut = true;
			inputBox.prompt = potentialTargetRemotes.length === 1 ? `The branch '${branch.name}' is not published yet, pick a name for the upstream branch` : 'Pick a name for the upstream branch';
			const validate = async function (value: string) {
				try {
					inputBox.busy = true;
					const remoteBranch = await this._prManager.getBranch(selectedRemote, value);
					if (remoteBranch) {
						inputBox.validationMessage = `Branch ${value} already exists in ${selectedRemote.owner}/${selectedRemote.repositoryName}`;
					} else {
						inputBox.validationMessage = undefined;
					}
				} catch (e) {
					inputBox.validationMessage = undefined;
				}

				inputBox.busy = false;
			};
			await validate(branch.name!);
			inputBox.onDidChangeValue(validate.bind(this));
			inputBox.onDidAccept(async () => {
				inputBox.validationMessage = undefined;
				inputBox.hide();
				try {
					// since we are probably pushing a remote branch with a different name, we use the complete synatx
					// git push -u origin local_branch:remote_branch
					await this._repository.push(selectedRemote.remoteName, `${branch.name}:${inputBox.value}`, true);
				} catch (err) {
					if (err.gitErrorCode === GitErrorCodes.PushRejected) {
						vscode.window.showWarningMessage(`Can't push refs to remote, try running 'git pull' first to integrate with your change`, {
							modal: true
						});

						resolve();
					}

					if (err.gitErrorCode === GitErrorCodes.RemoteConnectionError) {
						vscode.window.showWarningMessage(`Could not read from remote repository '${selectedRemote.remoteName}'. Please make sure you have the correct access rights and the repository exists.`, {
							modal: true
						});

						resolve();
					}

					// we can't handle the error
					throw err;
				}

				// we don't want to wait for repository status update
				const latestBranch = await this._repository.getBranch(branch.name!);
				if (!latestBranch || !latestBranch.upstream) {
					resolve();
				}

				resolve(latestBranch);
			});

			inputBox.show();
		});
	}

	private async getRemote(potentialTargetRemotes: Remote[], placeHolder: string, defaultUpstream?: RemoteQuickPickItem): Promise<RemoteQuickPickItem | undefined> {
		if (!potentialTargetRemotes.length) {
			vscode.window.showWarningMessage(`No GitHub remotes found. Add a remote and try again.`);
			return;
		}

		if (potentialTargetRemotes.length === 1 && !defaultUpstream) {
			return RemoteQuickPickItem.fromRemote(potentialTargetRemotes[0]);
		}

		if (potentialTargetRemotes.length === 1
			&& defaultUpstream
			&& defaultUpstream.owner === potentialTargetRemotes[0].owner
			&& defaultUpstream.name === potentialTargetRemotes[0].repositoryName) {
			return defaultUpstream;
		}

		let defaultUpstreamWasARemote = false;
		const picks: RemoteQuickPickItem[] = potentialTargetRemotes.map(remote => {
			const remoteQuickPick = RemoteQuickPickItem.fromRemote(remote);
			if (defaultUpstream) {
				const { owner, name } = defaultUpstream;
				remoteQuickPick.picked = remoteQuickPick.owner === owner && remoteQuickPick.name === name;
				if (remoteQuickPick.picked) {
					defaultUpstreamWasARemote = true;
				}
			}
			return remoteQuickPick;
		});
		if (!defaultUpstreamWasARemote && defaultUpstream) {
			picks.unshift(defaultUpstream);
		}

		const selected: RemoteQuickPickItem | undefined = await vscode.window.showQuickPick<RemoteQuickPickItem>(picks, {
			ignoreFocusOut: true,
			placeHolder: placeHolder
		});

		if (!selected) {
			return;
		}

		return selected;
	}

	private async getPullRequestTitleAndDescriptionDefaults(progress: vscode.Progress<{message?: string, increment?: number}>): Promise<{ title: string, description: string } | undefined> {
		const pullRequestTemplates = await this._prManager.getPullRequestTemplates();
		let template: vscode.Uri | undefined;

		if (pullRequestTemplates.length === 1) {
			template = pullRequestTemplates[0];
			progress.report({ increment: 5, message: 'Found pull request template. Creating pull request...' });
		}

		if (pullRequestTemplates.length > 1) {
			const targetTemplate = await vscode.window.showQuickPick(pullRequestTemplates.map(uri => {
				return {
					label: vscode.workspace.asRelativePath(uri.path),
					uri: uri
				};
			}), {
				ignoreFocusOut: true,
				placeHolder: 'Select the pull request template to use'
			});

			// Treat user pressing escape as cancel
			if (!targetTemplate) {
				return;
			}

			template = targetTemplate.uri;
			progress.report({ increment: 5, message: 'Creating pull request...' });
		}

		const { title, body } = titleAndBodyFrom(await this._prManager.getHeadCommitMessage());
		let description = body;
		if (template) {
			try {
				const templateContent = await vscode.workspace.fs.readFile(template);
				description = templateContent.toString();
			} catch (e) {
				Logger.appendLine(`Reading pull request template failed: ${e}`);
			}
		}

		return {
			title,
			description
		};
	}

	private async getPullRequestTitleSetting(): Promise<PullRequestTitleSource | undefined> {
		const method = vscode.workspace.getConfiguration('githubPullRequests').get<PullRequestTitleSource>('pullRequestTitle', PullRequestTitleSourceEnum.Ask);

		if (method === PullRequestTitleSourceEnum.Ask) {
			const titleSource = await vscode.window.showQuickPick<PullRequestTitleSourceQuickPick>(PullRequestTitleSourceQuickPick.allOptions(), {
				ignoreFocusOut: true,
				placeHolder: 'Pull Request Title Source'
			});

			if (!titleSource) {
				return;
			}

			return titleSource.pullRequestTitleSource;
		}

		return method;
	}

	public async createPullRequest(draft=false): Promise<void> {
		const pullRequestDefaults = await this._prManager.getPullRequestDefaults();
		const githubRemotes = this._prManager.getGitHubRemotes();
		const targetRemote = await this.getRemote(githubRemotes, 'Select the remote to send the pull request to',
			new RemoteQuickPickItem(pullRequestDefaults.owner, pullRequestDefaults.repo, 'Parent Fork')
		);

		if (!targetRemote) {
			return;
		}

		const base: string = targetRemote.remote
			? (await this._prManager.getMetadata(targetRemote.remote.remoteName)).default_branch
			: pullRequestDefaults.base;
		const target = await vscode.window.showInputBox({
			value: base,
			ignoreFocusOut: true,
			prompt: `Choose target branch for ${targetRemote.owner}/${targetRemote.name}`,
		});

		if (!target) {
			return;
		}

		if (this._repository.state.HEAD === undefined) {
			return;
		}

		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Creating Pull Request',
			cancellable: false
		}, async (progress) => {
			progress.report({ increment: 10 });
			let HEAD: Branch | undefined = this._repository.state.HEAD!;
			const branchName = HEAD.name;

			if (!HEAD.upstream) {
				progress.report({ increment: 10, message: `Start publishing branch ${branchName}` });
				HEAD = await this.publishBranch(HEAD);
				if (!HEAD) {
					return;
				}
				progress.report({ increment: 20, message: `Branch ${branchName} published` });
			} else {
				progress.report({ increment: 30, message: `Start creating pull request.` });

			}

			const headRemote = githubRemotes.find(remote => remote.remoteName === HEAD!.upstream!.remote);
			if (!headRemote) {
				return;
			}

			const titleAndDescriptionDefaults = await this.getPullRequestTitleAndDescriptionDefaults(progress);
			// User cancelled a quick input, cancel the create process
			if (!titleAndDescriptionDefaults) {
				return;
			}

			let { title } = titleAndDescriptionDefaults;

			const pullRequestTitleMethod = await this.getPullRequestTitleSetting();

			// User cancelled the name selection process, cancel the create process
			if (!pullRequestTitleMethod) {
				return;
			}

			switch (pullRequestTitleMethod) {
				case PullRequestTitleSourceEnum.Branch:
					if (branchName) {
						title = branchName;
					}
					break;
				case PullRequestTitleSourceEnum.Custom:
					const nameResult = await vscode.window.showInputBox({
						value: title,
						ignoreFocusOut: true,
						prompt: `Enter PR title`,
						validateInput: (value) => value ? null : 'Title can not be empty'
					});

					if (!nameResult) {
						return;
					}

					title = nameResult;
			}

			const createParams = {
				title,
				body: titleAndDescriptionDefaults.description,
				base: target,
				// For cross-repository pull requests, the owner must be listed. Always list to be safe. See https://developer.github.com/v3/pulls/#create-a-pull-request.
				head: `${headRemote.owner}:${branchName}`,
				owner: targetRemote!.owner,
				repo: targetRemote!.name,
				draft: draft
			};

			const pullRequestModel = await this._prManager.createPullRequest(createParams);

			if (pullRequestModel) {
				progress.report({ increment: 30, message: `Pull Request #${pullRequestModel.number} Created` });
				await this.updateState();
				await vscode.commands.executeCommand('pr.openDescription');
				progress.report({ increment: 30 });
			} else {
				// error: Unhandled Rejection at: Promise [object Promise]. Reason: {"message":"Validation Failed","errors":[{"resource":"PullRequest","code":"custom","message":"A pull request already exists for rebornix:tree-sitter."}],"documentation_url":"https://developer.github.com/v3/pulls/#create-a-pull-request"}.
				progress.report({ increment: 90, message: `Failed to create pull request for ${branchName}` });
			}
		});
	}

	private clear(quitReviewMode: boolean) {
		this._updateMessageShown = false;

		this._localToDispose.forEach(disposeable => disposeable.dispose());

		if (quitReviewMode) {
			this._prNumber = undefined;
			this._prManager.activePullRequest = undefined;

			if (this._statusBarItem) {
				this._statusBarItem.hide();
			}

			if (this._prFileChangesProvider) {
				this.prFileChangesProvider.hide();
			}

			// Ensure file explorer decorations are removed. When switching to a different PR branch,
			// comments are recalculated when getting the data and the change decoration fired then,
			// so comments only needs to be emptied in this case.
			this._comments = [];

			vscode.commands.executeCommand('pr.refreshList');
		}
	}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string | undefined> {
		const { path, commit } = fromReviewUri(uri);
		let changedItems = gitFileChangeNodeFilter(this._localFileChanges)
			.filter(change => change.fileName === path)
			.filter(fileChange => fileChange.sha === commit || (fileChange.parentSha ? fileChange.parentSha : `${fileChange.sha}^`) === commit);

		if (changedItems.length) {
			const changedItem = changedItems[0];
			const diffChangeTypeFilter = commit === changedItem.sha ? DiffChangeType.Delete : DiffChangeType.Add;
			const ret = changedItem.diffHunks.map(diffHunk => diffHunk.diffLines.filter(diffLine => diffLine.type !== diffChangeTypeFilter).map(diffLine => diffLine.text));
			return ret.reduce((prev, curr) => prev.concat(...curr), []).join('\n');
		}

		changedItems = gitFileChangeNodeFilter(this._obsoleteFileChanges)
			.filter(change => change.fileName === path)
			.filter(fileChange => fileChange.sha === commit || (fileChange.parentSha ? fileChange.parentSha : `${fileChange.sha}^`) === commit);

		if (changedItems.length) {
			// it's from obsolete file changes, which means the content is in complete.
			const changedItem = changedItems[0];
			const diffChangeTypeFilter = commit === changedItem.sha ? DiffChangeType.Delete : DiffChangeType.Add;
			const ret = [];
			const commentGroups = groupBy(changedItem.comments, comment => String(comment.originalPosition));

			for (const comment_position in commentGroups) {
				if (!commentGroups[comment_position][0].diffHunks) {
					continue;
				}

				const lines = commentGroups[comment_position][0].diffHunks!
					.map(diffHunk =>
						diffHunk.diffLines.filter(diffLine => diffLine.type !== diffChangeTypeFilter)
							.map(diffLine => diffLine.text)
					).reduce((prev, curr) => prev.concat(...curr), []);
				ret.push(...lines);
			}

			return ret.join('\n');
		}
	}

	dispose() {
		this.clear(true);
		this._disposables.forEach(d => {
			d.dispose();
		});
	}
}
