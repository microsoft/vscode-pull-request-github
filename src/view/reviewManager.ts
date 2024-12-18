/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nodePath from 'path';
import * as vscode from 'vscode';
import type { Branch, Change, Repository } from '../api/api';
import { GitApiImpl, GitErrorCodes, Status } from '../api/api1';
import { openDescription } from '../commands';
import { DiffChangeType, DiffHunk, parsePatch, splitIntoSmallerHunks } from '../common/diffHunk';
import { commands } from '../common/executeCommands';
import { GitChangeType, InMemFileChange, SlimFileChange } from '../common/file';
import { Disposable, disposeAll, toDisposable } from '../common/lifecycle';
import Logger from '../common/logger';
import { parseRepositoryRemotes, Remote } from '../common/remote';
import {
	COMMENTS,
	FOCUSED_MODE,
	IGNORE_PR_BRANCHES,
	NEVER_IGNORE_DEFAULT_BRANCH,
	OPEN_VIEW,
	POST_CREATE,
	PR_SETTINGS_NAMESPACE,
	PULL_PR_BRANCH_BEFORE_CHECKOUT,
	PullPRBranchVariants,
	QUICK_DIFF,
} from '../common/settingKeys';
import { getReviewMode } from '../common/settingsUtils';
import { ITelemetry } from '../common/telemetry';
import { fromPRUri, fromReviewUri, KnownMediaExtensions, PRUriParams, Schemes, toReviewUri } from '../common/uri';
import { formatError, groupBy, onceEvent } from '../common/utils';
import { FOCUS_REVIEW_MODE } from '../constants';
import { GitHubCreatePullRequestLinkProvider } from '../github/createPRLinkProvider';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { GitHubRepository } from '../github/githubRepository';
import { GithubItemStateEnum } from '../github/interface';
import { PullRequestGitHelper, PullRequestMetadata } from '../github/pullRequestGitHelper';
import { IResolvedPullRequestModel, PullRequestModel } from '../github/pullRequestModel';
import { CreatePullRequestHelper } from './createPullRequestHelper';
import { GitFileChangeModel, InMemFileChangeModel, RemoteFileChangeModel } from './fileChangeModel';
import { getInMemPRFileSystemProvider, provideDocumentContentForChangeModel } from './inMemPRContentProvider';
import { PullRequestChangesTreeDataProvider } from './prChangesTreeDataProvider';
import { ProgressHelper } from './progress';
import { PullRequestsTreeDataProvider } from './prsTreeDataProvider';
import { ReviewCommentController, SuggestionInformation } from './reviewCommentController';
import { ReviewModel } from './reviewModel';
import { GitFileChangeNode, gitFileChangeNodeFilter, RemoteFileChangeNode } from './treeNodes/fileChangeNode';
import { WebviewViewCoordinator } from './webviewViewCoordinator';

export class ReviewManager extends Disposable {
	public static ID = 'Review';
	private readonly _localToDispose: vscode.Disposable[] = [];

	private readonly _reviewModel: ReviewModel = new ReviewModel();
	private _lastCommitSha?: string;
	private _validateStatusInProgress?: Promise<void>;
	private _reviewCommentController: ReviewCommentController | undefined;
	private _quickDiffProvider: vscode.Disposable | undefined;
	private _inMemGitHubContentProvider: vscode.Disposable | undefined;

	private _statusBarItem: vscode.StatusBarItem;
	private _prNumber?: number;
	private _isShowingLastReviewChanges: boolean = false;
	private _previousRepositoryState: {
		HEAD: Branch | undefined;
		remotes: Remote[];
	};

