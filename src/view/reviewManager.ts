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
import { DiffChangeType } from '../common/diffHunk';
import { GitFileChangeNode, RemoteFileChangeNode, gitFileChangeNodeFilter } from './treeNodes/fileChangeNode';
import Logger from '../common/logger';
import { Remote, parseRepositoryRemotes } from '../common/remote';
import { RemoteQuickPickItem, PullRequestTitleSourceQuickPick, PullRequestTitleSource, PullRequestTitleSourceEnum, PullRequestDescriptionSourceQuickPick, PullRequestDescriptionSource, PullRequestDescriptionSourceEnum } from './quickpick';
import { FolderRepositoryManager, SETTINGS_NAMESPACE, titleAndBodyFrom } from '../github/folderRepositoryManager';
import { PullRequestModel, IResolvedPullRequestModel } from '../github/pullRequestModel';
import { ReviewCommentController } from './reviewCommentController';
import { ITelemetry } from '../common/telemetry';
import { GitHubRepository, ViewerPermission } from '../github/githubRepository';
import { PullRequestViewProvider } from '../github/activityBarViewProvider';
import { PullRequestGitHelper } from '../github/pullRequestGitHelper';

const FOCUS_REVIEW_MODE = 'github:focusedReview';

export class ReviewManager {
	public static ID = 'Review';
	private _localToDispose: vscode.Disposable[] = [];
	private _disposables: vscode.Disposable[];

	private _comments: IComment[] = [];
	private _localFileChanges: (GitFileChangeNode)[] = [];
	private _obsoleteFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[] = [];
	private _lastCommitSha?: string;
	private _updateMessageShown: boolean = false;
	private _validateStatusInProgress?: Promise<void>;
	private _reviewCommentController: ReviewCommentController;

	private _statusBarItem: vscode.StatusBarItem;
	private _prNumber?: number;
	private _previousRepositoryState: {
		HEAD: Branch | undefined;
		remotes: Remote[];
	};

	private _webviewViewProvider: PullRequestViewProvider | undefined;

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

	private _isFirstLoad = true;

	constructor(
		private _context: vscode.ExtensionContext,
		private _repository: Repository,
		private _folderRepoManager: FolderRepositoryManager,
		private _telemetry: ITelemetry,
		public changesInPrDataProvider: PullRequestChangesTreeDataProvider
	) {
		this._switchingToReviewMode = false;
		this._disposables = [];

		this._previousRepositoryState = {
			HEAD: _repository.state.HEAD,
			remotes: parseRepositoryRemotes(this._repository)
		};

		this.registerListeners();

		this.updateState();
		this.pollForStatusChange();
	}

	private registerListeners(): void {
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

		this._disposables.push(vscode.workspace.onDidChangeConfiguration(_ => {
			this.updateFocusedViewMode();
		}));

		this._disposables.push(this._folderRepoManager.onDidChangeActivePullRequest(_ => {
			this.updateFocusedViewMode();
		}));
	}

	get statusBarItem() {
		if (!this._statusBarItem) {
			this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
		}

		return this._statusBarItem;
	}

	get repository(): Repository {
		return this._repository;
	}

	get localFileChanges(): GitFileChangeNode[] {
		return this._localFileChanges;
	}

	setRepository(repository: Repository, silent: boolean) {
		this._repository = repository;
		this.updateState(silent);
	}

	private pollForStatusChange() {
		setTimeout(async () => {
			if (!this._validateStatusInProgress) {
				await this.updateComments();
			}
			this.pollForStatusChange();
		}, 1000 * 60 * 5);
	}

	private async checkBranchUpToDate(pr: IResolvedPullRequestModel): Promise<void> {
		const branch = this._repository.state.HEAD;
		if (branch) {
			const remote = branch.upstream ? branch.upstream.remote : null;
			if (remote) {
				await this._repository.fetch(remote, this._repository.state.HEAD?.name);
				if ((pr.head.sha !== this._lastCommitSha || (branch.behind !== undefined && branch.behind > 0)) && !this._updateMessageShown) {
					this._updateMessageShown = true;
					const result = await vscode.window.showInformationMessage('There are updates available for this pull request.', {}, 'Pull');

					if (result === 'Pull') {
						await vscode.commands.executeCommand('git.pull');
						this._updateMessageShown = false;
					}
				}

			}
		}
	}

	public async updateState(silent: boolean = false) {
		if (this.switchingToReviewMode) {
			return;
		}
		if (!this._validateStatusInProgress) {
			Logger.appendLine('Review> Validate state in progress');
			this._validateStatusInProgress = this.validateState(silent);
			return this._validateStatusInProgress;
		} else {
			Logger.appendLine('Review> Queuing additional validate state');
			this._validateStatusInProgress = this._validateStatusInProgress.then(async _ => {
				return await this.validateState(silent);
			});

			return this._validateStatusInProgress;
		}
	}

