/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nodePath from 'path';
import * as vscode from 'vscode';
import type { Branch, Repository } from '../api/api';
import { GitErrorCodes } from '../api/api1';
import { openDescription } from '../commands';
import { DiffChangeType, parseDiff } from '../common/diffHunk';
import { GitChangeType, InMemFileChange, SlimFileChange } from '../common/file';
import Logger from '../common/logger';
import { parseRepositoryRemotes, Remote } from '../common/remote';
import { ISessionState } from '../common/sessionState';
import { PR_SETTINGS_NAMESPACE, USE_REVIEW_MODE } from '../common/settingKeys';
import { ITelemetry } from '../common/telemetry';
import { fromReviewUri, toReviewUri } from '../common/uri';
import { formatError, groupBy } from '../common/utils';
import { FOCUS_REVIEW_MODE } from '../constants';
import { NEVER_SHOW_PULL_NOTIFICATION } from '../extensionState';
import { PullRequestViewProvider } from '../github/activityBarViewProvider';
import { GitHubCreatePullRequestLinkProvider } from '../github/createPRLinkProvider';
import { FolderRepositoryManager, SETTINGS_NAMESPACE } from '../github/folderRepositoryManager';
import { GitHubRepository, ViewerPermission } from '../github/githubRepository';
import { PullRequestGitHelper } from '../github/pullRequestGitHelper';
import { IResolvedPullRequestModel, PullRequestModel } from '../github/pullRequestModel';
import { CreatePullRequestHelper } from './createPullRequestHelper';
import { PullRequestChangesTreeDataProvider } from './prChangesTreeDataProvider';
import { RemoteQuickPickItem } from './quickpick';
import { ReviewCommentController } from './reviewCommentController';
import { ReviewModel } from './reviewModel';
import { GitFileChangeNode, gitFileChangeNodeFilter, RemoteFileChangeNode } from './treeNodes/fileChangeNode';

export class ReviewManager {
	public static ID = 'Review';
	private _localToDispose: vscode.Disposable[] = [];
	private _disposables: vscode.Disposable[];

	private _reviewModel: ReviewModel = new ReviewModel();
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
	private _createPullRequestHelper: CreatePullRequestHelper | undefined;

	private _switchingToReviewMode: boolean;