	private _switchingToReviewMode: boolean;
	private _changesSinceLastReviewProgress: ProgressHelper = new ProgressHelper();
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
			this.updateState(true);
		}
	}

	private _isFirstLoad = true;

	constructor(
		private _id: number,
		private _context: vscode.ExtensionContext,
		private readonly _repository: Repository,
		private _folderRepoManager: FolderRepositoryManager,
		private _telemetry: ITelemetry,
		public changesInPrDataProvider: PullRequestChangesTreeDataProvider,
		private _pullRequestsTree: PullRequestsTreeDataProvider,
		private _showPullRequest: ShowPullRequest,
		private readonly _activePrViewCoordinator: WebviewViewCoordinator,
		private _createPullRequestHelper: CreatePullRequestHelper,
		private _gitApi: GitApiImpl
	) {
		super();
		this._switchingToReviewMode = false;

		this._previousRepositoryState = {
			HEAD: _repository.state.HEAD,
			remotes: parseRepositoryRemotes(this._repository),
		};
		this._register(toDisposable(() => disposeAll(this._localToDispose)));

		this.registerListeners();

		if (_gitApi.state === 'initialized') {
			this.updateState(true);
		}
		this.pollForStatusChange();
	}

	private registerListeners(): void {
		this._register(this._repository.state.onDidChange(_ => {
			const oldHead = this._previousRepositoryState.HEAD;
			const newHead = this._repository.state.HEAD;

			if (!oldHead && !newHead) {
				// both oldHead and newHead are undefined
				return;
			}

			let sameUpstream: boolean | undefined;

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

			if (oldHead && newHead) {
				this.updateBaseBranchMetadata(oldHead, newHead);
			}
		}));

		this._register(vscode.workspace.onDidChangeConfiguration(e => {
			this.updateFocusedViewMode();
			if (e.affectsConfiguration(`${PR_SETTINGS_NAMESPACE}.${IGNORE_PR_BRANCHES}`)) {
				this.validateStateAndResetPromise(true, false);
			}
		}));

		this._register(this._folderRepoManager.onDidChangeActivePullRequest(_ => {
			this.updateFocusedViewMode();
			this.registerQuickDiff();
		}));

		this._register(GitHubCreatePullRequestLinkProvider.registerProvider(this, this._folderRepoManager));
	}

	private async updateBaseBranchMetadata(oldHead: Branch, newHead: Branch) {
		if (!oldHead.commit || (oldHead.commit !== newHead.commit) || !newHead.name || !oldHead.name || (oldHead.name === newHead.name)) {
			return;
		}

		let githubRepository = this._folderRepoManager.gitHubRepositories.find(repo => repo.remote.remoteName === oldHead.upstream?.remote);
		if (githubRepository) {
			const metadata = await githubRepository.getMetadata();
			if (metadata.fork && oldHead.name === metadata.default_branch) {
				// For forks, we use the upstream repo if it's available. Otherwise, fallback to the fork.
				githubRepository = this._folderRepoManager.gitHubRepositories.find(repo => repo.remote.owner === metadata.parent?.owner?.login && repo.remote.repositoryName === metadata.parent?.name) ?? githubRepository;
			}
			return PullRequestGitHelper.associateBaseBranchWithBranch(this.repository, newHead.name, githubRepository.remote.owner, githubRepository.remote.repositoryName, oldHead.name);
		}
	}

	private registerQuickDiff() {
		if (vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<boolean>(QUICK_DIFF)) {
			if (this._quickDiffProvider) {
				this._quickDiffProvider.dispose();
				this._quickDiffProvider = undefined;
			}
			const label = this._folderRepoManager.activePullRequest ? vscode.l10n.t('GitHub pull request #{0}', this._folderRepoManager.activePullRequest.number) : vscode.l10n.t('GitHub pull request');
			this._register(this._quickDiffProvider = vscode.window.registerQuickDiffProvider({ scheme: 'file' }, {
				provideOriginalResource: (uri: vscode.Uri) => {
					const changeNode = this.reviewModel.localFileChanges.find(changeNode => changeNode.changeModel.filePath.toString() === uri.toString());
					if (changeNode) {
						return changeNode.changeModel.parentFilePath;
					}
				}
			}, label, this.repository.rootUri));
		}
	}


	get statusBarItem() {
		if (!this._statusBarItem) {
			this._statusBarItem = vscode.window.createStatusBarItem('github.pullrequest.status', vscode.StatusBarAlignment.Left);
			this._statusBarItem.name = vscode.l10n.t('GitHub Active Pull Request');
		}

		return this._statusBarItem;
	}

	get repository(): Repository {
		return this._repository;
	}

	get reviewModel() {
		return this._reviewModel;
	}

	private pollForStatusChange() {
		setTimeout(async () => {
			if (!this._validateStatusInProgress && this._folderRepoManager.activePullRequest) {
				await this.updateComments();
			}
			this.pollForStatusChange();
		}, 1000 * 60 * 5);
	}

	private get id(): string {
		return `${ReviewManager.ID}+${this._id}`;
	}

	public async updateState(silent: boolean = false, updateLayout: boolean = true) {
		if (this.switchingToReviewMode) {
			return;
		}
		if (!this._validateStatusInProgress) {
			Logger.appendLine('Validate state in progress', this.id);
			this._validateStatusInProgress = this.validateStatusAndSetContext(silent, updateLayout);
			return this._validateStatusInProgress;
		} else {
			Logger.appendLine('Queuing additional validate state', this.id);
			this._validateStatusInProgress = this._validateStatusInProgress.then(async _ => {
				return await this.validateStatusAndSetContext(silent, updateLayout);
			});

			return this._validateStatusInProgress;
		}
	}

	private async validateStatusAndSetContext(silent: boolean, updateLayout: boolean) {
		// Network errors can cause one of the GitHub API calls in validateState to never return.
		let timeout: NodeJS.Timeout | undefined;
		const timeoutPromise = new Promise<void>(resolve => {
			timeout = setTimeout(() => {
				if (timeout) {
					clearTimeout(timeout);
					timeout = undefined;
					Logger.error('Timeout occurred while validating state.', this.id);
					/* __GDPR__
						"pr.checkout" : {
							"version" : { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" }
						}
					*/
					this._telemetry.sendTelemetryErrorEvent('pr.validateStateTimeout', { version: this._context.extension.packageJSON.version });
				}
				resolve();
			}, 1000 * 60 * 2);
		});

		const validatePromise = new Promise<void>(resolve => {
			this.validateStateAndResetPromise(silent, updateLayout).then(() => {
				vscode.commands.executeCommand('setContext', 'github:stateValidated', true).then(() => {
					if (timeout) {
						clearTimeout(timeout);
						timeout = undefined;
					}
					resolve();
				});
			});
		});

		return Promise.race([validatePromise, timeoutPromise]);
	}

	private async offerIgnoreBranch(currentBranchName): Promise<boolean> {
		const ignoreBranchStateKey = 'githubPullRequest.showOfferIgnoreBranch';
		const showOffer = this._context.workspaceState.get(ignoreBranchStateKey, true);
		if (!showOffer) {
			return false;
		}
		// Only show once per day.
		const lastOfferTimeKey = 'githubPullRequest.offerIgnoreBranchTime';
		const lastOfferTime = this._context.workspaceState.get<number>(lastOfferTimeKey, 0);
		const currentTime = new Date().getTime();
		if ((currentTime - lastOfferTime) < (1000 * 60 * 60 * 24)) { // 1 day
			return false;
		}
		const { base } = await this._folderRepoManager.getPullRequestDefaults(currentBranchName);
		if (base !== currentBranchName) {
			return false;
		}
		await this._context.workspaceState.update(lastOfferTimeKey, currentTime);
		const ignore = vscode.l10n.t('Ignore Pull Request');
		const dontShow = vscode.l10n.t('Don\'t Show Again');
		const offerResult = await vscode.window.showInformationMessage(
			vscode.l10n.t(`There\'s a pull request associated with the default branch '{0}'. Do you want to ignore this Pull Request?`, currentBranchName),
			ignore,
			dontShow);
		if (offerResult === ignore) {
			Logger.appendLine(`Branch ${currentBranchName} will now be ignored in ${IGNORE_PR_BRANCHES}.`, this.id);
			const settingNamespace = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE);
			const setting = settingNamespace.get<string[]>(IGNORE_PR_BRANCHES, []);
			setting.push(currentBranchName);
			await settingNamespace.update(IGNORE_PR_BRANCHES, setting);
			return true;
		} else if (offerResult === dontShow) {
			await this._context.workspaceState.update(ignoreBranchStateKey, false);
			return false;
		}
		return false;
	}

	private async getUpstreamUrlAndName(branch: Branch): Promise<{ url: string | undefined, branchName: string | undefined, remoteName: string | undefined }> {
		if (branch.upstream) {
			return { remoteName: branch.upstream.remote, branchName: branch.upstream.name, url: undefined };
		} else {
			try {
				const url = await this.repository.getConfig(`branch.${branch.name}.remote`);
				const upstreamBranch = await this.repository.getConfig(`branch.${branch.name}.merge`);
				let branchName: string | undefined;
				if (upstreamBranch) {
					branchName = upstreamBranch.substring('refs/heads/'.length);
				}
				return { url, branchName, remoteName: undefined };
			} catch (e) {
				Logger.appendLine(`Failed to get upstream for branch ${branch.name} from git config.`, this.id);
				return { url: undefined, branchName: undefined, remoteName: undefined };
			}
		}
	}

	private async checkGitHubForPrBranch(branch: Branch): Promise<(PullRequestMetadata & { model: PullRequestModel }) | undefined> {
		const { url, branchName, remoteName } = await this.getUpstreamUrlAndName(this._repository.state.HEAD!);
		const metadataFromGithub = await this._folderRepoManager.getMatchingPullRequestMetadataFromGitHub(branch, remoteName, url, branchName);
		if (metadataFromGithub) {
			Logger.appendLine(`Found matching pull request metadata on GitHub for current branch ${branch.name}. Repo: ${metadataFromGithub.owner}/${metadataFromGithub.repositoryName} PR: ${metadataFromGithub.prNumber}`);
			await PullRequestGitHelper.associateBranchWithPullRequest(
				this._repository,
				metadataFromGithub.model,
				branch.name!,
			);
			return metadataFromGithub;
		}
	}

	private async resolvePullRequest(metadata: PullRequestMetadata): Promise<(PullRequestModel & IResolvedPullRequestModel) | undefined> {
		try {
			this._prNumber = metadata.prNumber;

			const { owner, repositoryName } = metadata;
			Logger.appendLine('Resolving pull request', this.id);
			let pr = await this._folderRepoManager.resolvePullRequest(owner, repositoryName, metadata.prNumber);

			if (!pr || !pr.isResolved() || !(await pr.githubRepository.hasBranch(pr.base.name))) {
				await this.clear(true);
				this._prNumber = undefined;
				Logger.appendLine('This PR is no longer valid', this.id);
				return;
			}
			return pr;
		} catch (e) {
			Logger.appendLine(`Pull request cannot be resolved: ${e.message}`, this.id);
		}
	}

	private async validateStateAndResetPromise(silent: boolean, updateLayout: boolean): Promise<void> {
		return this.validateState(silent, updateLayout).then(() => {
			this._validateStatusInProgress = undefined;
		});
	}

	private async validateState(silent: boolean, updateLayout: boolean) {
		Logger.appendLine('Validating state...', this.id);
		const oldLastCommitSha = this._lastCommitSha;
		this._lastCommitSha = undefined;
		if (!(await this._folderRepoManager.updateRepositories(false))) {
			return;
		}

		if (!this._repository.state.HEAD) {
			await this.clear(true);
			return;
		}

		const branch = this._repository.state.HEAD;
		const ignoreBranches = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<string[]>(IGNORE_PR_BRANCHES);
		const remoteName = branch.remote ?? branch.upstream?.remote;
		if (ignoreBranches?.find(value => value === branch.name) && ((remoteName === 'origin') || !(await this._folderRepoManager.gitHubRepositories.find(repo => repo.remote.remoteName === remoteName)?.getMetadata())?.fork)) {
			Logger.appendLine(`Branch ${branch.name} is ignored in ${IGNORE_PR_BRANCHES}.`, this.id);
			await this.clear(true);
			return;
		}

		let matchingPullRequestMetadata = await this._folderRepoManager.getMatchingPullRequestMetadataForBranch();

		if (!matchingPullRequestMetadata) {
			Logger.appendLine(`No matching pull request metadata found locally for current branch ${branch.name}`, this.id);
			matchingPullRequestMetadata = await this.checkGitHubForPrBranch(branch);
		}

		if (!matchingPullRequestMetadata) {
			Logger.appendLine(
				`No matching pull request metadata found on GitHub for current branch ${branch.name}`, this.id
			);
			await this.clear(true);
			return;
		}
		Logger.appendLine(`Found matching pull request metadata for current branch ${branch.name}. Repo: ${matchingPullRequestMetadata.owner}/${matchingPullRequestMetadata.repositoryName} PR: ${matchingPullRequestMetadata.prNumber}`, this.id);

		const remote = branch.upstream ? branch.upstream.remote : null;
		if (!remote) {
			Logger.appendLine(`Current branch ${this._repository.state.HEAD.name} hasn't setup remote yet`, this.id);
			await this.clear(true);
			return;
		}

		// we switch to another PR, let's clean up first.
		Logger.appendLine(
			`current branch ${this._repository.state.HEAD.name} is associated with pull request #${matchingPullRequestMetadata.prNumber}`, this.id
		);
		const previousPrNumber = this._prNumber;
		let pr = await this.resolvePullRequest(matchingPullRequestMetadata);
		if (!pr) {
			Logger.appendLine(`Unable to resolve PR #${matchingPullRequestMetadata.prNumber}`, this.id);
			return;
		}
		Logger.appendLine(`Resolved PR #${matchingPullRequestMetadata.prNumber}, state is ${pr.state}`, this.id);

		// Check if the PR is open, if not, check if there's another PR from the same branch on GitHub
		if (pr.state !== GithubItemStateEnum.Open) {
			const metadataFromGithub = await this.checkGitHubForPrBranch(branch);
			if (metadataFromGithub && metadataFromGithub?.prNumber !== pr.number) {
				const prFromGitHub = await this.resolvePullRequest(metadataFromGithub);
				if (prFromGitHub) {
					pr = prFromGitHub;
				}
			}
		}

		const hasPushedChanges = branch.commit !== oldLastCommitSha && branch.ahead === 0 && branch.behind === 0;
		if (previousPrNumber === pr.number && !hasPushedChanges && (this._isShowingLastReviewChanges === pr.showChangesSinceReview)) {
			return;
		}
		this._isShowingLastReviewChanges = pr.showChangesSinceReview;
		if (previousPrNumber !== pr.number) {
			this.clear(false);
		}

		const useReviewConfiguration = getReviewMode();

		if (pr.isClosed && !useReviewConfiguration.closed) {
			Logger.appendLine('This PR is closed', this.id);
			await this.clear(true);
			return;
		}

		if (pr.isMerged && !useReviewConfiguration.merged) {
			Logger.appendLine('This PR is merged', this.id);
			await this.clear(true);
			return;
		}

		const neverIgnoreDefaultBranch = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<boolean>(NEVER_IGNORE_DEFAULT_BRANCH, false);
		if (!neverIgnoreDefaultBranch) {
			// Do not await the result of offering to ignore the branch.
			this.offerIgnoreBranch(branch.name);
		}

		const previousActive = this._folderRepoManager.activePullRequest;
		this._folderRepoManager.activePullRequest = pr;
		this._lastCommitSha = pr.head.sha;

		if (this._isFirstLoad) {
			this._isFirstLoad = false;
			this._folderRepoManager.checkBranchUpToDate(pr, true);
		}

		Logger.appendLine('Fetching pull request data', this.id);
		if (!silent) {
			onceEvent(this._reviewModel.onDidChangeLocalFileChanges)(() => {
				if (pr) {
					this._upgradePullRequestEditors(pr);
				}
			});
		}
		// Don't await. Events will be fired as part of the initialization.
		this.initializePullRequestData(pr);
		await this.changesInPrDataProvider.addPrToView(
			this._folderRepoManager,
			pr,
			this._reviewModel,
			this.justSwitchedToReviewMode,
			this._changesSinceLastReviewProgress
		);

		Logger.appendLine(`Register comments provider`, this.id);
		await this.registerCommentController();

		this._activePrViewCoordinator.setPullRequest(pr, this._folderRepoManager, this, previousActive);
		this._localToDispose.push(
			pr.onDidChangeChangesSinceReview(async _ => {
				this._changesSinceLastReviewProgress.startProgress();
				this.changesInPrDataProvider.refresh();
				await this.updateComments();
				await this.reopenNewReviewDiffs();
				this._changesSinceLastReviewProgress.endProgress();
			})
		);
		Logger.appendLine(`Register in memory content provider`, this.id);
		await this.registerGitHubInMemContentProvider();

		this.statusBarItem.text = '$(git-pull-request) ' + vscode.l10n.t('Pull Request #{0}', pr.number);
		this.statusBarItem.command = {
			command: 'pr.openDescription',
			title: vscode.l10n.t('View Pull Request Description'),
			arguments: [pr],
		};
		Logger.appendLine(`Display pull request status bar indicator.`, this.id);
		this.statusBarItem.show();

		this.layout(pr, updateLayout, this.justSwitchedToReviewMode ? false : silent);
		this.justSwitchedToReviewMode = false;
	}

	private layout(pr: PullRequestModel, updateLayout: boolean, silent: boolean) {
		const isFocusMode = this._context.workspaceState.get<boolean>(FOCUS_REVIEW_MODE);

		Logger.appendLine(`Using focus mode = ${isFocusMode}.`, this.id);
		Logger.appendLine(`State validation silent = ${silent}.`, this.id);
		Logger.appendLine(`PR show should show = ${this._showPullRequest.shouldShow}.`, this.id);

		if ((!silent || this._showPullRequest.shouldShow) && isFocusMode) {
			this._doFocusShow(pr, updateLayout);
		} else if (!this._showPullRequest.shouldShow && isFocusMode) {
			const showPRChangedDisposable = this._showPullRequest.onChangedShowValue(shouldShow => {
				Logger.appendLine(`PR show value changed = ${shouldShow}.`, this.id);
				if (shouldShow) {
					this._doFocusShow(pr, updateLayout);
				}
				showPRChangedDisposable.dispose();
			});
			this._localToDispose.push(showPRChangedDisposable);
		}
	}

	private async reopenNewReviewDiffs() {
		let hasOpenDiff = false;
		await Promise.all(vscode.window.tabGroups.all.map(tabGroup => {
			return tabGroup.tabs.map(tab => {
				if (tab.input instanceof vscode.TabInputTextDiff) {
					if ((tab.input.original.scheme === Schemes.Review)) {

						for (const localChange of this._reviewModel.localFileChanges) {
							const fileName = fromReviewUri(tab.input.original.query);

							if (localChange.fileName === fileName.path) {
								hasOpenDiff = true;
								vscode.window.tabGroups.close(tab).then(_ => localChange.openDiff(this._folderRepoManager, { preview: tab.isPreview }));
								break;
							}
						}

					}
				}
				return Promise.resolve(undefined);
			});
		}).flat());

		if (!hasOpenDiff && this._reviewModel.localFileChanges.length) {
			this._reviewModel.localFileChanges[0].openDiff(this._folderRepoManager, { preview: true });
		}
	}

	private openDiff() {
		if (this._reviewModel.localFileChanges.length) {
			let fileChangeToShow: GitFileChangeNode[] = [];
			for (const fileChange of this._reviewModel.localFileChanges) {
				if (fileChange.status === GitChangeType.MODIFY) {
					if (KnownMediaExtensions.includes(nodePath.extname(fileChange.fileName))) {
						fileChangeToShow.push(fileChange);
					} else {
						fileChangeToShow.unshift(fileChange);
						break;
					}
				}
			}
			const change = fileChangeToShow.length ? fileChangeToShow[0] : this._reviewModel.localFileChanges[0];
			change.openDiff(this._folderRepoManager);
		}
	}

	private _doFocusShow(pr: PullRequestModel, updateLayout: boolean) {
		// Respect the setting 'comments.openView' when it's 'never'.
		const shouldShowCommentsView = vscode.workspace.getConfiguration(COMMENTS).get<'never' | string>(OPEN_VIEW);
		if ((shouldShowCommentsView !== 'never') && (pr.hasComments)) {
			commands.executeCommand('workbench.action.focusCommentsPanel');
		}
		this._activePrViewCoordinator.show(pr);
		if (updateLayout) {
			const focusedMode = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<'firstDiff' | 'overview' | 'multiDiff' | false>(FOCUSED_MODE);
			if (focusedMode === 'firstDiff') {
				if (this._reviewModel.localFileChanges.length) {
					this.openDiff();
				} else {
					const localFileChangesDisposable = this._reviewModel.onDidChangeLocalFileChanges(() => {
						localFileChangesDisposable.dispose();
						this.openDiff();
					});
				}
			} else if (focusedMode === 'overview') {
				return this.openDescription();
			} else if (focusedMode === 'multiDiff') {
				return PullRequestModel.openChanges(this._folderRepoManager, pr);
			}
		}
	}

	public async _upgradePullRequestEditors(pullRequest: PullRequestModel) {
		// Go through all open editors and find pr scheme editors that belong to the active pull request.
		// Close the editors, and reopen them from the pull request.
		const reopenFilenames: Set<[PRUriParams, PRUriParams]> = new Set();
		await Promise.all(vscode.window.tabGroups.all.map(tabGroup => {
			return tabGroup.tabs.map(tab => {
				if (tab.input instanceof vscode.TabInputTextDiff) {
					if ((tab.input.original.scheme === Schemes.Pr) && (tab.input.modified.scheme === Schemes.Pr)) {
						const originalParams = fromPRUri(tab.input.original);
						const modifiedParams = fromPRUri(tab.input.modified);
						if ((originalParams?.prNumber === pullRequest.number) && (modifiedParams?.prNumber === pullRequest.number)) {
							reopenFilenames.add([originalParams, modifiedParams]);
							return vscode.window.tabGroups.close(tab);
						}
					}
				}
				return Promise.resolve(undefined);
			});
		}).flat());
		const reopenPromises: Promise<void>[] = [];
		if (reopenFilenames.size) {
			for (const localChange of this.reviewModel.localFileChanges) {
				for (const prFileChange of reopenFilenames) {
					if (Array.isArray(prFileChange)) {
						const modifiedPrChange = prFileChange[1];
						if (localChange.fileName === modifiedPrChange.fileName) {
							reopenPromises.push(localChange.openDiff(this._folderRepoManager, { preview: false }));
							reopenFilenames.delete(prFileChange);
							break;
						}
					}
				}
			}
		}
		return Promise.all(reopenPromises);
	}

	async createSuggestionFromChange(editor: vscode.TextDocument, diffLines: vscode.LineChange[]) {
		const change = this._reviewModel.localFileChanges.find(change => change.changeModel.filePath.toString() === editor.uri.toString());

		if (!change) {
			return;
		}
		const suggestions: (SuggestionInformation & { diffLine: vscode.LineChange })[] = [];
		for (const line of diffLines) {
			const content = editor.getText(new vscode.Range(line.modifiedStartLineNumber - 1, 0, line.modifiedEndLineNumber - 1, editor.lineAt(line.modifiedEndLineNumber - 1).range.end.character));
			const originalEndLineNumber = line.originalEndLineNumber < line.originalStartLineNumber ? line.originalStartLineNumber : line.originalEndLineNumber;
			suggestions.push({
				suggestionContent: content,
				originalLineLength: originalEndLineNumber - line.originalStartLineNumber + 1,
				originalStartLine: line.originalStartLineNumber,
				diffLine: line
			});
		}
		await Promise.all(suggestions.map(async (suggestion) => {
			try {
				await this._reviewCommentController?.createSuggestionsFromChanges(editor.uri, suggestion);
				await vscode.commands.executeCommand('git.revertSelectedRanges', suggestion.diffLine);
			} catch (e) {
				vscode.window.showErrorMessage(vscode.l10n.t('The change is outside the commenting range.'), { modal: true });
			}
		}));
	}

	private trimContextFromHunk(hunk: DiffHunk) {
		let oldLineNumber = hunk.oldLineNumber;
		let oldLength = hunk.oldLength;

		let i = 0;
		for (; i < hunk.diffLines.length; i++) {
			const line = hunk.diffLines[i];
			if (line.type === DiffChangeType.Control) {
				continue;
			}
			if (line.type === DiffChangeType.Context) {
				oldLineNumber++;
				oldLength--;
			} else {
				break;
			}
		}
		let j = hunk.diffLines.length - 1;
		for (; j >= 0; j--) {
			if (hunk.diffLines[j].type === DiffChangeType.Context) {
				oldLength--;
			} else {
				break;
			}
		}

		let slice = hunk.diffLines.slice(i, j + 1);

		if (slice.every(line => line.type === DiffChangeType.Add)) {
			// we have only inserted lines, so we need to include a context line so that
			// there's a line to anchor the suggestion to
			if (i > 1) {
				// include from the beginning of the hunk
				i--;
				oldLineNumber--;
				oldLength++;
			} else if (j < hunk.diffLines.length - 1) {
				// include from the end of the hunk
				j++;
				oldLength++;
			} else {
				// include entire context
				i = 1;
				j = hunk.diffLines.length - 1;
			}
			slice = hunk.diffLines.slice(i, j + 1);
		}

		hunk.diffLines = slice;
		hunk.oldLength = oldLength;
		hunk.oldLineNumber = oldLineNumber;
	}

	private convertDiffHunkToSuggestion(hunk: DiffHunk): SuggestionInformation {
		this.trimContextFromHunk(hunk);
		return {
			suggestionContent: hunk.diffLines.filter(line => (line.type === DiffChangeType.Add) || (line.type == DiffChangeType.Context)).map(line => line.text).join('\n'),
			originalLineLength: hunk.oldLength,
			originalStartLine: hunk.oldLineNumber,
		};
	}

	async createSuggestionsFromChanges(resources: vscode.Uri[]) {
		const resourceStrings = resources.map(resource => resource.toString());
		let hasError: boolean = false;
		let diffCount: number = 0;
		const convertedFiles: vscode.Uri[] = [];

		const convertOneSmallHunk = async (changeFile: Change, hunk: DiffHunk) => {
			try {
				await this._reviewCommentController?.createSuggestionsFromChanges(changeFile.uri, this.convertDiffHunkToSuggestion(hunk));
				convertedFiles.push(changeFile.uri);
			} catch (e) {
				hasError = true;
			}
		};

		const getDiffFromChange = async (changeFile: Change) => {
			if (!resourceStrings.includes(changeFile.uri.toString()) || (changeFile.status !== Status.MODIFIED)) {
				return;
			}
			return parsePatch(await this._folderRepoManager.repository.diffWithHEAD(changeFile.uri.fsPath)).map(hunk => splitIntoSmallerHunks(hunk)).flat();
		};

		const convertAllChangesInFile = async (changeFile: Change, parallel: boolean) => {
			const diff = await getDiffFromChange(changeFile);
			if (diff) {
				diffCount += diff.length;
				if (parallel) {
					await Promise.allSettled(diff.map(async hunk => {
						return convertOneSmallHunk(changeFile, hunk);
					}));
				} else {
					for (const hunk of diff) {
						await convertOneSmallHunk(changeFile, hunk);
					}
				}
			}
		};

		await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Converting changes to suggestions' }, async () => {
			// We need to create one suggestion first. This let's us ensure that only one review will be created.
			let i = 0;
			for (; (convertedFiles.length === 0) && (i < this._folderRepoManager.repository.state.workingTreeChanges.length); i++) {
				const changeFile = this._folderRepoManager.repository.state.workingTreeChanges[i];
				await convertAllChangesInFile(changeFile, false);
			}

			// If we have already created a suggestion, we can create the rest in parallel
			const promises: Promise<void>[] = [];
			for (; i < this._folderRepoManager.repository.state.workingTreeChanges.length; i++) {
				const changeFile = this._folderRepoManager.repository.state.workingTreeChanges[i];
				promises.push(convertAllChangesInFile(changeFile, true));
			}

			await Promise.all(promises);
		});
		if (!hasError) {
			const checkoutAllFilesResponse = vscode.l10n.t('Reset all changes');
			vscode.window.showInformationMessage(vscode.l10n.t('All changes have been converted to suggestions.'), { modal: true, detail: vscode.l10n.t('Do you want to reset your local changes?') }, checkoutAllFilesResponse).then((response) => {
				if (response === checkoutAllFilesResponse) {
					return Promise.all(convertedFiles.map(changeFile => this._folderRepoManager.repository.checkout(changeFile.fsPath)));
				}
			});
		} else if (convertedFiles.length) {
			vscode.window.showWarningMessage(vscode.l10n.t('Not all changes could be converted to suggestions.'), { detail: vscode.l10n.t('{0} of {1} changes converted. Some of the changes may be outside of commenting ranges.\nYour changes are still available locally.', convertedFiles.length, diffCount), modal: true });
		} else {
			vscode.window.showWarningMessage(vscode.l10n.t('No changes could be converted to suggestions.'), { detail: vscode.l10n.t('All of the changes are outside of commenting ranges.'), modal: true });
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
			Logger.warn('This PR is no longer valid', this.id);
			return;
		}

		await this._folderRepoManager.checkBranchUpToDate(pr, false);

		await this.initializePullRequestData(pr);
		await this._reviewCommentController?.update();

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

			const changeModel = new GitFileChangeModel(this._folderRepoManager, pr, change, modifiedFileUri, originalFileUri, headSha, contentChanges.length < 20);
			const changedItem = new GitFileChangeNode(
				this.changesInPrDataProvider,
				this._folderRepoManager,
				pr,
				changeModel
			);
			nodes.push(changedItem);
		}

		return nodes;
	}

	private async initializePullRequestData(pr: PullRequestModel & IResolvedPullRequestModel): Promise<void> {
		try {
			const contentChanges = await pr.getFileChangesInfo();
			this._reviewModel.localFileChanges = await this.getLocalChangeNodes(pr, contentChanges);
			await Promise.all([pr.initializeReviewThreadCacheAndReviewComments(), pr.initializePullRequestFileViewState()]);
			this._folderRepoManager.setFileViewedContext();
			const outdatedComments = pr.comments.filter(comment => !comment.position);

			const commitsGroup = groupBy(outdatedComments, comment => comment.originalCommitId!);
			const obsoleteFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[] = [];
			for (const commit in commitsGroup) {
				const commentsForCommit = commitsGroup[commit];
				const commentsForFile = groupBy(commentsForCommit, comment => comment.path!);

				for (const fileName in commentsForFile) {
					const oldComments = commentsForFile[fileName];
					const uri = vscode.Uri.file(nodePath.join(`commit~${commit.substr(0, 8)}`, fileName));
					const changeModel = new GitFileChangeModel(
						this._folderRepoManager,
						pr,
						{
							status: GitChangeType.MODIFY,
							fileName,
							blobUrl: undefined,

						}, toReviewUri(
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
						commit);
					const obsoleteFileChange = new GitFileChangeNode(
						this.changesInPrDataProvider,
						this._folderRepoManager,
						pr,
						changeModel,
						false,
						oldComments
					);

					obsoleteFileChanges.push(obsoleteFileChange);
				}
			}
			this._reviewModel.obsoleteFileChanges = obsoleteFileChanges;

			return Promise.resolve(void 0);
		} catch (e) {
			Logger.error(`Failed to initialize PR data ${e}`, this.id);
		}
	}

	private async registerGitHubInMemContentProvider() {
		try {
			this._inMemGitHubContentProvider?.dispose();
			this._inMemGitHubContentProvider = undefined;

			const pr = this._folderRepoManager.activePullRequest;
			if (!pr) {
				return;
			}
			const rawChanges = await pr.getFileChangesInfo();
			const mergeBase = pr.mergeBase;
			if (!mergeBase) {
				return;
			}
			const changes = rawChanges.map(change => {
				if (change instanceof SlimFileChange) {
					return new RemoteFileChangeModel(this._folderRepoManager, change, pr);
				}
				return new InMemFileChangeModel(this._folderRepoManager,
					pr as (PullRequestModel & IResolvedPullRequestModel),
					change, true, mergeBase);
			});

			this._inMemGitHubContentProvider = getInMemPRFileSystemProvider()?.registerTextDocumentContentProvider(
				pr.number,
				async (uri: vscode.Uri): Promise<string | Uint8Array> => {
					const params = fromPRUri(uri);
					if (!params) {
						return '';
					}
					const fileChange = changes.find(
						contentChange => contentChange.fileName === params.fileName,
					);

					if (!fileChange) {
						Logger.error(`Cannot find content for document ${uri.toString()}`, 'PR');
						return '';
					}

					return provideDocumentContentForChangeModel(this._folderRepoManager, pr, params, fileChange);
				},
			);
		} catch (e) {
			Logger.error(`Failed to register in mem content provider: ${e}`, this.id);
		}
	}

	private async registerCommentController() {
		if (this._folderRepoManager.activePullRequest?.reviewThreadsCacheReady && this._reviewModel.hasLocalFileChanges) {
			await this.doRegisterCommentController();
		} else {
			const changedLocalFilesChangesDisposable: vscode.Disposable | undefined =
				this._reviewModel.onDidChangeLocalFileChanges(async () => {
					if (this._folderRepoManager.activePullRequest?.reviewThreadsCache && this._reviewModel.hasLocalFileChanges) {
						if (changedLocalFilesChangesDisposable) {
							changedLocalFilesChangesDisposable.dispose();
						}
						await this.doRegisterCommentController();
					}
				});
		}
	}

	private async doRegisterCommentController() {
		if (!this._reviewCommentController) {
			this._reviewCommentController = new ReviewCommentController(
				this,
				this._folderRepoManager,
				this._repository,
				this._reviewModel,
				this._gitApi,
				this._telemetry
			);

			await this._reviewCommentController.initialize();
		}
	}

	public async switch(pr: PullRequestModel): Promise<void> {
		Logger.appendLine(`Switch to Pull Request #${pr.number} - start`, this.id);
		this.statusBarItem.text = vscode.l10n.t('{0} Switching to Review Mode', '$(sync~spin)');
		this.statusBarItem.command = undefined;
		this.statusBarItem.show();
		this.switchingToReviewMode = true;

		try {
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification }, async (progress) => {
				const didLocalCheckout = await this._folderRepoManager.checkoutExistingPullRequestBranch(pr, progress);

				if (!didLocalCheckout) {
					await this._folderRepoManager.fetchAndCheckout(pr, progress);
				}
			});
			const updateBaseSetting = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<PullPRBranchVariants>(PULL_PR_BRANCH_BEFORE_CHECKOUT, 'pull');
			if (updateBaseSetting === 'pullAndMergeBase' || updateBaseSetting === 'pullAndUpdateBase') {
				await this._folderRepoManager.tryMergeBaseIntoHead(pr, updateBaseSetting === 'pullAndUpdateBase');
			}

		} catch (e) {
			Logger.error(`Checkout failed #${JSON.stringify(e)}`, this.id);
			this.switchingToReviewMode = false;

			if (e.message === 'User aborted') {
				// The user cancelled the action
			} else if (e.gitErrorCode && (
				e.gitErrorCode === GitErrorCodes.LocalChangesOverwritten ||
				e.gitErrorCode === GitErrorCodes.DirtyWorkTree
			)) {
				// for known git errors, we should provide actions for users to continue.
				vscode.window.showErrorMessage(vscode.l10n.t(
					'Your local changes would be overwritten by checkout, please commit your changes or stash them before you switch branches'
				));
			} else if ((e.stderr as string)?.startsWith('fatal: couldn\'t find remote ref') && e.gitCommand === 'fetch') {
				// The pull request was checked out, but the upstream branch was deleted
				vscode.window.showInformationMessage('The remote branch for this pull request has been deleted. The file contents may not match the remote.');
			} else {
				vscode.window.showErrorMessage(formatError(e));
			}
			// todo, we should try to recover, for example, git checkout succeeds but set config fails.
			if (this._folderRepoManager.activePullRequest?.number === pr.number) {
				this.setStatusForPr(this._folderRepoManager.activePullRequest);
			} else {
				this.statusBarItem.hide();
			}
			return;
		}

		try {
			this.statusBarItem.text = '$(sync~spin) ' + vscode.l10n.t('Fetching additional data: {0}', `pr/${pr.number}`);
			this.statusBarItem.command = undefined;
			this.statusBarItem.show();

			await this._folderRepoManager.fulfillPullRequestMissingInfo(pr);
			this._upgradePullRequestEditors(pr);

			/* __GDPR__
				"pr.checkout" : {}
			*/
			this._telemetry.sendTelemetryEvent('pr.checkout');
			Logger.appendLine(`Switch to Pull Request #${pr.number} - done`, this.id);
		} finally {
			this.setStatusForPr(pr);
			await this._repository.status();
		}
	}

	private setStatusForPr(pr: PullRequestModel) {
		this.switchingToReviewMode = false;
		this.justSwitchedToReviewMode = true;
		this.statusBarItem.text = vscode.l10n.t('Pull Request #{0}', pr.number);
		this.statusBarItem.command = undefined;
		this.statusBarItem.show();
	}

	public async createPullRequest(compareBranch?: string): Promise<void> {
		const postCreate = async (createdPR: PullRequestModel | undefined) => {
			if (!createdPR) {
				return;
			}

			const postCreate = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<'none' | 'openOverview' | 'checkoutDefaultBranch' | 'checkoutDefaultBranchAndShow' | 'checkoutDefaultBranchAndCopy'>(POST_CREATE, 'openOverview');
			if (postCreate === 'openOverview') {
				const descriptionNode = this.changesInPrDataProvider.getDescriptionNode(this._folderRepoManager);
				await openDescription(
					this._telemetry,
					createdPR,
					descriptionNode,
					this._folderRepoManager,
					true
				);
			} else if (postCreate.startsWith('checkoutDefaultBranch')) {
				const defaultBranch = await this._folderRepoManager.getPullRequestRepositoryDefaultBranch(createdPR);
				if (defaultBranch) {
					if (postCreate === 'checkoutDefaultBranch') {
						await this._folderRepoManager.checkoutDefaultBranch(defaultBranch);
					} if (postCreate === 'checkoutDefaultBranchAndShow') {
						await commands.executeCommand('pr:github.focus');
						await this._folderRepoManager.checkoutDefaultBranch(defaultBranch);
						await this._pullRequestsTree.expandPullRequest(createdPR);
					} else if (postCreate === 'checkoutDefaultBranchAndCopy') {
						await Promise.all([
							this._folderRepoManager.checkoutDefaultBranch(defaultBranch),
							vscode.env.clipboard.writeText(createdPR.html_url)
						]);
					}
				}
			}
			await this.updateState(false, false);
		};

		return this._createPullRequestHelper.create(this._telemetry, this._context.extensionUri, this._folderRepoManager, compareBranch, postCreate);
	}

	public async openDescription(): Promise<void> {
		const pullRequest = this._folderRepoManager.activePullRequest;
		if (!pullRequest) {
			return;
		}

		const descriptionNode = this.changesInPrDataProvider.getDescriptionNode(this._folderRepoManager);
		await openDescription(
			this._telemetry,
			pullRequest,
			descriptionNode,
			this._folderRepoManager,
			true
		);
	}

	get isCreatingPullRequest() {
		return this._createPullRequestHelper?.isCreatingPullRequest ?? false;
	}

	private async updateFocusedViewMode(): Promise<void> {
		const focusedSetting = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get(FOCUSED_MODE);
		if (focusedSetting) {
			vscode.commands.executeCommand('setContext', FOCUS_REVIEW_MODE, true);
			await this._context.workspaceState.update(FOCUS_REVIEW_MODE, true);
		} else {
			vscode.commands.executeCommand('setContext', FOCUS_REVIEW_MODE, false);
			this._context.workspaceState.update(FOCUS_REVIEW_MODE, false);
		}
	}

	private async clear(quitReviewMode: boolean) {
		if (quitReviewMode) {
			const activePullRequest = this._folderRepoManager.activePullRequest;
			if (activePullRequest) {
				this._activePrViewCoordinator.removePullRequest(activePullRequest);
			}

			if (this.changesInPrDataProvider) {
				await this.changesInPrDataProvider.removePrFromView(this._folderRepoManager);
			}

			this._prNumber = undefined;
			this._folderRepoManager.activePullRequest = undefined;

			if (this._statusBarItem) {
				this._statusBarItem.hide();
			}

			this._reviewModel.clear();

			disposeAll(this._localToDispose);
			// Ensure file explorer decorations are removed. When switching to a different PR branch,
			// comments are recalculated when getting the data and the change decoration fired then,
			// so comments only needs to be emptied in this case.
			activePullRequest?.clear();
			this._folderRepoManager.setFileViewedContext();
		}

		this._reviewCommentController?.dispose();
		this._reviewCommentController = undefined;
		this._inMemGitHubContentProvider?.dispose();
		this._inMemGitHubContentProvider = undefined;
	}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string | undefined> {
		const { path, commit, base } = fromReviewUri(uri.query);
		let changedItems = gitFileChangeNodeFilter(this._reviewModel.localFileChanges)
			.filter(change => change.fileName === path)
			.filter(
				fileChange =>
					fileChange.sha === commit ||
					`${fileChange.sha}^` === commit,
			);

		if (changedItems.length) {
			const changedItem = changedItems[0];
			const diffChangeTypeFilter = commit === changedItem.sha ? DiffChangeType.Delete : DiffChangeType.Add;
			const ret = (await changedItem.changeModel.diffHunks()).map(diffHunk =>
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
					`${fileChange.sha}^` === commit,
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
		} else if (base && commit && this._folderRepoManager.activePullRequest) {
			// We can't get the content from git. Try to get it from github.
			const content = await this._folderRepoManager.activePullRequest.githubRepository.getFile(path, commit);
			return content.toString();
		}
	}

	override dispose() {
		super.dispose();
		this.clear(true);
	}

	static getReviewManagerForRepository(
		reviewManagers: ReviewManager[],
		githubRepository: GitHubRepository,
		repository?: Repository
	): ReviewManager | undefined {
		return reviewManagers.find(reviewManager =>
			reviewManager._folderRepoManager.gitHubRepositories.some(repo => {
				// If we don't have a Repository, then just get the first GH repo that fits
				// Otherwise, try to pick the review manager with the same repository.
				return repo.equals(githubRepository) && (!repository || (reviewManager._folderRepoManager.repository === repository));
			})
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