	private async validateState(silent: boolean) {
		Logger.appendLine('Review> Validating state...');
		await this._folderRepoManager.updateRepositories(silent);
		if (silent) {
			return;
		}

		if (!this._repository.state.HEAD) {
			this.clear(true);
			return;
		}

		const branch = this._repository.state.HEAD;
		let matchingPullRequestMetadata = await this._folderRepoManager.getMatchingPullRequestMetadataForBranch();

		if (!matchingPullRequestMetadata) {
			Logger.appendLine(`Review> no matching pull request metadata found for current branch ${branch.name}`);
			const metadataFromGithub = await this._folderRepoManager.getMatchingPullRequestMetadataFromGitHub();
			if (metadataFromGithub) {
				PullRequestGitHelper.associateBranchWithPullRequest(this._repository, metadataFromGithub.model, branch.name!);
				matchingPullRequestMetadata = metadataFromGithub;
			}
		}

		if (!matchingPullRequestMetadata) {
			Logger.appendLine(`Review> no matching pull request metadata found on GitHub for current branch ${branch.name}`);
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
		const pr = await this._folderRepoManager.resolvePullRequest(owner, repositoryName, matchingPullRequestMetadata.prNumber);
		if (!pr || !pr.isResolved()) {
			this._prNumber = undefined;
			Logger.appendLine('Review> This PR is no longer valid');
			return;
		}

		this._folderRepoManager.activePullRequest = pr;
		this._lastCommitSha = pr.head.sha;

		if (this._isFirstLoad) {
			this._isFirstLoad = false;
			this.checkBranchUpToDate(pr);
		}

		Logger.appendLine('Review> Fetching pull request data');
		await this.getPullRequestData(pr);
		await this.changesInPrDataProvider.addPrToView(this._folderRepoManager, pr, this._localFileChanges, this._comments);

		Logger.appendLine(`Review> register comments provider`);
		await this.registerCommentController();

		if (!this._webviewViewProvider) {
			this._webviewViewProvider = new PullRequestViewProvider(this._context.extensionUri, this._folderRepoManager, pr);
			this._context.subscriptions.push(vscode.window.registerWebviewViewProvider(PullRequestViewProvider.viewType, this._webviewViewProvider));
		} else {
			this._webviewViewProvider.updatePullRequest(pr);
		}

		this.statusBarItem.text = '$(git-branch) Pull Request #' + this._prNumber;
		this.statusBarItem.command = { command: 'pr.openDescription', title: 'View Pull Request Description', arguments: [pr] };
		Logger.appendLine(`Review> display pull request status bar indicator and refresh pull request tree view.`);
		this.statusBarItem.show();
		vscode.commands.executeCommand('pr.refreshList');
		if (this._context.workspaceState.get(FOCUS_REVIEW_MODE)) {
			if (this.localFileChanges.length > 0) {
				let fileChangeToShow: GitFileChangeNode | undefined;
				for (const fileChange of this.localFileChanges) {
					if (fileChange.status === GitChangeType.MODIFY) {
						fileChangeToShow = fileChange;
						break;
					}
				}
				fileChangeToShow = fileChangeToShow ?? this.localFileChanges[0];
				fileChangeToShow.openDiff(this._folderRepoManager);
			}
		}
		this._validateStatusInProgress = undefined;
	}

	public async updateComments(): Promise<void> {
		const branch = this._repository.state.HEAD;
		if (!branch) { return; }

		const matchingPullRequestMetadata = await this._folderRepoManager.getMatchingPullRequestMetadataForBranch();
		if (!matchingPullRequestMetadata) { return; }

		const remote = branch.upstream ? branch.upstream.remote : null;
		if (!remote) { return; }

		if (this._prNumber === undefined || !this._folderRepoManager.activePullRequest) {
			return;
		}

		const pr = await this._folderRepoManager.resolvePullRequest(matchingPullRequestMetadata.owner, matchingPullRequestMetadata.repositoryName, this._prNumber);

		if (!pr || !pr.isResolved()) {
			Logger.appendLine('Review> This PR is no longer valid');
			return;
		}

		await this.checkBranchUpToDate(pr);

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
			let diffHunks: DiffHunk[] = [];

			if (change instanceof InMemFileChange) {
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
				? toReviewUri(uri, undefined, undefined, '', false, { base: false }, this._repository.rootUri)
				: uri;

			const originalFileUri = toReviewUri(
				uri,
				change.status === GitChangeType.RENAME ? change.previousFileName : change.fileName,
				undefined,
				change.status === GitChangeType.ADD ? '' : mergeBase,
				false,
				{ base: true },
				this._repository.rootUri
			);

			const changedItem = new GitFileChangeNode(
				this.changesInPrDataProvider.view,
				pr,
				change.status,
				change.fileName,
				change.blobUrl,
				modifiedFileUri,
				originalFileUri,
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
			this._comments = await pr.getReviewComments();
			const activeComments = this._comments.filter(comment => comment.position);
			const outdatedComments = this._comments.filter(comment => !comment.position);

			const data = await pr.getFileChangesInfo();
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
						this.changesInPrDataProvider.view,
						pr,
						GitChangeType.MODIFY,
						fileName,
						undefined,
						toReviewUri(uri, fileName, undefined, oldComments[0].originalCommitId!, true, { base: false }, this._repository.rootUri),
						toReviewUri(uri, fileName, undefined, oldComments[0].originalCommitId!, true, { base: true }, this._repository.rootUri),
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
		this._reviewCommentController = new ReviewCommentController(this._folderRepoManager,
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
			const didLocalCheckout = await this._folderRepoManager.checkoutExistingPullRequestBranch(pr);

			if (!didLocalCheckout) {
				await this._folderRepoManager.fetchAndCheckout(pr);
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

			await this._folderRepoManager.fullfillPullRequestMissingInfo(pr);

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
		const potentialTargetRemotes = await this._folderRepoManager.getAllGitHubRemotes();
		let selectedRemote = (await this.getRemote(potentialTargetRemotes, `Pick a remote to publish the branch '${branch.name}' to:`))!.remote;

		if (!selectedRemote || branch.name === undefined) {
			return;
		}

		const githubRepo = this._folderRepoManager.createGitHubRepository(selectedRemote, this._folderRepoManager.credentialStore);
		const permission = await githubRepo.getViewerPermission();
		if ((permission === ViewerPermission.Read) || (permission === ViewerPermission.Triage) || (permission === ViewerPermission.Unknown)) {
			// No permission to publish the branch to the chosen remote. Offer to fork.
			const fork = await this._folderRepoManager.tryOfferToFork(githubRepo);
			if (!fork) {
				return;
			}
			selectedRemote = this._folderRepoManager.getGitHubRemotes().find(element => element.remoteName === fork);
		}

		if (!selectedRemote) {
			return;
		}
		const remote: Remote = selectedRemote;

		return new Promise<Branch | undefined>(async (resolve) => {
			const inputBox = vscode.window.createInputBox();
			inputBox.value = branch.name!;
			inputBox.ignoreFocusOut = true;
			inputBox.prompt = potentialTargetRemotes.length === 1 ? `The branch '${branch.name}' is not published yet, pick a name for the upstream branch` : 'Pick a name for the upstream branch';
			const validate = async function (value: string) {
				try {
					inputBox.busy = true;
					const remoteBranch = await this._reposManager.getBranch(remote, value);
					if (remoteBranch) {
						inputBox.validationMessage = `Branch ${value} already exists in ${remote.owner}/${remote.repositoryName}`;
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
					await this._repository.push(remote.remoteName, `${branch.name}:${inputBox.value}`, true);
				} catch (err) {
					if (err.gitErrorCode === GitErrorCodes.PushRejected) {
						vscode.window.showWarningMessage(`Can't push refs to remote, try running 'git pull' first to integrate with your change`, {
							modal: true
						});

						resolve();
					}

					if (err.gitErrorCode === GitErrorCodes.RemoteConnectionError) {
						vscode.window.showWarningMessage(`Could not read from remote repository '${remote.remoteName}'. Please make sure you have the correct access rights and the repository exists.`, {
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

	private async getPullRequestTitleAndDescriptionDefaults(progress: vscode.Progress<{ message?: string, increment?: number }>, pullRequestDescriptionMethod: PullRequestDescriptionSource): Promise<{ title: string, description: string } | undefined> {
		let template: vscode.Uri | undefined;

		// Only fetch pull request templates if requested
		if (pullRequestDescriptionMethod === PullRequestDescriptionSourceEnum.Template) {
			const pullRequestTemplates = await this._folderRepoManager.getPullRequestTemplates();

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
		}

		const { title, body } = titleAndBodyFrom(await this._folderRepoManager.getHeadCommitMessage());
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

	private async getPullRequestDescriptionSetting(): Promise<PullRequestDescriptionSource | undefined> {
		const method = vscode.workspace.getConfiguration('githubPullRequests').get<PullRequestDescriptionSource>('pullRequestDescription', PullRequestDescriptionSourceEnum.Ask);

		if (method === PullRequestDescriptionSourceEnum.Ask) {
			const descriptionSource = await vscode.window.showQuickPick<PullRequestDescriptionSourceQuickPick>(PullRequestDescriptionSourceQuickPick.allOptions(), {
				ignoreFocusOut: true,
				placeHolder: 'Pull Request Description Source'
			});

			if (!descriptionSource) {
				return;
			}

			return descriptionSource.pullRequestDescriptionSource;
		}

		return method;
	}

	public async createPullRequest(draft = false): Promise<void> {
		const pullRequestDefaults = await this._folderRepoManager.getPullRequestDefaults();
		const githubRemotes = this._folderRepoManager.getGitHubRemotes();
		const targetRemote = await this.getRemote(githubRemotes, 'Select the remote to send the pull request to',
			new RemoteQuickPickItem(pullRequestDefaults.owner, pullRequestDefaults.repo, 'Parent Repository')
		);

		if (!targetRemote) {
			return;
		}

		const base: string = targetRemote.remote
			? (await this._folderRepoManager.getMetadata(targetRemote.remote.remoteName)).default_branch
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

			const headRemote = (await this._folderRepoManager.getAllGitHubRemotes()).find(remote => remote.remoteName === HEAD!.upstream!.remote);
			if (!headRemote) {
				return;
			}

			const pullRequestTitleMethod = await this.getPullRequestTitleSetting();

			// User cancelled the title selection process, cancel the create process
			if (!pullRequestTitleMethod) {
				return;
			}

			const pullRequestDescriptionMethod = await this.getPullRequestDescriptionSetting();

			// User cancelled the description selection process, cancel the create process
			if (!pullRequestDescriptionMethod) {
				return;
			}

			const titleAndDescriptionDefaults = await this.getPullRequestTitleAndDescriptionDefaults(progress, pullRequestDescriptionMethod);

			// User cancelled a quick input, cancel the create process
			if (!titleAndDescriptionDefaults) {
				return;
			}

			let { title, description } = titleAndDescriptionDefaults;

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

			switch (pullRequestDescriptionMethod) {
				case PullRequestDescriptionSourceEnum.Custom:
					const descriptionResult = await vscode.window.showInputBox({
						value: description.replace(/\n+/g, ' '),
						ignoreFocusOut: true,
						prompt: `Enter PR description`
					});

					description = descriptionResult || '';
			}

			const createParams = {
				title,
				body: description,
				base: target,
				// For cross-repository pull requests, the owner must be listed. Always list to be safe. See https://developer.github.com/v3/pulls/#create-a-pull-request.
				head: `${headRemote.owner}:${branchName}`,
				owner: targetRemote!.owner,
				repo: targetRemote!.name,
				draft: draft
			};

			const pullRequestModel = await this._folderRepoManager.createPullRequest(createParams);

			if (pullRequestModel) {
				progress.report({ increment: 30, message: `Pull Request #${pullRequestModel.number} Created` });
				await this.updateState();
				await vscode.commands.executeCommand('pr.openDescription', pullRequestModel);
				progress.report({ increment: 30 });
			} else {
				// error: Unhandled Rejection at: Promise [object Promise]. Reason: {"message":"Validation Failed","errors":[{"resource":"PullRequest","code":"custom","message":"A pull request already exists for rebornix:tree-sitter."}],"documentation_url":"https://developer.github.com/v3/pulls/#create-a-pull-request"}.
				progress.report({ increment: 90, message: `Failed to create pull request for ${branchName}` });
			}
		});
	}

	private updateFocusedViewMode(): void {
		const focusedSetting = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get('focusedMode');
		if (focusedSetting && this._folderRepoManager.activePullRequest) {
			vscode.commands.executeCommand('setContext', FOCUS_REVIEW_MODE, true);
			this._context.workspaceState.update(FOCUS_REVIEW_MODE, true);
		} else {
			vscode.commands.executeCommand('setContext', FOCUS_REVIEW_MODE, false);
			this._context.workspaceState.update(FOCUS_REVIEW_MODE, false);
		}
	}

	private clear(quitReviewMode: boolean) {
		this._updateMessageShown = false;

		this._localToDispose.forEach(disposeable => disposeable.dispose());

		if (quitReviewMode) {
			this._prNumber = undefined;
			this._folderRepoManager.activePullRequest = undefined;

			if (this._statusBarItem) {
				this._statusBarItem.hide();
			}

			if (this.changesInPrDataProvider) {
				this.changesInPrDataProvider.removePrFromView(this._folderRepoManager);
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

	static getReviewManagerForRepository(reviewManagers: ReviewManager[], repository: GitHubRepository): ReviewManager | undefined {
		return reviewManagers.find(reviewManager => reviewManager._folderRepoManager.gitHubRepositories.some(repo => repo.equals(repository)));
	}

	static getReviewManagerForFolderManager(reviewManagers: ReviewManager[], folderManager: FolderRepositoryManager): ReviewManager | undefined {
		return reviewManagers.find(reviewManager => reviewManager._folderRepoManager === folderManager);
	}
}