	/**
	 * Flag set when the "Checkout" action is used and cleared on the next git
	 * state update, once review mode has been entered. Used to disambiguate
	 * explicit user action from something like reloading on an existing PR branch.
	 */
	private justSwitchedToReviewMode: boolean = false;

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
		private readonly _repository: Repository,
		private _folderRepoManager: FolderRepositoryManager,
		private _telemetry: ITelemetry,
		public changesInPrDataProvider: PullRequestChangesTreeDataProvider,
		private _showPullRequest: ShowPullRequest,
		private readonly _sessionState: ISessionState
	) {
		this._switchingToReviewMode = false;
		this._disposables = [];

		this._previousRepositoryState = {
			HEAD: _repository.state.HEAD,
			remotes: parseRepositoryRemotes(this._repository),
		};

		this.registerListeners();

		this.updateState(true);
		this.pollForStatusChange();
	}

	private registerListeners(): void {
		this._disposables.push(
			this._repository.state.onDidChange(_ => {
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
						? newHead.upstream &&
						oldHead.upstream.name === newHead.upstream.name &&
						oldHead.upstream.remote === newHead.upstream.remote
						: !newHead.upstream;
				}

				const sameHead =
					sameUpstream && // falsy if oldHead or newHead is undefined.
					oldHead!.ahead === newHead!.ahead &&
					oldHead!.behind === newHead!.behind &&
					oldHead!.commit === newHead!.commit &&
					oldHead!.name === newHead!.name &&
					oldHead!.remote === newHead!.remote &&
					oldHead!.type === newHead!.type;

				const remotes = parseRepositoryRemotes(this._repository);
				const sameRemotes =
					this._previousRepositoryState.remotes.length === remotes.length &&
					this._previousRepositoryState.remotes.every(remote => remotes.some(r => remote.equals(r)));

				if (!sameHead || !sameRemotes) {
					this._previousRepositoryState = {
						HEAD: this._repository.state.HEAD,
						remotes: remotes,
					};

					// The first time this event occurs we do want to do visible updates.
					// The first time, oldHead will be undefined.
					// For subsequent changes, we don't want to make visible updates.
					// This occurs on branch changes.
					// Note that the visible changes will occur when checking out a PR.
					this.updateState(true);
				}
			}),
		);

		this._disposables.push(
			vscode.workspace.onDidChangeConfiguration(_ => {
				this.updateFocusedViewMode();
			}),
		);

		this._disposables.push(
			this._folderRepoManager.onDidChangeActivePullRequest(_ => {
				this.updateFocusedViewMode();
			}),
		);

		GitHubCreatePullRequestLinkProvider.registerProvider(this._disposables, this, this._folderRepoManager);
	}

	get statusBarItem() {
		if (!this._statusBarItem) {
			this._statusBarItem = vscode.window.createStatusBarItem('github.pullrequest.status', vscode.StatusBarAlignment.Left);
			this._statusBarItem.name = 'GitHub Active Pull Request';
		}

		return this._statusBarItem;
	}

	get repository(): Repository {
		return this._repository;
	}

	private pollForStatusChange() {
		setTimeout(async () => {
			if (!this._validateStatusInProgress) {
				await this.updateComments();
			}
			this.pollForStatusChange();
		}, 1000 * 60 * 5);
	}

	private async checkBranchUpToDate(pr: PullRequestModel & IResolvedPullRequestModel): Promise<void> {
		const branch = this._repository.state.HEAD;
		if (branch) {
			const remote = branch.upstream ? branch.upstream.remote : null;
			if (remote) {
				await this._repository.fetch(remote, this._repository.state.HEAD?.name);
				const canShowNotification = !this._context.globalState.get<boolean>(NEVER_SHOW_PULL_NOTIFICATION, false);
				if (canShowNotification && !this._updateMessageShown &&
					((this._lastCommitSha && (pr.head.sha !== this._lastCommitSha))
						|| (branch.behind !== undefined && branch.behind > 0))
				) {
					this._updateMessageShown = true;
					const pull = 'Pull';
					const never = 'Never show again';
					const result = await vscode.window.showInformationMessage(
						`There are updates available for pull request ${pr.number}: ${pr.title}.`,
						{},
						pull,
						never
					);

					if (result === pull) {
						if (this._repository.state.HEAD?.name === branch.name) {
							await this._repository.pull();
						}
						this._updateMessageShown = false;
					} else if (never) {
						await this._context.globalState.update(NEVER_SHOW_PULL_NOTIFICATION, true);
					}
				}
			}
		}
	}

	public async updateState(silent: boolean = false, openDiff: boolean = true) {
		if (this.switchingToReviewMode) {
			return;
		}
		if (!this._validateStatusInProgress) {
			Logger.appendLine('Review> Validate state in progress');
			this._validateStatusInProgress = this.validateStatueAndSetContext(silent, openDiff);
			return this._validateStatusInProgress;
		} else {
			Logger.appendLine('Review> Queuing additional validate state');
			this._validateStatusInProgress = this._validateStatusInProgress.then(async _ => {
				return await this.validateStatueAndSetContext(silent, openDiff);
			});

			return this._validateStatusInProgress;
		}
	}

	private async validateStatueAndSetContext(silent: boolean, openDiff: boolean) {
		await this.validateState(silent, openDiff);
		await vscode.commands.executeCommand('setContext', 'github:stateValidated', true);
	}

	private async validateState(silent: boolean, openDiff: boolean) {
		Logger.appendLine('Review> Validating state...');
		await this._folderRepoManager.updateRepositories(false);

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
				PullRequestGitHelper.associateBranchWithPullRequest(
					this._repository,
					metadataFromGithub.model,
					branch.name!,
				);
				matchingPullRequestMetadata = metadataFromGithub;
			}
		}

		if (!matchingPullRequestMetadata) {
			Logger.appendLine(
				`Review> no matching pull request metadata found on GitHub for current branch ${branch.name}`,
			);
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
		Logger.appendLine(
			`Review> current branch ${this._repository.state.HEAD.name} is associated with pull request #${matchingPullRequestMetadata.prNumber}`,
		);
		this.clear(false);
		this._prNumber = matchingPullRequestMetadata.prNumber;
		this._lastCommitSha = undefined;

		const { owner, repositoryName } = matchingPullRequestMetadata;
		Logger.appendLine('Review> Resolving pull request');
		const pr = await this._folderRepoManager.resolvePullRequest(
			owner,
			repositoryName,
			matchingPullRequestMetadata.prNumber,
		);
		if (!pr || !pr.isResolved()) {
			this._prNumber = undefined;
			Logger.appendLine('Review> This PR is no longer valid');
			return;
		}

		const useReviewConfiguration = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<string[]>(USE_REVIEW_MODE, []);

		if (pr.isClosed && !useReviewConfiguration.includes('closed')) {
			this.clear(true);
			Logger.appendLine('Review> This PR is closed');
			return;
		}

		if (pr.isMerged && !useReviewConfiguration.includes('merged')) {
			this.clear(true);
			Logger.appendLine('Review> This PR is merged');
			return;
		}

		this._folderRepoManager.activePullRequest = pr;
		this._lastCommitSha = pr.head.sha;

		if (this._isFirstLoad) {
			this._isFirstLoad = false;
			this.checkBranchUpToDate(pr);
		}

		Logger.appendLine('Review> Fetching pull request data');
		// Don't await. Events will be fired as part of the initialization.
		this.initializePullRequestData(pr);
		await this.changesInPrDataProvider.addPrToView(
			this._folderRepoManager,
			pr,
			this._reviewModel,
			this.justSwitchedToReviewMode,
		);
		this.justSwitchedToReviewMode = false;

		Logger.appendLine(`Review> register comments provider`);
		await this.registerCommentController();
		const isFocusMode = this._context.workspaceState.get(FOCUS_REVIEW_MODE);

		if (!this._webviewViewProvider) {
			this._webviewViewProvider = new PullRequestViewProvider(
				this._context.extensionUri,
				this._folderRepoManager,
				pr,
			);
			this._context.subscriptions.push(
				vscode.window.registerWebviewViewProvider(
					this._webviewViewProvider.viewType,
					this._webviewViewProvider,
				),
			);
			this._context.subscriptions.push(
				vscode.commands.registerCommand('pr.refreshActivePullRequest', _ => {
					this._webviewViewProvider?.refresh();
				}),
			);
		} else {
			this._webviewViewProvider.updatePullRequest(pr);
		}

		this.statusBarItem.text = `$(git-pull-request) Pull Request #${this._prNumber}`;
		this.statusBarItem.command = {
			command: 'pr.openDescription',
			title: 'View Pull Request Description',
			arguments: [pr],
		};
		Logger.appendLine(`Review> display pull request status bar indicator and refresh pull request tree view.`);
		this.statusBarItem.show();
		vscode.commands.executeCommand('pr.refreshList');

		Logger.appendLine(`Review> using focus mode = ${isFocusMode}.`);
		Logger.appendLine(`Review> state validation silent = ${silent}.`);
		Logger.appendLine(`Review> PR show should show = ${this._showPullRequest.shouldShow}.`);
		if ((!silent || this._showPullRequest.shouldShow) && isFocusMode) {
			this._doFocusShow(openDiff);
		} else if (!this._showPullRequest.shouldShow && isFocusMode) {
			const showPRChangedDisposable = this._showPullRequest.onChangedShowValue(shouldShow => {
				Logger.appendLine(`Review> PR show value changed = ${shouldShow}.`);
				if (shouldShow) {
					this._doFocusShow(openDiff);
				}
				showPRChangedDisposable.dispose();
			});
			this._localToDispose.push(showPRChangedDisposable);
		}

		this._validateStatusInProgress = undefined;
	}

	private openDiff() {
		if (this._reviewModel.localFileChanges.length) {
			let fileChangeToShow: GitFileChangeNode | undefined;
			for (const fileChange of this._reviewModel.localFileChanges) {
				if (fileChange.status === GitChangeType.MODIFY) {
					fileChangeToShow = fileChange;
					break;
				}
			}
			fileChangeToShow = fileChangeToShow ?? this._reviewModel.localFileChanges[0];
			fileChangeToShow.openDiff(this._folderRepoManager);
		}
	}

	private _doFocusShow(openDiff: boolean) {
		this._webviewViewProvider?.show();
		if (openDiff) {
			if (this._reviewModel.localFileChanges.length) {
				this.openDiff();
			} else {
				const localFileChangesDisposable = this._reviewModel.onDidChangeLocalFileChanges(() => {
					localFileChangesDisposable.dispose();
					this.openDiff();
				});
			}
		}
	}

	public async updateComments(): Promise<void> {
		const branch = this._repository.state.HEAD;
		if (!branch) {
			return;
		}

		const matchingPullRequestMetadata = await this._folderRepoManager.getMatchingPullRequestMetadataForBranch();
		if (!matchingPullRequestMetadata) {
			return;
		}

		const remote = branch.upstream ? branch.upstream.remote : null;
		if (!remote) {
			return;
		}

		if (this._prNumber === undefined || !this._folderRepoManager.activePullRequest) {
			return;
		}

		const pr = await this._folderRepoManager.resolvePullRequest(
			matchingPullRequestMetadata.owner,
			matchingPullRequestMetadata.repositoryName,
			this._prNumber,
		);

		if (!pr || !pr.isResolved()) {
			Logger.appendLine('Review> This PR is no longer valid');
			return;
		}

		await this.checkBranchUpToDate(pr);

		await this.initializePullRequestData(pr);
		await this._reviewCommentController.update();

		return Promise.resolve(void 0);
	}

	private async getLocalChangeNodes(
		pr: PullRequestModel & IResolvedPullRequestModel,
		contentChanges: (InMemFileChange | SlimFileChange)[],
	): Promise<GitFileChangeNode[]> {
		const nodes: GitFileChangeNode[] = [];
		const mergeBase = pr.mergeBase || pr.base.sha;
		const headSha = pr.head.sha;

		for (let i = 0; i < contentChanges.length; i++) {
			const change = contentChanges[i];
			const filePath = nodePath.join(this._repository.rootUri.path, change.fileName).replace(/\\/g, '/');
			const uri = this._repository.rootUri.with({ path: filePath });

			const modifiedFileUri =
				change.status === GitChangeType.DELETE
					? toReviewUri(uri, undefined, undefined, '', false, { base: false }, this._repository.rootUri)
					: uri;

			const originalFileUri = toReviewUri(
				uri,
				change.status === GitChangeType.RENAME ? change.previousFileName : change.fileName,
				undefined,
				change.status === GitChangeType.ADD ? '' : mergeBase,
				false,
				{ base: true },
				this._repository.rootUri,
			);

			const changedItem = new GitFileChangeNode(
				this.changesInPrDataProvider,
				this._folderRepoManager,
				pr,
				change,
				modifiedFileUri,
				originalFileUri,
				headSha,
			);
			nodes.push(changedItem);
		}

		return nodes;
	}

	private async initializePullRequestData(pr: PullRequestModel & IResolvedPullRequestModel): Promise<void> {
		try {
			const data = await pr.getFileChangesInfo();
			const mergeBase = pr.mergeBase || pr.base.sha;

			const contentChanges = await parseDiff(data, this._repository, mergeBase!);
			this._reviewModel.localFileChanges = await this.getLocalChangeNodes(pr, contentChanges);
			await Promise.all([pr.initializeReviewComments(), pr.initializeReviewThreadCache(), pr.initializePullRequestFileViewState()]);
			const outdatedComments = pr.comments.filter(comment => !comment.position);

			const commitsGroup = groupBy(outdatedComments, comment => comment.originalCommitId!);
			const obsoleteFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[] = [];
			for (const commit in commitsGroup) {
				const commentsForCommit = commitsGroup[commit];
				const commentsForFile = groupBy(commentsForCommit, comment => comment.path!);

				for (const fileName in commentsForFile) {
					const oldComments = commentsForFile[fileName];
					const uri = vscode.Uri.file(nodePath.join(`commit~${commit.substr(0, 8)}`, fileName));
					const obsoleteFileChange = new GitFileChangeNode(
						this.changesInPrDataProvider,
						this._folderRepoManager,
						pr,
						{
							status: GitChangeType.MODIFY,
							fileName,
							blobUrl: undefined,
						},
						toReviewUri(
							uri,
							fileName,
							undefined,
							oldComments[0].originalCommitId!,
							true,
							{ base: false },
							this._repository.rootUri,
						),
						toReviewUri(
							uri,
							fileName,
							undefined,
							oldComments[0].originalCommitId!,
							true,
							{ base: true },
							this._repository.rootUri,
						),
						commit,
						false,
						oldComments
					);

					obsoleteFileChanges.push(obsoleteFileChange);
				}
			}
			this._reviewModel.obsoleteFileChanges = obsoleteFileChanges;

			return Promise.resolve(void 0);
		} catch (e) {
			Logger.appendLine(`Review> ${e}`);
		}
	}

	private async registerCommentController() {
		if (this._folderRepoManager.activePullRequest?.reviewThreadsCacheReady && this._reviewModel.hasLocalFileChanges) {
			await this.doRegisterCommentController();
		} else {
			const changeThreadsDisposable: vscode.Disposable | undefined =
				this._folderRepoManager.activePullRequest?.onDidChangeReviewThreads(async () => {
					if (changeThreadsDisposable) {
						changeThreadsDisposable.dispose();
					}
					if (this._folderRepoManager.activePullRequest?.reviewThreadsCache && this._reviewModel.hasLocalFileChanges) {
						await this.doRegisterCommentController();
					}
				});
		}
	}

	private async doRegisterCommentController() {
		this._reviewCommentController = new ReviewCommentController(
			this,
			this._folderRepoManager,
			this._repository,
			this._reviewModel,
			this._sessionState
		);

		await this._reviewCommentController.initialize();

		this._localToDispose.push(this._reviewCommentController);
		this._localToDispose.push(
			this._reviewCommentController.onDidChangeComments(comments => {
				if (this._folderRepoManager.activePullRequest) {
					this._folderRepoManager.activePullRequest.comments = comments;
				}
			}),
		);
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

			if (e.message === 'User aborted') {
				// The user cancelled the action
			} else if (e.gitErrorCode && (
				e.gitErrorCode === GitErrorCodes.LocalChangesOverwritten ||
				e.gitErrorCode === GitErrorCodes.DirtyWorkTree
			)) {
				// for known git errors, we should provide actions for users to continue.
				vscode.window.showErrorMessage(
					'Your local changes would be overwritten by checkout, please commit your changes or stash them before you switch branches',
				);
			} else if ((e.stderr as string).startsWith('fatal: couldn\'t find remote ref')) {
				vscode.window.showErrorMessage('The remote branch for this pull request has been deleted. The pull request cannot be checked out.');
			} else {
				vscode.window.showErrorMessage(formatError(e));
			}
			// todo, we should try to recover, for example, git checkout succeeds but set config fails.
			if (this._folderRepoManager.activePullRequest) {
				this.setStatusForPr(this._folderRepoManager.activePullRequest);
			} else {
				this.statusBarItem.hide();
				this.switchingToReviewMode = false;
			}
			return;
		}

		try {
			this.statusBarItem.text = `$(sync~spin) Fetching additional data: pr/${pr.number}`;
			this.statusBarItem.command = undefined;
			this.statusBarItem.show();

			await this._folderRepoManager.fulfillPullRequestMissingInfo(pr);

			/* __GDPR__
				"pr.checkout" : {}
			*/
			this._telemetry.sendTelemetryEvent('pr.checkout');
			Logger.appendLine(`Review> switch to Pull Request #${pr.number} - done`, ReviewManager.ID);
		} finally {
			this.setStatusForPr(pr);
			await this._repository.status();
		}
	}

	private setStatusForPr(pr: PullRequestModel) {
		this.switchingToReviewMode = false;
		this.justSwitchedToReviewMode = true;
		this.statusBarItem.text = `Pull Request #${pr.number}`;
		this.statusBarItem.command = undefined;
		this.statusBarItem.show();
	}

	public async publishBranch(branch: Branch): Promise<Branch | undefined> {
		const potentialTargetRemotes = await this._folderRepoManager.getAllGitHubRemotes();
		let selectedRemote = (await this.getRemote(
			potentialTargetRemotes,
			`Pick a remote to publish the branch '${branch.name}' to:`,
		))!.remote;

		if (!selectedRemote || branch.name === undefined) {
			return;
		}

		const githubRepo = this._folderRepoManager.createGitHubRepository(
			selectedRemote,
			this._folderRepoManager.credentialStore,
		);
		const permission = await githubRepo.getViewerPermission();
		if (
			permission === ViewerPermission.Read ||
			permission === ViewerPermission.Triage ||
			permission === ViewerPermission.Unknown
		) {
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

		return new Promise<Branch | undefined>(async resolve => {
			const inputBox = vscode.window.createInputBox();
			inputBox.value = branch.name!;
			inputBox.ignoreFocusOut = true;
			inputBox.prompt =
				potentialTargetRemotes.length === 1
					? `The branch '${branch.name}' is not published yet, pick a name for the upstream branch`
					: 'Pick a name for the upstream branch';
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
					// since we are probably pushing a remote branch with a different name, we use the complete syntax
					// git push -u origin local_branch:remote_branch
					await this._repository.push(remote.remoteName, `${branch.name}:${inputBox.value}`, true);
				} catch (err) {
					if (err.gitErrorCode === GitErrorCodes.PushRejected) {
						vscode.window.showWarningMessage(
							`Can't push refs to remote, try running 'git pull' first to integrate with your change`,
							{
								modal: true,
							},
						);

						resolve(undefined);
					}

					if (err.gitErrorCode === GitErrorCodes.RemoteConnectionError) {
						vscode.window.showWarningMessage(
							`Could not read from remote repository '${remote.remoteName}'. Please make sure you have the correct access rights and the repository exists.`,
							{
								modal: true,
							},
						);

						resolve(undefined);
					}

					// we can't handle the error
					throw err;
				}

				// we don't want to wait for repository status update
				const latestBranch = await this._repository.getBranch(branch.name!);
				if (!latestBranch || !latestBranch.upstream) {
					resolve(undefined);
				}

				resolve(latestBranch);
			});

			inputBox.show();
		});
	}

	private async getRemote(
		potentialTargetRemotes: Remote[],
		placeHolder: string,
		defaultUpstream?: RemoteQuickPickItem,
	): Promise<RemoteQuickPickItem | undefined> {
		if (!potentialTargetRemotes.length) {
			vscode.window.showWarningMessage(`No GitHub remotes found. Add a remote and try again.`);
			return;
		}

		if (potentialTargetRemotes.length === 1 && !defaultUpstream) {
			return RemoteQuickPickItem.fromRemote(potentialTargetRemotes[0]);
		}

		if (
			potentialTargetRemotes.length === 1 &&
			defaultUpstream &&
			defaultUpstream.owner === potentialTargetRemotes[0].owner &&
			defaultUpstream.name === potentialTargetRemotes[0].repositoryName
		) {
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

		const selected: RemoteQuickPickItem | undefined = await vscode.window.showQuickPick<RemoteQuickPickItem>(
			picks,
			{
				ignoreFocusOut: true,
				placeHolder: placeHolder,
			},
		);

		if (!selected) {
			return;
		}

		return selected;
	}

	public async createPullRequest(compareBranch?: string): Promise<void> {
		if (!this._createPullRequestHelper) {
			this._createPullRequestHelper = new CreatePullRequestHelper(this.repository);
			this._createPullRequestHelper.onDidCreate(async createdPR => {
				await this.updateState(false, false);
				const descriptionNode = this.changesInPrDataProvider.getDescriptionNode(this._folderRepoManager);
				await openDescription(
					this._context,
					this._telemetry,
					createdPR,
					descriptionNode,
					this._folderRepoManager,
				);
			});
		}

		this._createPullRequestHelper.create(this._context.extensionUri, this._folderRepoManager, compareBranch);
	}

	public async openDescription(): Promise<void> {
		const pullRequest = this._folderRepoManager.activePullRequest;
		if (!pullRequest) {
			return;
		}

		const descriptionNode = this.changesInPrDataProvider.getDescriptionNode(this._folderRepoManager);
		await openDescription(
			this._context,
			this._telemetry,
			pullRequest,
			descriptionNode,
			this._folderRepoManager,
		);
	}

	get isCreatingPullRequest() {
		return this._createPullRequestHelper?.isCreatingPullRequest ?? false;
	}

	private async updateFocusedViewMode(): Promise<void> {
		const focusedSetting = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get('focusedMode');
		if (focusedSetting) {
			vscode.commands.executeCommand('setContext', FOCUS_REVIEW_MODE, true);
			await this._context.workspaceState.update(FOCUS_REVIEW_MODE, true);
		} else {
			vscode.commands.executeCommand('setContext', FOCUS_REVIEW_MODE, false);
			this._context.workspaceState.update(FOCUS_REVIEW_MODE, false);
		}
	}

	private clear(quitReviewMode: boolean) {
		this._updateMessageShown = false;
		this._reviewModel.clear();
		this._localToDispose.forEach(disposable => disposable.dispose());
		// Ensure file explorer decorations are removed. When switching to a different PR branch,
		// comments are recalculated when getting the data and the change decoration fired then,
		// so comments only needs to be emptied in this case.
		this._folderRepoManager.activePullRequest?.clear();

		if (quitReviewMode) {
			this._prNumber = undefined;
			this._folderRepoManager.activePullRequest = undefined;

			if (this._statusBarItem) {
				this._statusBarItem.hide();
			}

			if (this.changesInPrDataProvider) {
				this.changesInPrDataProvider.removePrFromView(this._folderRepoManager);
			}

			vscode.commands.executeCommand('pr.refreshList');
		}
	}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string | undefined> {
		const { path, commit } = fromReviewUri(uri.query);
		let changedItems = gitFileChangeNodeFilter(this._reviewModel.localFileChanges)
			.filter(change => change.fileName === path)
			.filter(
				fileChange =>
					fileChange.sha === commit ||
					(fileChange.parentSha ? fileChange.parentSha : `${fileChange.sha}^`) === commit,
			);

		if (changedItems.length) {
			const changedItem = changedItems[0];
			const diffChangeTypeFilter = commit === changedItem.sha ? DiffChangeType.Delete : DiffChangeType.Add;
			const ret = (await changedItem.diffHunks()).map(diffHunk =>
				diffHunk.diffLines
					.filter(diffLine => diffLine.type !== diffChangeTypeFilter)
					.map(diffLine => diffLine.text),
			);
			return ret.reduce((prev, curr) => prev.concat(...curr), []).join('\n');
		}

		changedItems = gitFileChangeNodeFilter(this._reviewModel.obsoleteFileChanges)
			.filter(change => change.fileName === path)
			.filter(
				fileChange =>
					fileChange.sha === commit ||
					(fileChange.parentSha ? fileChange.parentSha : `${fileChange.sha}^`) === commit,
			);

		if (changedItems.length) {
			// it's from obsolete file changes, which means the content is in complete.
			const changedItem = changedItems[0];
			const diffChangeTypeFilter = commit === changedItem.sha ? DiffChangeType.Delete : DiffChangeType.Add;
			const ret: string[] = [];
			const commentGroups = groupBy(changedItem.comments, comment => String(comment.originalPosition));

			for (const comment_position in commentGroups) {
				if (!commentGroups[comment_position][0].diffHunks) {
					continue;
				}

				const lines = commentGroups[comment_position][0]
					.diffHunks!.map(diffHunk =>
						diffHunk.diffLines
							.filter(diffLine => diffLine.type !== diffChangeTypeFilter)
							.map(diffLine => diffLine.text),
					)
					.reduce((prev, curr) => prev.concat(...curr), []);
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

	static getReviewManagerForRepository(
		reviewManagers: ReviewManager[],
		repository: GitHubRepository,
	): ReviewManager | undefined {
		return reviewManagers.find(reviewManager =>
			reviewManager._folderRepoManager.gitHubRepositories.some(repo => repo.equals(repository)),
		);
	}

	static getReviewManagerForFolderManager(
		reviewManagers: ReviewManager[],
		folderManager: FolderRepositoryManager,
	): ReviewManager | undefined {
		return reviewManagers.find(reviewManager => reviewManager._folderRepoManager === folderManager);
	}
}

export class ShowPullRequest {
	private _shouldShow: boolean = false;
	private _onChangedShowValue: vscode.EventEmitter<boolean> = new vscode.EventEmitter();
	public readonly onChangedShowValue: vscode.Event<boolean> = this._onChangedShowValue.event;
	constructor() { }
	get shouldShow(): boolean {
		return this._shouldShow;
	}
	set shouldShow(shouldShow: boolean) {
		const oldShowValue = this._shouldShow;
		this._shouldShow = shouldShow;
		if (oldShowValue !== this._shouldShow) {
			this._onChangedShowValue.fire(this._shouldShow);
		}
	}
}
