/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as pathLib from 'path';
import * as vscode from 'vscode';
import { Repository } from './api/api';
import { GitErrorCodes } from './api/api1';
import { CommentReply, findActiveHandler, resolveCommentHandler } from './commentHandlerResolver';
import { commands } from './common/executeCommands';
import Logger from './common/logger';
import { FILE_LIST_LAYOUT, HIDE_VIEWED_FILES, PR_SETTINGS_NAMESPACE } from './common/settingKeys';
import { editQuery } from './common/settingsUtils';
import { ITelemetry } from './common/telemetry';
import { SessionLinkInfo } from './common/timelineEvent';
import { asTempStorageURI, fromPRUri, fromReviewUri, Schemes, toPRUri } from './common/uri';
import { formatError } from './common/utils';
import { EXTENSION_ID } from './constants';
import { CrossChatSessionWithPR } from './github/copilotApi';
import { CopilotRemoteAgentManager, SessionIdForPr } from './github/copilotRemoteAgent';
import { FolderRepositoryManager } from './github/folderRepositoryManager';
import { GitHubRepository } from './github/githubRepository';
import { Issue } from './github/interface';
import { IssueModel } from './github/issueModel';
import { IssueOverviewPanel } from './github/issueOverview';
import { GHPRComment, GHPRCommentThread, TemporaryComment } from './github/prComment';
import { PullRequestModel } from './github/pullRequestModel';
import { PullRequestOverviewPanel } from './github/pullRequestOverview';
import { chooseItem } from './github/quickPicks';
import { RepositoriesManager } from './github/repositoriesManager';
import { codespacesPrLink, getIssuesUrl, getPullsUrl, isInCodespaces, ISSUE_OR_URL_EXPRESSION, parseIssueExpressionOutput, vscodeDevPrLink } from './github/utils';
import { BaseContext, OverviewContext } from './github/views';
import { IssueChatContextItem } from './lm/issueContextProvider';
import { PRChatContextItem } from './lm/pullRequestContextProvider';
import { isNotificationTreeItem, NotificationTreeItem } from './notifications/notificationItem';
import { NotificationsManager } from './notifications/notificationsManager';
import { CreatePullRequestDataModel } from './view/createPullRequestDataModel';
import { PullRequestsTreeDataProvider } from './view/prsTreeDataProvider';
import { PrsTreeModel } from './view/prsTreeModel';
import { ReviewCommentController } from './view/reviewCommentController';
import { ReviewManager } from './view/reviewManager';
import { ReviewsManager } from './view/reviewsManager';
import { CategoryTreeNode } from './view/treeNodes/categoryNode';
import { CommitNode } from './view/treeNodes/commitNode';
import {
	FileChangeNode,
	GitFileChangeNode,
	InMemFileChangeNode,
	openFileCommand,
	RemoteFileChangeNode,
} from './view/treeNodes/fileChangeNode';
import { PRNode } from './view/treeNodes/pullRequestNode';
import { RepositoryChangesNode } from './view/treeNodes/repositoryChangesNode';

function ensurePR(folderRepoManager: FolderRepositoryManager, pr?: PRNode): PullRequestModel;
function ensurePR<TIssue extends Issue, TIssueModel extends IssueModel<TIssue>>(folderRepoManager: FolderRepositoryManager, pr?: TIssueModel): TIssueModel;
function ensurePR<TIssue extends Issue, TIssueModel extends IssueModel<TIssue>>(folderRepoManager: FolderRepositoryManager, pr?: PRNode | TIssueModel): TIssueModel {
	// If the command is called from the command palette, no arguments are passed.
	if (!pr) {
		if (!folderRepoManager.activePullRequest) {
			vscode.window.showErrorMessage(vscode.l10n.t('Unable to find current pull request.'));
			throw new Error('Unable to find current pull request.');
		}

		return folderRepoManager.activePullRequest as unknown as TIssueModel;
	} else {
		return (pr instanceof PRNode ? pr.pullRequestModel : pr) as TIssueModel;
	}
}

export async function openDescription(
	telemetry: ITelemetry,
	issueModel: IssueModel,
	descriptionNode: PRNode | RepositoryChangesNode | undefined,
	folderManager: FolderRepositoryManager,
	revealNode: boolean,
	preserveFocus: boolean = true,
) {
	const issue = ensurePR(folderManager, issueModel);
	if (revealNode) {
		descriptionNode?.reveal(descriptionNode, { select: true, focus: true });
	}
	const identity = {
		owner: issue.remote.owner,
		repo: issue.remote.repositoryName,
		number: issue.number
	};
	// Create and show a new webview
	if (issue instanceof PullRequestModel) {
		await PullRequestOverviewPanel.createOrShow(telemetry, folderManager.context.extensionUri, folderManager, identity, issue, undefined, preserveFocus);
	} else {
		await IssueOverviewPanel.createOrShow(telemetry, folderManager.context.extensionUri, folderManager, identity, issue);
		/* __GDPR__
			"issue.openDescription" : {}
		*/
		telemetry.sendTelemetryEvent('issue.openDescription');
	}
}

export async function openPullRequestOnGitHub(e: PRNode | RepositoryChangesNode | IssueModel | NotificationTreeItem, telemetry: ITelemetry) {
	if (e instanceof PRNode || e instanceof RepositoryChangesNode) {
		vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.pullRequestModel.html_url));
	} else if (isNotificationTreeItem(e)) {
		vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.model.html_url));
	} else {
		vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.html_url));
	}

	/** __GDPR__
		"pr.openInGitHub" : {}
	*/
	telemetry.sendTelemetryEvent('pr.openInGitHub');
}

export async function closeAllPrAndReviewEditors() {
	const tabs = vscode.window.tabGroups;
	const editors = tabs.all.map(group => group.tabs).flat();

	for (const tab of editors) {
		const scheme = tab.input instanceof vscode.TabInputTextDiff ? tab.input.original.scheme : (tab.input instanceof vscode.TabInputText ? tab.input.uri.scheme : undefined);
		if (scheme && (scheme === Schemes.Pr) || (scheme === Schemes.Review)) {
			await tabs.close(tab);
		}
	}
}

function isCrossChatSessionWithPR(value: any): value is CrossChatSessionWithPR {
	const asCrossChatSessionWithPR = value as Partial<CrossChatSessionWithPR>;
	return !!asCrossChatSessionWithPR.pullRequestDetails;
}

export function registerCommands(
	context: vscode.ExtensionContext,
	reposManager: RepositoriesManager,
	reviewsManager: ReviewsManager,
	telemetry: ITelemetry,
	copilotRemoteAgentManager: CopilotRemoteAgentManager,
	notificationManager: NotificationsManager,
	prsTreeModel: PrsTreeModel,
	tree: PullRequestsTreeDataProvider
) {
	const logId = 'RegisterCommands';

	PullRequestOverviewPanel.registerGlobalCommands(context, telemetry);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'pr.openPullRequestOnGitHub',
			async (e: PRNode | RepositoryChangesNode | PullRequestModel | undefined) => {
				if (!e) {
					const activePullRequests: PullRequestModel[] = reposManager.folderManagers
						.map(folderManager => folderManager.activePullRequest!)
						.filter(activePR => !!activePR);

					if (activePullRequests.length >= 1) {
						const result = await chooseItem<PullRequestModel>(
							activePullRequests,
							itemValue => ({ label: itemValue.html_url }),
						);
						if (result) {
							openPullRequestOnGitHub(result, telemetry);
						}
					}
				} else {
					openPullRequestOnGitHub(e, telemetry);
				}
			},
		),
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'notification.openOnGitHub',
			async (e: NotificationTreeItem | undefined) => {
				if (e) {
					openPullRequestOnGitHub(e, telemetry);
				}
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'pr.openAllDiffs',
			async () => {
				const activePullRequestsWithFolderManager = reposManager.folderManagers
					.filter(folderManager => folderManager.activePullRequest)
					.map(folderManager => {
						return (({ activePr: folderManager.activePullRequest!, folderManager }));
					});

				const activePullRequestAndFolderManager = activePullRequestsWithFolderManager.length >= 1
					? (
						await chooseItem(
							activePullRequestsWithFolderManager,
							itemValue => ({ label: itemValue.activePr.html_url }),
						)
					)
					: activePullRequestsWithFolderManager[0];

				if (!activePullRequestAndFolderManager) {
					return;
				}

				const { folderManager } = activePullRequestAndFolderManager;
				const reviewManager = ReviewManager.getReviewManagerForFolderManager(reviewsManager.reviewManagers, folderManager);

				if (!reviewManager) {
					return;
				}

				reviewManager.reviewModel.localFileChanges
					.forEach(localFileChange => localFileChange.openDiff(folderManager, { preview: false }));
			}
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.openFileOnGitHub', async (e: GitFileChangeNode | RemoteFileChangeNode) => {
			if (e instanceof RemoteFileChangeNode) {
				const choice = await vscode.window.showInformationMessage(
					vscode.l10n.t('{0} can\'t be opened locally. Do you want to open it on GitHub?', e.changeModel.fileName),
					vscode.l10n.t('Open'),
				);
				if (!choice) {
					return;
				}
			}
			if (e.changeModel.blobUrl) {
				return vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.changeModel.blobUrl));
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.copyCommitHash', (e: CommitNode) => {
			vscode.env.clipboard.writeText(e.sha);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.revealFileInOS', (e: GitFileChangeNode | InMemFileChangeNode | undefined) => {
			let fileChangeNode: FileChangeNode | undefined = e;
			// When invoked from a keybinding, get the selected item from the tree view
			if (!fileChangeNode) {
				// First check the prStatus:github tree (checked out PRs)
				for (const reviewManager of reviewsManager.reviewManagers) {
					const selection = reviewManager.changesInPrDataProvider.view.selection;
					const selectedFileChange = selection.find((node): node is GitFileChangeNode => node instanceof GitFileChangeNode);
					if (selectedFileChange) {
						fileChangeNode = selectedFileChange;
						break;
					}
				}
				// Then check the pr:github tree (non-checked out PRs)
				if (!fileChangeNode) {
					const prTreeSelection = tree.view.selection;
					const selectedInMemFileChange = prTreeSelection.find((node): node is InMemFileChangeNode => node instanceof InMemFileChangeNode);
					if (selectedInMemFileChange) {
						fileChangeNode = selectedInMemFileChange;
					}
				}
			}
			if (!fileChangeNode) {
				return;
			}
			const folderManager = reposManager.getManagerForIssueModel(fileChangeNode.pullRequest);
			if (folderManager) {
				const filePath = vscode.Uri.joinPath(folderManager.repository.rootUri, fileChangeNode.changeModel.fileName);
				vscode.commands.executeCommand('revealFileInOS', filePath);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.openOriginalFile', async (e: GitFileChangeNode) => {
			// if this is an image, encode it as a base64 data URI
			const folderManager = reposManager.getManagerForIssueModel(e.pullRequest);
			if (folderManager) {
				const imageDataURI = await asTempStorageURI(e.changeModel.parentFilePath, folderManager.repository);
				vscode.commands.executeCommand('vscode.open', imageDataURI || e.changeModel.parentFilePath);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.openModifiedFile', (e: GitFileChangeNode | undefined) => {
			let uri: vscode.Uri | undefined;
			const tab = vscode.window.tabGroups.activeTabGroup.activeTab;

			if (e) {
				uri = e.changeModel.filePath;
			} else {
				if (tab?.input instanceof vscode.TabInputTextDiff) {
					uri = tab.input.modified;
				}
			}
			if (uri) {
				vscode.commands.executeCommand('vscode.open', uri, tab?.group.viewColumn);
			}
		}),
	);

	async function openDiffView(fileChangeNode: GitFileChangeNode | InMemFileChangeNode | vscode.Uri | undefined) {
		if (fileChangeNode && !(fileChangeNode instanceof vscode.Uri)) {
			const folderManager = reposManager.getManagerForIssueModel(fileChangeNode.pullRequest);
			if (!folderManager) {
				return;
			}
			return fileChangeNode.openDiff(folderManager);
		} else if (fileChangeNode || vscode.window.activeTextEditor) {
			const editor = fileChangeNode instanceof vscode.Uri ? vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === fileChangeNode.toString())! : vscode.window.activeTextEditor!;
			const visibleRanges = editor.visibleRanges;
			const folderManager = reposManager.getManagerForFile(editor.document.uri);
			if (!folderManager?.activePullRequest) {
				return;
			}
			const reviewManager = ReviewManager.getReviewManagerForFolderManager(reviewsManager.reviewManagers, folderManager);
			if (!reviewManager) {
				return;
			}
			const change = reviewManager.reviewModel.localFileChanges.find(change => change.resourceUri.with({ query: '' }).toString() === editor.document.uri.toString());
			await change?.openDiff(folderManager);
			const tabInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
			const diffEditor = (tabInput instanceof vscode.TabInputTextDiff && tabInput.modified.toString() === editor.document.uri.toString()) ? vscode.window.activeTextEditor : undefined;
			if (diffEditor) {
				diffEditor.revealRange(visibleRanges[0]);
			}
		}
	}

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'pr.openDiffView',
			(fileChangeNode: GitFileChangeNode | InMemFileChangeNode | undefined) => {
				return openDiffView(fileChangeNode);
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'pr.openDiffViewFromEditor',
			(uri: vscode.Uri) => {
				return openDiffView(uri);
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.deleteLocalBranch', async (e: PRNode) => {
			const folderManager = reposManager.getManagerForIssueModel(e.pullRequestModel);
			if (!folderManager) {
				return;
			}
			const pullRequestModel = ensurePR(folderManager, e);
			const DELETE_BRANCH_FORCE = 'Delete Unmerged Branch';
			let error = null;

			try {
				await folderManager.deleteLocalPullRequest(pullRequestModel);
			} catch (e) {
				if (e.gitErrorCode === GitErrorCodes.BranchNotFullyMerged) {
					const action = await vscode.window.showErrorMessage(
						vscode.l10n.t('The local branch \'{0}\' is not fully merged. Are you sure you want to delete it?', pullRequestModel.localBranchName ?? 'unknown branch'),
						DELETE_BRANCH_FORCE,
					);

					if (action !== DELETE_BRANCH_FORCE) {
						return;
					}

					try {
						await folderManager.deleteLocalPullRequest(pullRequestModel, true);
					} catch (e) {
						error = e;
					}
				} else {
					error = e;
				}
			}

			if (error) {
				/* __GDPR__
				"pr.deleteLocalPullRequest.failure" : {}
			*/
				telemetry.sendTelemetryErrorEvent('pr.deleteLocalPullRequest.failure');
				await vscode.window.showErrorMessage(`Deleting local pull request branch failed: ${error}`);
			} else {
				/* __GDPR__
				"pr.deleteLocalPullRequest.success" : {}
			*/
				telemetry.sendTelemetryEvent('pr.deleteLocalPullRequest.success');
			}
		}),
	);

	function chooseReviewManager(repoPath?: string) {
		if (repoPath) {
			const uri = vscode.Uri.file(repoPath).toString();
			for (const mgr of reviewsManager.reviewManagers) {
				if (mgr.repository.rootUri.toString() === uri) {
					return mgr;
				}
			}
		}
		return chooseItem<ReviewManager>(
			reviewsManager.reviewManagers,
			itemValue => ({ label: pathLib.basename(itemValue.repository.rootUri.fsPath) }),
			{ placeHolder: vscode.l10n.t('Choose a repository to create a pull request in'), ignoreFocusOut: true },
		);
	}

	function isSourceControl(x: any): x is Repository {
		return !!x?.rootUri;
	}

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'pr.create',
			async (args?: { repoPath: string; compareBranch: string } | Repository) => {
				// The arguments this is called with are either from the SCM view, or manually passed.
				if (isSourceControl(args)) {
					(await chooseReviewManager(args.rootUri.fsPath))?.createPullRequest();
				} else {
					(await chooseReviewManager(args?.repoPath))?.createPullRequest(args?.compareBranch);
				}
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'pr.pushAndCreate',
			async (args?: any | Repository) => {
				if (isSourceControl(args)) {
					const reviewManager = await chooseReviewManager(args.rootUri.fsPath);
					const folderManager = reposManager.getManagerForFile(args.rootUri);
					let create = true;
					if (folderManager?.activePullRequest) {
						const push = vscode.l10n.t('Push');
						const result = await vscode.window.showInformationMessage(vscode.l10n.t('You already have a pull request for this branch. Do you want to push your changes to the remote branch?'), { modal: true }, push);
						if (result !== push) {
							return;
						}
						create = false;
					}
					if (reviewManager) {
						if (args.state.HEAD?.upstream) {
							await args.push();
						}
						if (create) {
							reviewManager.createPullRequest();
						}
					}
				}
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.pick', async (pr: PRNode | RepositoryChangesNode | PullRequestModel) => {
			if (pr === undefined) {
				// This is unexpected, but has happened a few times.
				Logger.error('Unexpectedly received undefined when picking a PR.', logId);
				return vscode.window.showErrorMessage(vscode.l10n.t('No pull request was selected to checkout, please try again.'));
			}

			let pullRequestModel: PullRequestModel;
			let repository: Repository | undefined;

			if (pr instanceof PRNode || pr instanceof RepositoryChangesNode) {
				pullRequestModel = pr.pullRequestModel;
				repository = pr.repository;
			} else {
				pullRequestModel = pr;
			}

			// Get the folder manager to access the repository
			const folderManager = reposManager.getManagerForIssueModel(pullRequestModel);
			if (!folderManager) {
				return vscode.window.showErrorMessage(vscode.l10n.t('Unable to find repository for this pull request.'));
			}

			const fromDescriptionPage = pr instanceof PullRequestModel;
			return reviewsManager.switchToPr(folderManager, pullRequestModel, repository, fromDescriptionPage);

		}));

	const resolvePr = async (context: BaseContext | undefined): Promise<{ folderManager: FolderRepositoryManager, pr: PullRequestModel } | undefined> => {
		if (!context) {
			return undefined;
		}

		const folderManager = reposManager.getManagerForRepository(context.owner, context.repo) ?? reposManager.folderManagers[0];
		if (!folderManager) {
			return undefined;
		}

		const pr = await folderManager.resolvePullRequest(context.owner, context.repo, context.number, true);
		if (!pr) {
			return undefined;
		}

		return { folderManager, pr };
	};

	const applyPullRequestChanges = async (task: vscode.Progress<{ message?: string; increment?: number; }>, folderManager: FolderRepositoryManager, pullRequest: PullRequestModel): Promise<void> => {
		let patch: string | undefined;
		try {
			patch = await pullRequest.getPatch();

			if (!patch.trim()) {
				vscode.window.showErrorMessage(vscode.l10n.t('No patch data available for pull request #{0}', pullRequest.number.toString()));
				return;
			}

			const tempFilePath = pathLib.join(
				folderManager.repository.rootUri.fsPath,
				'.git',
				`pr-${pullRequest.number}.patch`,
			);
			const encoder = new TextEncoder();
			const tempUri = vscode.Uri.file(tempFilePath);

			await vscode.workspace.fs.writeFile(tempUri, encoder.encode(patch));
			try {
				await folderManager.repository.apply(tempFilePath, false);
				task.report({ message: vscode.l10n.t('Successfully applied changes from pull request #{0}', pullRequest.number.toString()), increment: 100 });
			} finally {
				await vscode.workspace.fs.delete(tempUri);
			}

		} catch (error) {
			const errorMessage = formatError(error);
			Logger.error(`Failed to apply PR changes: ${errorMessage}`, 'Commands');

			const copyGitApply = vscode.l10n.t('Copy git apply');
			const result = await vscode.window.showErrorMessage(
				vscode.l10n.t('Failed to apply changes from pull request: {0}', errorMessage),
				copyGitApply
			);

			if (result === copyGitApply) {
				if (patch) {
					const gitApplyCommand = `git apply --3way <<'EOF'\n${patch}\nEOF`;
					await vscode.env.clipboard.writeText(gitApplyCommand);
					vscode.window.showInformationMessage(vscode.l10n.t('Git apply command copied to clipboard'));
				} else {
					vscode.window.showErrorMessage(vscode.l10n.t('Unable to copy git apply command - patch content is not available'));
				}
			}
		}
	};

	/**
	 * Metadata passed from chat/agent sessions containing repository information.
	 * This is provided by VS Code when commands are invoked from chat session toolbars.
	 */
	interface SessionMetadata {
		/** GitHub repository owner/organization name */
		owner?: string;
		/** GitHub repository name */
		name?: string;
		[key: string]: unknown;
	}

	/**
	 * Get the folder manager and GitHub repository for a repository based on metadata.
	 * Falls back to the first folder manager if metadata is not provided or repository not found.
	 * @param metadata Session metadata containing owner and repo information
	 * @returns Object with folderManager and githubRepo, or undefined if no folder managers exist
	 */
	function getFolderManagerFromMetadata(metadata: SessionMetadata | undefined): { folderManager: FolderRepositoryManager; githubRepo: GitHubRepository } | undefined {
		if (metadata?.owner && metadata?.name) {
			const folderManager = reposManager.getManagerForRepository(metadata.owner, metadata.name) ?? reposManager.folderManagers[0];
			if (!folderManager || folderManager.gitHubRepositories.length === 0) {
				return undefined;
			}
			const githubRepo = folderManager.gitHubRepositories.find(
				repo => repo.remote.owner === metadata.owner && repo.remote.repositoryName === metadata.name
			) ?? folderManager.gitHubRepositories[0];
			return { folderManager, githubRepo };
		}
		if (reposManager.folderManagers.length === 0) {
			return undefined;
		}
		const folderManager = reposManager.folderManagers[0];
		if (folderManager.gitHubRepositories.length === 0) {
			return undefined;
		}
		return { folderManager, githubRepo: folderManager.gitHubRepositories[0] };
	}

	function contextHasPath(ctx: BaseContext | { path: string } | undefined): ctx is { path: string } {
		const contextAsPath: Partial<{ path: string }> = (ctx as { path: string });
		return !!contextAsPath.path;
	}

	function prNumberFromUriPath(path: string): number | undefined {
		const trimPath = path.startsWith('/') ? path.substring(1) : path;
		if (!Number.isNaN(Number(trimPath))) {
			return Number(trimPath);
		}
		// This is a base64 encoded PR number like: /MTIz
		const decoded = Number(Buffer.from(trimPath, 'base64').toString('utf8'));
		if (!Number.isNaN(decoded)) {
			return decoded;
		}
	}

	type ChatCommandArgs = { path: string } | [{ path: string } | undefined, SessionMetadata | undefined] | undefined;

	function parseChatCommandArgs(ctxOrArgs: ChatCommandArgs, metadataArg?: SessionMetadata): { ctx: { path: string } | undefined; metadata: SessionMetadata | undefined } {
		if (Array.isArray(ctxOrArgs)) {
			return { ctx: ctxOrArgs[0], metadata: ctxOrArgs[1] };
		}
		return { ctx: ctxOrArgs, metadata: metadataArg };
	}

	async function resolvePrFromChat(ctx: { path: string }, metadata: SessionMetadata | undefined): Promise<{ folderManager: FolderRepositoryManager; pullRequest: PullRequestModel; prNumber: number } | undefined> {
		const prNumber = prNumberFromUriPath(ctx.path);
		if (!prNumber) {
			return undefined;
		}
		const result = getFolderManagerFromMetadata(metadata);
		if (!result) {
			return undefined;
		}
		const { folderManager, githubRepo } = result;
		const pullRequest = await folderManager.fetchById(githubRepo, prNumber);
		if (!pullRequest) {
			return undefined;
		}
		return { folderManager, pullRequest, prNumber };
	}

	context.subscriptions.push(vscode.commands.registerCommand('pr.checkoutFromChat', async (ctxOrArgs: ChatCommandArgs, metadataArg?: SessionMetadata) => {
		const { ctx, metadata } = parseChatCommandArgs(ctxOrArgs, metadataArg);
		if (!ctx) {
			return vscode.window.showErrorMessage(vscode.l10n.t('No pull request context provided for checkout.'));
		}

		const resolved = await resolvePrFromChat(ctx, metadata);
		if (!resolved) {
			return vscode.window.showErrorMessage(vscode.l10n.t('Unable to find pull request from chat context.'));
		}

		return reviewsManager.switchToPr(resolved.folderManager, resolved.pullRequest, resolved.folderManager.repository, true);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.checkoutFromDescription', async (ctx: BaseContext | undefined) => {
		if (!ctx) {
			return vscode.window.showErrorMessage(vscode.l10n.t('No pull request context provided for checkout.'));
		}

		const resolved = await resolvePr(ctx);
		if (!resolved) {
			return vscode.window.showErrorMessage(vscode.l10n.t('Unable to resolve pull request for checkout.'));
		}
		return reviewsManager.switchToPr(resolved.folderManager, resolved.pr, resolved.folderManager.repository, true);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.applyChangesFromChat', async (ctxOrArgs: ChatCommandArgs, metadataArg?: SessionMetadata) => {
		const { ctx, metadata } = parseChatCommandArgs(ctxOrArgs, metadataArg);
		if (!ctx) {
			return vscode.window.showErrorMessage(vscode.l10n.t('No pull request context provided for applying changes.'));
		}

		const resolved = await resolvePrFromChat(ctx, metadata);
		if (!resolved) {
			return vscode.window.showErrorMessage(vscode.l10n.t('Unable to find pull request from chat context.'));
		}

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: vscode.l10n.t('Applying changes from pull request #{0}', resolved.prNumber.toString()),
				cancellable: false
			},
			async (task) => {
				task.report({ increment: 30 });
				return applyPullRequestChanges(task, resolved.folderManager, resolved.pullRequest);
			});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.applyChangesFromDescription', async (ctx: BaseContext | undefined) => {
		if (!ctx) {
			return vscode.window.showErrorMessage(vscode.l10n.t('No pull request context provided for applying changes.'));
		}

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: vscode.l10n.t('Applying changes from pull request'),
				cancellable: false
			},
			async (task) => {
				task.report({ increment: 30 });

				const resolved = await resolvePr(ctx);
				if (!resolved) {
					return vscode.window.showErrorMessage(vscode.l10n.t('Unable to resolve pull request for applying changes.'));
				}
				return applyPullRequestChanges(task, resolved.folderManager, resolved.pr);
			}
		);
	}));

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.openChanges', async (pr: PRNode | RepositoryChangesNode | PullRequestModel | OverviewContext | CrossChatSessionWithPR | { path: string } | undefined) => {
			if (pr === undefined) {
				// This is unexpected, but has happened a few times.
				Logger.error('Unexpectedly received undefined when picking a PR.', logId);
				return vscode.window.showErrorMessage(vscode.l10n.t('No pull request was selected to checkout, please try again.'));
			}

			let pullRequestModel: PullRequestModel | undefined;

			if (pr instanceof PRNode || pr instanceof RepositoryChangesNode) {
				pullRequestModel = pr.pullRequestModel;
			} else if (pr instanceof PullRequestModel) {
				pullRequestModel = pr;
			} else if (isCrossChatSessionWithPR(pr)) {
				const resolved = await resolvePr({
					owner: pr.pullRequestDetails.repository.owner.login,
					repo: pr.pullRequestDetails.repository.name,
					number: pr.pullRequestDetails.number,
					preventDefaultContextMenuItems: true,
				});
				pullRequestModel = resolved?.pr;
			}
			else if (contextHasPath(pr)) {
				const { path } = pr;
				const prNumber = prNumberFromUriPath(path);
				if (!prNumber) {
					return vscode.window.showErrorMessage(vscode.l10n.t('No pull request number found in context path.'));
				}
				const folderManager = reposManager.folderManagers[0];
				const pullRequest = await folderManager.fetchById(folderManager.gitHubRepositories[0], Number(prNumber));
				if (!pullRequest) {
					return vscode.window.showErrorMessage(vscode.l10n.t('Unable to find pull request #{0}', prNumber.toString()));
				}
				pullRequestModel = pullRequest;
			}
			else {
				const resolved = await resolvePr(pr as BaseContext);
				pullRequestModel = resolved?.pr;
			}

			if (!pullRequestModel) {
				return vscode.window.showErrorMessage(vscode.l10n.t('No pull request found to open changes.'));
			}

			const folderReposManager = reposManager.getManagerForIssueModel(pullRequestModel);
			if (!folderReposManager) {
				return;
			}
			return PullRequestModel.openChanges(folderReposManager, pullRequestModel);
		}),
	);

	let isCheckingOutFromReadonlyFile = false;
	context.subscriptions.push(vscode.commands.registerCommand('pr.checkoutFromReadonlyFile', async () => {
		const uri = vscode.window.activeTextEditor?.document.uri;
		if (uri?.scheme !== Schemes.Pr) {
			return;
		}
		const prUriPropserties = fromPRUri(uri);
		if (prUriPropserties === undefined) {
			return;
		}
		let githubRepository: GitHubRepository | undefined;
		const folderManager = reposManager.folderManagers.find(folderManager => {
			githubRepository = folderManager.gitHubRepositories.find(githubRepo => githubRepo.remote.remoteName === prUriPropserties.remoteName);
			return !!githubRepository;
		});
		if (!folderManager || !githubRepository) {
			return;
		}
		const prModel = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window }, () => folderManager.fetchById(githubRepository!, Number(prUriPropserties.prNumber)));
		if (prModel && !isCheckingOutFromReadonlyFile) {
			isCheckingOutFromReadonlyFile = true;
			try {
				await ReviewManager.getReviewManagerForFolderManager(reviewsManager.reviewManagers, folderManager)?.switch(prModel);
			} catch (e) {
				vscode.window.showErrorMessage(vscode.l10n.t('Unable to check out pull request from read-only file: {0}', e instanceof Error ? e.message : 'unknown'));
			}
			isCheckingOutFromReadonlyFile = false;
		}
	}));

	const pickPullRequest = async (pr: PRNode | RepositoryChangesNode | PullRequestModel, linkGenerator: (pr: PullRequestModel) => string, requiresHead: boolean = false) => {
		if (pr === undefined) {
			// This is unexpected, but has happened a few times.
			Logger.error('Unexpectedly received undefined when picking a PR.', logId);
			return vscode.window.showErrorMessage(vscode.l10n.t('No pull request was selected to checkout, please try again.'));
		}

		let pullRequestModel: PullRequestModel;

		if (pr instanceof PRNode || pr instanceof RepositoryChangesNode) {
			pullRequestModel = pr.pullRequestModel;
		} else {
			pullRequestModel = pr;
		}

		if (requiresHead && !pullRequestModel.head) {
			return vscode.window.showErrorMessage(vscode.l10n.t('Unable to checkout pull request: missing head branch information.'));
		}

		return vscode.env.openExternal(vscode.Uri.parse(linkGenerator(pullRequestModel)));
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.pickOnVscodeDev', async (pr: PRNode | RepositoryChangesNode | PullRequestModel) =>
			pickPullRequest(pr, vscodeDevPrLink)
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.pickOnCodespaces', async (pr: PRNode | RepositoryChangesNode | PullRequestModel) =>
			pickPullRequest(pr, codespacesPrLink, true)
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.pickInWorktree', async (pr: PRNode | unknown) => {
			if (pr === undefined || !(pr instanceof PRNode)) {
				Logger.error('Unexpectedly received undefined when picking a PR for worktree checkout.', logId);
				return vscode.window.showErrorMessage(vscode.l10n.t('No pull request was selected to checkout, please try again.'));
			}

			let pullRequestModel: PullRequestModel;
			let repository: Repository | undefined;

			pullRequestModel = pr.pullRequestModel;
			repository = pr.repository;

			// Validate that the PR has a valid head branch
			if (!pullRequestModel.head) {
				return vscode.window.showErrorMessage(vscode.l10n.t('Unable to checkout pull request: missing head branch information.'));
			}

			// Store validated head to avoid non-null assertions later
			const prHead = pullRequestModel.head;

			// Get the folder manager to access the repository
			const folderManager = reposManager.getManagerForIssueModel(pullRequestModel);
			if (!folderManager) {
				return vscode.window.showErrorMessage(vscode.l10n.t('Unable to find repository for this pull request.'));
			}

			const repositoryToUse = repository || folderManager.repository;

			/* __GDPR__
				"pr.checkoutInWorktree" : {}
			*/
			telemetry.sendTelemetryEvent('pr.checkoutInWorktree');

			// Prepare for operations
			const repoRootPath = repositoryToUse.rootUri.fsPath;
			const parentDir = pathLib.dirname(repoRootPath);
			const defaultWorktreePath = pathLib.join(parentDir, `pr-${pullRequestModel.number}`);
			const branchName = prHead.ref;
			const remoteName = pullRequestModel.remote.remoteName;

			// Ask user for worktree location first (not in progress)
			const worktreeUri = await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.file(defaultWorktreePath),
				title: vscode.l10n.t('Select Worktree Location'),
				saveLabel: vscode.l10n.t('Create Worktree'),
			});

			if (!worktreeUri) {
				return; // User cancelled
			}

			const worktreePath = worktreeUri.fsPath;
			const trackedBranchName = `${remoteName}/${branchName}`;

			try {
				// Check if the createWorktree API is available
				if (!repositoryToUse.createWorktree) {
					throw new Error(vscode.l10n.t('Git worktree API is not available. Please update VS Code to the latest version.'));
				}

				// Start progress for fetch and worktree creation
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: vscode.l10n.t('Creating worktree for Pull Request #{0}...', pullRequestModel.number),
					},
					async () => {
						// Fetch the PR branch first
						try {
							await repositoryToUse.fetch({ remote: remoteName, ref: branchName });
						} catch (e) {
							const errorMessage = e instanceof Error ? e.message : String(e);
							Logger.appendLine(`Failed to fetch branch ${branchName}: ${errorMessage}`, logId);
							// Continue even if fetch fails - the branch might already be available locally
						}

						// Use the git extension's createWorktree API
						await repositoryToUse.createWorktree!({
							path: worktreePath,
							commitish: trackedBranchName,
							branch: branchName
						});
					}
				);

				// Ask user if they want to open the worktree (after progress is finished)
				const openAction = vscode.l10n.t('Open in New Window');
				const result = await vscode.window.showInformationMessage(
					vscode.l10n.t('Worktree created for Pull Request #{0}', pullRequestModel.number),
					openAction
				);

				if (result === openAction) {
					await commands.openFolder(worktreeUri, { forceNewWindow: true });
				}
			} catch (e) {
				const errorMessage = e instanceof Error ? e.message : String(e);
				Logger.error(`Failed to create worktree: ${errorMessage}`, logId);
				return vscode.window.showErrorMessage(vscode.l10n.t('Failed to create worktree: {0}', errorMessage));
			}
		}),
	);

	context.subscriptions.push(vscode.commands.registerCommand('pr.checkoutOnVscodeDevFromDescription', async (context: BaseContext | undefined) => {
		if (!context) {
			return vscode.window.showErrorMessage(vscode.l10n.t('No pull request context provided for checkout.'));
		}
		const resolved = await resolvePr(context);
		if (!resolved) {
			return vscode.window.showErrorMessage(vscode.l10n.t('Unable to resolve pull request for checkout.'));
		}
		return vscode.env.openExternal(vscode.Uri.parse(vscodeDevPrLink(resolved.pr)));
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.checkoutOnCodespacesFromDescription', async (context: BaseContext | undefined) => {
		if (!context) {
			return vscode.window.showErrorMessage(vscode.l10n.t('No pull request context provided for checkout.'));
		}
		const resolved = await resolvePr(context);
		if (!resolved) {
			return vscode.window.showErrorMessage(vscode.l10n.t('Unable to resolve pull request for checkout.'));
		}
		if (!resolved.pr.head) {
			return vscode.window.showErrorMessage(vscode.l10n.t('Unable to checkout pull request: missing head branch information.'));
		}
		return vscode.env.openExternal(vscode.Uri.parse(codespacesPrLink(resolved.pr)));
	}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.openSessionLogFromDescription', async (context: SessionLinkInfo | undefined) => {
		if (!context) {
			return vscode.window.showErrorMessage(vscode.l10n.t('No pull request context provided for checkout.'));
		}
		const resource = SessionIdForPr.getResource(context.pullNumber, context.sessionIndex);
		return vscode.commands.executeCommand('vscode.open', resource);
	}));

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.exit', async (pr: PRNode | RepositoryChangesNode | PullRequestModel | undefined) => {
			let pullRequestModel: PullRequestModel | undefined;

			if (pr instanceof PRNode || pr instanceof RepositoryChangesNode) {
				pullRequestModel = pr.pullRequestModel;
			} else if (pr === undefined) {
				pullRequestModel = await chooseItem<PullRequestModel>(reposManager.folderManagers
					.map(folderManager => folderManager.activePullRequest!)
					.filter(activePR => !!activePR),
					itemValue => ({ label: `${itemValue.number}: ${itemValue.title}` }),
					{ placeHolder: vscode.l10n.t('Choose the pull request to exit') });
			} else {
				pullRequestModel = pr;
			}

			if (!pullRequestModel) {
				return;
			}

			const fromDescriptionPage = pr instanceof PullRequestModel;
			/* __GDPR__
			"pr.exit" : {
				"fromDescriptionPage" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
			}
		*/
			telemetry.sendTelemetryEvent('pr.exit', { fromDescription: fromDescriptionPage.toString() });

			return vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.SourceControl,
					title: vscode.l10n.t('Exiting Pull Request'),
				},
				async () => {
					const branch = await pullRequestModel!.githubRepository.getDefaultBranch();
					const manager = reposManager.getManagerForIssueModel(pullRequestModel);
					if (manager) {
						const prBranch = manager.repository.state.HEAD?.name;
						await manager.checkoutDefaultBranch(branch, pullRequestModel);
						if (prBranch) {
							await manager.cleanupAfterPullRequest(prBranch, pullRequestModel!);
						}
					}
				},
			);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.merge', async (pr?: PRNode) => {
			const folderManager = reposManager.getManagerForIssueModel(pr?.pullRequestModel);
			if (!folderManager) {
				return;
			}
			const pullRequest = ensurePR(folderManager, pr);
			// TODO check is codespaces

			const isCrossRepository =
				pullRequest.base &&
				pullRequest.head &&
				!pullRequest.base.repositoryCloneUrl.equals(pullRequest.head.repositoryCloneUrl);

			const showMergeOnGitHub = isCrossRepository && isInCodespaces();
			if (showMergeOnGitHub) {
				return openPullRequestOnGitHub(pullRequest, telemetry);
			}

			const yes = vscode.l10n.t('Yes');
			return vscode.window
				.showWarningMessage(
					vscode.l10n.t('Are you sure you want to merge this pull request on GitHub?'),
					{ modal: true },
					yes,
				)
				.then(async value => {
					let newPR;
					if (value === yes) {
						try {
							newPR = await pullRequest.merge(folderManager.repository);
							return newPR;
						} catch (e) {
							vscode.window.showErrorMessage(`Unable to merge pull request. ${formatError(e)}`);
							return newPR;
						}
					}
				});
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.dismissNotification', node => {
			if (node instanceof PRNode) {
				notificationManager.markPrNotificationsAsRead(node.pullRequestModel);
				prsTreeModel.clearCopilotNotification(node.pullRequestModel.remote.owner, node.pullRequestModel.remote.repositoryName, node.pullRequestModel.number);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.markAllCopilotNotificationsAsRead', node => {
			if (node instanceof CategoryTreeNode && node.isCopilot && node.repo) {
				prsTreeModel.clearAllCopilotNotifications(node.repo.owner, node.repo.repositoryName);
			}
		}),
	);

	async function openDescriptionCommand(argument: RepositoryChangesNode | PRNode | IssueModel | CrossChatSessionWithPR | PRChatContextItem | IssueChatContextItem | undefined) {
		let issueModel: IssueModel | undefined;
		if (!argument) {
			const activePullRequests: PullRequestModel[] = reposManager.folderManagers
				.map(manager => manager.activePullRequest!)
				.filter(activePR => !!activePR);
			if (activePullRequests.length >= 1) {
				issueModel = await chooseItem<PullRequestModel>(
					activePullRequests,
					itemValue => ({ label: itemValue.title }),
				);
			}
		} else {
			if (argument instanceof RepositoryChangesNode) {
				issueModel = argument.pullRequestModel;
			} else if (argument instanceof PRNode) {
				issueModel = argument.pullRequestModel;
			} else if (isCrossChatSessionWithPR(argument)) {
				issueModel = (await resolvePr({
					owner: argument.pullRequestDetails.repository.owner.login,
					repo: argument.pullRequestDetails.repository.name,
					number: argument.pullRequestDetails.number,
					preventDefaultContextMenuItems: true,
				}))?.pr;
			} else if (PRChatContextItem.is(argument)) {
				issueModel = argument.pr;
			} else if (IssueChatContextItem.is(argument)) {
				issueModel = argument.issue;
			} else {
				issueModel = argument;
			}
		}

		if (!issueModel) {
			Logger.appendLine('No pull request found.', logId);
			return;
		}

		const folderManager = reposManager.getManagerForIssueModel(issueModel) ?? reposManager.folderManagers[0];

		let descriptionNode: PRNode | RepositoryChangesNode | undefined;
		if (argument instanceof PRNode) {
			descriptionNode = argument;
		} else if ((issueModel instanceof PullRequestModel) && folderManager.activePullRequest?.equals(issueModel)) {
			const reviewManager = ReviewManager.getReviewManagerForFolderManager(reviewsManager.reviewManagers, folderManager);
			if (!reviewManager) {
				return;
			}

			descriptionNode = reviewManager.changesInPrDataProvider.getDescriptionNode(folderManager);
		}

		const revealDescription = !(argument instanceof PRNode);

		await openDescription(telemetry, issueModel, descriptionNode, folderManager, revealDescription, !(argument instanceof RepositoryChangesNode));
	}

	async function checkoutChatSessionPullRequest(argument: CrossChatSessionWithPR) {
		const pr = await resolvePr({
			owner: argument.pullRequestDetails.repository.owner.login,
			repo: argument.pullRequestDetails.repository.name,
			number: argument.pullRequestDetails.number,
			preventDefaultContextMenuItems: true,
		}).then(resolved => resolved?.pr);

		if (!pr) {
			Logger.warn(`No pull request found in chat session`, logId);
			return;
		}

		const folderManager = reposManager.getManagerForRepository(pr.githubRepository.remote.owner, pr.githubRepository.remote.repositoryName);
		if (!folderManager) {
			Logger.warn(`No folder manager found for pull request ${pr.number}`, logId);
			return vscode.window.showErrorMessage(vscode.l10n.t('Unable to find repository for pull request #{0}', pr.number.toString()));
		}

		return reviewsManager.switchToPr(folderManager, pr, folderManager.repository, false);
	}

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'pr.checkoutChatSessionPullRequest',
			checkoutChatSessionPullRequest
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'pr.openDescription',
			openDescriptionCommand
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'issue.openDescription',
			openDescriptionCommand
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.refreshDescription', async () => {
			const panel = PullRequestOverviewPanel.getActivePanel();
			if (panel) {
				panel.refreshPanel();
			}
		}),
	);

	context.subscriptions.push(vscode.commands.registerCommand('pr.focusDescriptionInput',
		async () => {
			const panel = PullRequestOverviewPanel.getActivePanel();
			if (panel) {
				panel.scrollToPendingReview();
			}
		}
	));

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.openDescriptionToTheSide', async (descriptionNode: RepositoryChangesNode) => {
			const folderManager = reposManager.getManagerForIssueModel(descriptionNode.pullRequestModel);
			if (!folderManager) {
				return;
			}
			const pr = descriptionNode.pullRequestModel;
			const pullRequest = ensurePR(folderManager, pr);
			descriptionNode.reveal(descriptionNode, { select: true, focus: true });
			const identity = {
				owner: pullRequest.remote.owner,
				repo: pullRequest.remote.repositoryName,
				number: pullRequest.number
			};
			// Create and show a new webview
			PullRequestOverviewPanel.createOrShow(telemetry, context.extensionUri, folderManager, identity, pullRequest, true);

			/* __GDPR__
			"pr.openDescriptionToTheSide" : {}
		*/
			telemetry.sendTelemetryEvent('pr.openDescriptionToTheSide');
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.showDiffSinceLastReview', async (descriptionNode: RepositoryChangesNode) => {
			descriptionNode.pullRequestModel.showChangesSinceReview = true;
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.showDiffAll', async (descriptionNode: RepositoryChangesNode) => {
			descriptionNode.pullRequestModel.showChangesSinceReview = false;
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.signin', async () => {
			await reposManager.authenticate();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.signinNoEnterprise', async () => {
			await reposManager.authenticate(false);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.signinenterprise', async () => {
			await reposManager.authenticate(true);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.deleteLocalBranchesNRemotes', async () => {
			for (const folderManager of reposManager.folderManagers) {
				await folderManager.deleteLocalBranchesNRemotes();
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.signinAndRefreshList', async () => {
			if (await reposManager.authenticate()) {
				vscode.commands.executeCommand('pr.refreshList');
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.configureRemotes', async () => {
			return vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXTENSION_ID} remotes`);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.startReview', async (reply: CommentReply) => {
			/* __GDPR__
			"pr.startReview" : {}
		*/
			telemetry.sendTelemetryEvent('pr.startReview');
			const handler = resolveCommentHandler(reply.thread);

			if (handler) {
				handler.startReview(reply.thread, reply.text);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.openReview', async (thread: GHPRCommentThread) => {
			/* __GDPR__
				"pr.openReview" : {}
			*/
			telemetry.sendTelemetryEvent('pr.openReview');
			const handler = resolveCommentHandler(thread);

			if (handler) {
				await handler.openReview(thread);
			}
		}),
	);

	function threadAndText(commentLike: CommentReply | GHPRCommentThread | GHPRComment | any): { thread: GHPRCommentThread, text: string } {
		let thread: GHPRCommentThread;
		let text: string = '';
		if (commentLike instanceof GHPRComment) {
			thread = commentLike.parent;
		} else if (CommentReply.is(commentLike)) {
			thread = commentLike.thread;
		} else if (GHPRCommentThread.is(commentLike?.thread)) {
			thread = commentLike.thread;
		} else {
			thread = commentLike;
		}
		return { thread, text };
	}

	const resolve = async (commentLike: CommentReply | GHPRCommentThread | GHPRComment | undefined, resolve: boolean, focusReply?: boolean) => {
		if (resolve) {
			/* __GDPR__
			"pr.resolveReviewThread" : {}
			*/
			telemetry.sendTelemetryEvent('pr.resolveReviewThread');
		} else {
			/* __GDPR__
			"pr.unresolveReviewThread" : {}
			*/
			telemetry.sendTelemetryEvent('pr.unresolveReviewThread');
		}

		if (!commentLike) {
			const activeHandler = findActiveHandler();
			if (!activeHandler) {
				vscode.window.showErrorMessage(vscode.l10n.t('No active comment thread found'));
				return;
			}
			commentLike = activeHandler.commentController.activeCommentThread as vscode.CommentThread2 as GHPRCommentThread;
		}

		const { thread, text } = threadAndText(commentLike);

		const handler = resolveCommentHandler(thread);

		if (handler) {
			if (resolve) {
				await handler.resolveReviewThread(thread, text);
			} else {
				await handler.unresolveReviewThread(thread, text);
				if (focusReply) {
					thread.reveal(undefined, { focus: vscode.CommentThreadFocus.Reply });
				}
			}
		}
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.resolveReviewThread', async (commentLike: CommentReply | GHPRCommentThread | GHPRComment) => resolve(commentLike, true))
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.unresolveReviewThread', (commentLike: CommentReply | GHPRCommentThread | GHPRComment) => resolve(commentLike, false, false))
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.unresolveReviewThreadFromView', (commentLike: CommentReply | GHPRCommentThread | GHPRComment) => resolve(commentLike, false, true))
	);

	const localUriFromReviewUri = (reviewUri: vscode.Uri) => {
		const { path, rootPath } = fromReviewUri(reviewUri.query);
		const workspaceFolder = vscode.workspace.workspaceFolders![0];
		return vscode.Uri.joinPath(vscode.Uri.file(rootPath), path).with({ scheme: workspaceFolder.uri.scheme, authority: workspaceFolder.uri.authority });
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.diffOutdatedCommentWithHead', async (commentThread: GHPRCommentThread) => {
			/* __GDPR__
			"pr.diffOutdatedCommentWithHead" : {}
			*/
			telemetry.sendTelemetryEvent('pr.diffOutdatedCommentWithHead');
			const options: vscode.TextDocumentShowOptions = {};
			options.selection = commentThread.range;
			const fileName = pathLib.basename(commentThread.uri.fsPath);
			const { commit } = fromReviewUri(commentThread.uri.query);

			vscode.commands.executeCommand('vscode.diff',
				commentThread.uri,
				localUriFromReviewUri(commentThread.uri),
				`${fileName} from ${(commit || '').substr(0, 8)} diffed with HEAD`,
				options,
			);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.createComment', async (reply: CommentReply) => {
			/* __GDPR__
			"pr.createComment" : {}
		*/
			telemetry.sendTelemetryEvent('pr.createComment');
			const handler = resolveCommentHandler(reply.thread);

			if (handler) {
				handler.createOrReplyComment(reply.thread, reply.text, false);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.createSingleComment', async (reply: CommentReply) => {
			/* __GDPR__
			"pr.createSingleComment" : {}
		*/
			telemetry.sendTelemetryEvent('pr.createSingleComment');
			const handler = resolveCommentHandler(reply.thread);

			if (handler) {
				handler.createOrReplyComment(reply.thread, reply.text, true);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.makeSuggestion', async (reply: CommentReply | GHPRComment | undefined) => {
			let potentialThread: GHPRCommentThread | undefined;
			if (reply === undefined) {
				potentialThread = findActiveHandler()?.commentController.activeCommentThread as vscode.CommentThread2 as GHPRCommentThread | undefined;
			} else {
				potentialThread = reply instanceof GHPRComment ? reply.parent : reply?.thread;
			}

			if (!potentialThread?.range) {
				return;
			}
			const thread: GHPRCommentThread & { range: vscode.Range } = potentialThread as GHPRCommentThread & { range: vscode.Range };
			const commentEditor = vscode.window.activeTextEditor?.document.uri.scheme === Schemes.Comment ? vscode.window.activeTextEditor
				: vscode.window.visibleTextEditors.find(visible => (visible.document.uri.scheme === Schemes.Comment) && (visible.document.uri.query === ''));
			if (!commentEditor) {
				Logger.error('No comment editor visible for making a suggestion.', logId);
				vscode.window.showErrorMessage(vscode.l10n.t('No available comment editor to make a suggestion in.'));
				return;
			}
			const editor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === thread.uri.toString());
			const contents = editor?.document.getText(new vscode.Range(thread.range.start.line, 0, thread.range.end.line, editor.document.lineAt(thread.range.end.line).text.length));
			const position = commentEditor.document.lineAt(commentEditor.selection.end.line).range.end;
			return commentEditor.edit((editBuilder) => {
				editBuilder.insert(position, `
\`\`\`suggestion
${contents}
\`\`\``);
			});
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.editComment', async (comment: GHPRComment | TemporaryComment) => {
			/* __GDPR__
			"pr.editComment" : {}
		*/
			telemetry.sendTelemetryEvent('pr.editComment');
			comment.startEdit();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.editQuery', (query: CategoryTreeNode) => {
			/* __GDPR__
			"pr.editQuery" : {}
		*/
			telemetry.sendTelemetryEvent('pr.editQuery');
			if (query.label === undefined) {
				return;
			}
			return editQuery(PR_SETTINGS_NAMESPACE, query.label);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.cancelEditComment', async (comment: GHPRComment | TemporaryComment) => {
			/* __GDPR__
			"pr.cancelEditComment" : {}
		*/
			telemetry.sendTelemetryEvent('pr.cancelEditComment');
			comment.cancelEdit();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.saveComment', async (comment: GHPRComment | TemporaryComment) => {
			/* __GDPR__
			"pr.saveComment" : {}
		*/
			telemetry.sendTelemetryEvent('pr.saveComment');
			const handler = resolveCommentHandler(comment.parent);

			if (handler) {
				await handler.editComment(comment.parent, comment);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.deleteComment', async (comment: GHPRComment | TemporaryComment) => {
			/* __GDPR__
			"pr.deleteComment" : {}
		*/
			telemetry.sendTelemetryEvent('pr.deleteComment');
			const deleteOption = vscode.l10n.t('Delete');
			const shouldDelete = await vscode.window.showWarningMessage(vscode.l10n.t('Are you sure you want to delete this comment?'), { modal: true }, deleteOption);

			if (shouldDelete === deleteOption) {
				const handler = resolveCommentHandler(comment.parent);

				if (handler) {
					await handler.deleteComment(comment.parent, comment);
				}
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('review.openFile', (value: GitFileChangeNode | vscode.Uri) => {
			const command = value instanceof GitFileChangeNode ? value.openFileCommand() : openFileCommand(value);
			vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('review.openLocalFile', (_value: vscode.Uri) => {
			const value = _value ?? vscode.window.activeTextEditor?.document.uri;
			if (!value) {
				return;
			}
			const localUri = localUriFromReviewUri(value);
			const editor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === value.toString());
			const command = openFileCommand(localUri, editor ? { selection: editor.selection } : undefined);
			vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
		}),
	);

	interface SCMResourceStates {
		resourceStates: { resourceUri: vscode.Uri }[];
	}
	interface SCMResourceUri {
		resourceUri: vscode.Uri;
	}
	context.subscriptions.push(vscode.commands.registerCommand('review.createSuggestionsFromChanges', async (value: SCMResourceStates | SCMResourceUri, ...additionalSelected: SCMResourceUri[]) => {
		let resources: vscode.Uri[];
		const asResourceStates = value as Partial<SCMResourceStates>;
		if (asResourceStates.resourceStates) {
			resources = asResourceStates.resourceStates.map(resource => resource.resourceUri);
		} else {
			const asResourceUri = value as SCMResourceUri;
			resources = [asResourceUri.resourceUri];
			if (additionalSelected) {
				resources.push(...additionalSelected.map(resource => resource.resourceUri));
			}
		}
		if (resources.length === 0) {
			return;
		}
		const folderManager = reposManager.getManagerForFile(resources[0]);
		if (!folderManager || !folderManager.activePullRequest) {
			return;
		}
		const reviewManager = ReviewManager.getReviewManagerForFolderManager(reviewsManager.reviewManagers, folderManager);
		return reviewManager?.createSuggestionsFromChanges(resources);
	}));

	context.subscriptions.push(vscode.commands.registerDiffInformationCommand('review.createSuggestionFromChange', async (diffLines: vscode.LineChange[]) => {
		const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		const input = tab?.input;
		if (!(input instanceof vscode.TabInputTextDiff)) {
			return vscode.window.showErrorMessage(vscode.l10n.t('Current editor isn\'t a diff editor.'));
		}

		if (input.original.scheme !== Schemes.Git) {
			return vscode.window.showErrorMessage(vscode.l10n.t('Converting changes to suggestions can only be done from a git diff, not a pull request diff'), { modal: true });
		}

		const editor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === input.modified.toString());
		if (!editor) {
			return vscode.window.showErrorMessage(vscode.l10n.t('Unexpectedly unable to find the current modified editor.'));
		}

		const folderManager = reposManager.getManagerForFile(input.modified);
		if (!folderManager || !folderManager.activePullRequest) {
			return;
		}
		const editorSelection = editor.selection;
		const selectedLines = diffLines.filter(line => {
			return !!editorSelection.intersection(new vscode.Selection(line.modifiedStartLineNumber - 1, 0, line.modifiedEndLineNumber - 1, 100));
		});

		if (selectedLines.length === 0) {
			return vscode.window.showErrorMessage(vscode.l10n.t('No modified lines selected.'));
		}
		const reviewManager = ReviewManager.getReviewManagerForFolderManager(reviewsManager.reviewManagers, folderManager);
		return reviewManager?.createSuggestionFromChange(editor.document, selectedLines);

	}));

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.refreshChanges', _ => {
			reviewsManager.reviewManagers.forEach(reviewManager => {
				vscode.window.withProgress({ location: { viewId: 'prStatus:github' } }, async () => {
					await Promise.all([
						reviewManager.repository.pull(false),
						reviewManager.updateComments()
					]);
				});
			});
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.setFileListLayoutAsTree', _ => {
			vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).update(FILE_LIST_LAYOUT, 'tree', true);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.setFileListLayoutAsFlat', _ => {
			vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).update(FILE_LIST_LAYOUT, 'flat', true);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.toggleHideViewedFiles', _ => {
			const config = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE);
			const currentValue = config.get<boolean>(HIDE_VIEWED_FILES, false);
			config.update(HIDE_VIEWED_FILES, !currentValue, vscode.ConfigurationTarget.Global);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.refreshPullRequest', (prNode: PRNode) => {
			const folderManager = reposManager.getManagerForIssueModel(prNode.pullRequestModel);
			if (folderManager && prNode.pullRequestModel.equals(folderManager?.activePullRequest)) {
				ReviewManager.getReviewManagerForFolderManager(reviewsManager.reviewManagers, folderManager)?.updateComments();
			}

			PullRequestOverviewPanel.refresh(
				prNode.pullRequestModel.remote.owner,
				prNode.pullRequestModel.remote.repositoryName,
				prNode.pullRequestModel.number,
			);
		}),
	);

	const findPrFromUri = (manager: FolderRepositoryManager | undefined, treeNode: vscode.Uri): PullRequestModel | undefined => {
		if (treeNode.scheme === Schemes.Pr) {
			const prQuery = fromPRUri(treeNode);
			if (prQuery) {
				for (const githubRepos of (manager?.gitHubRepositories ?? [])) {
					const prNumber = Number(prQuery.prNumber);
					return githubRepos.getExistingPullRequestModel(prNumber);
				}
			}
		} else {
			return manager?.activePullRequest;
		}
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.markFileAsViewed', async (treeNode: FileChangeNode | vscode.Uri | undefined) => {
			try {
				if (treeNode === undefined) {
					// Use the active editor to enable keybindings
					treeNode = vscode.window.activeTextEditor?.document.uri;
				}

				if (treeNode instanceof FileChangeNode) {
					await treeNode.markFileAsViewed(false);
				} else if (treeNode) {
					// When the argument is a uri it came from the editor menu and we should also close the file
					// Do the close first to improve perceived performance of marking as viewed.
					const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
					if (tab) {
						let compareUri: vscode.Uri | undefined = undefined;
						if (tab.input instanceof vscode.TabInputTextDiff) {
							compareUri = tab.input.modified;
						} else if (tab.input instanceof vscode.TabInputText) {
							compareUri = tab.input.uri;
						}
						if (compareUri && treeNode.toString() === compareUri.toString()) {
							vscode.window.tabGroups.close(tab);
						}
					}

					const manager = reposManager.getManagerForFile(treeNode);
					const pullRequest = findPrFromUri(manager, treeNode);
					await pullRequest?.markFiles([treeNode.path], true, 'viewed');
					manager?.setFileViewedContext();
				}
			} catch (e) {
				vscode.window.showErrorMessage(`Marked file as viewed failed: ${e}`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.unmarkFileAsViewed', async (treeNode: FileChangeNode | vscode.Uri | undefined) => {
			try {
				if (treeNode === undefined) {
					// Use the active editor to enable keybindings
					treeNode = vscode.window.activeTextEditor?.document.uri;
				}

				if (treeNode instanceof FileChangeNode) {
					treeNode.unmarkFileAsViewed(false);
				} else if (treeNode) {
					const manager = reposManager.getManagerForFile(treeNode);
					const pullRequest = findPrFromUri(manager, treeNode);
					await pullRequest?.markFiles([treeNode.path], true, 'unviewed');
					manager?.setFileViewedContext();
				}
			} catch (e) {
				vscode.window.showErrorMessage(`Marked file as not viewed failed: ${e}`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.resetViewedFiles', async () => {
			try {
				return reposManager.folderManagers.map(async (manager) => {
					await manager.activePullRequest?.unmarkAllFilesAsViewed();
					manager.setFileViewedContext();
				});
			} catch (e) {
				vscode.window.showErrorMessage(`Marked file as not viewed failed: ${e}`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.collapseAllComments', () => {
			return vscode.commands.executeCommand('workbench.action.collapseAllComments');
		}));

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.copyCommentLink', (comment) => {
			if (comment instanceof GHPRComment) {
				return vscode.env.clipboard.writeText(comment.rawComment.htmlUrl);
			}
		}));

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.copyVscodeDevPrLink', async (params: BaseContext | undefined) => {
			let pr: PullRequestModel | undefined;
			if (params) {
				pr = await reposManager.getManagerForRepository(params.owner, params.repo)?.resolvePullRequest(params.owner, params.repo, params.number, true);
			} else {
				const activePullRequests: PullRequestModel[] = reposManager.folderManagers
					.map(folderManager => folderManager.activePullRequest!)
					.filter(activePR => !!activePR);
				pr = await chooseItem<PullRequestModel>(
					activePullRequests,
					itemValue => ({ label: `${itemValue.number}: ${itemValue.title}` }),
					{ placeHolder: vscode.l10n.t('Pull request to create a link for') },
				);
			}
			if (pr) {
				return vscode.env.clipboard.writeText(vscodeDevPrLink(pr));
			}
		}));

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.copyPrLink', async (params: BaseContext | undefined) => {
			let item: PullRequestModel | IssueModel | undefined;
			if (params) {
				const folderManager = reposManager.getManagerForRepository(params.owner, params.repo);
				item = await folderManager?.resolvePullRequest(params.owner, params.repo, params.number, true);
				if (!item) {
					item = await folderManager?.resolveIssue(params.owner, params.repo, params.number);
				}
			}
			if (item) {
				return vscode.env.clipboard.writeText(item.html_url);
			}
		}));

	function validateAndParseInput(input: string, expectedOwner: string, expectedRepo: string): { isValid: true; prNumber: number; errorMessage?: string } | { isValid: false; prNumber?: number; errorMessage: string } {
		const prNumberMatcher = /^#?(\d*)$/;
		const numberMatches = input.match(prNumberMatcher);
		if (numberMatches && (numberMatches.length === 2) && !Number.isNaN(Number(numberMatches[1]))) {
			const num = Number(numberMatches[1]);
			if (num > 0) {
				return { isValid: true, prNumber: num };
			}
		}

		const urlMatches = input.match(ISSUE_OR_URL_EXPRESSION);
		const parsed = parseIssueExpressionOutput(urlMatches);
		if (parsed && parsed.issueNumber && parsed.issueNumber > 0) {
			// Check if the repository owner and name match
			if (parsed.owner && parsed.name) {
				if (parsed.owner !== expectedOwner || parsed.name !== expectedRepo) {
					return { isValid: false, errorMessage: vscode.l10n.t('Repository in URL does not match the selected repository') };
				}
			}
			return { isValid: true, prNumber: parsed.issueNumber };
		}

		return { isValid: false, errorMessage: vscode.l10n.t('Value must be a pull request number or GitHub URL') };
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.checkoutByNumber', async () => {

			const githubRepositories: { manager: FolderRepositoryManager, repo: GitHubRepository }[] = [];
			for (const manager of reposManager.folderManagers) {
				const remotes = await manager.getActiveGitHubRemotes(await manager.getGitHubRemotes());
				const activeGitHubRepos = manager.gitHubRepositories.filter(repo => remotes.find(remote => remote.remoteName === repo.remote.remoteName));
				githubRepositories.push(...(activeGitHubRepos.map(repo => { return { manager, repo }; })));
			}
			const githubRepo = await chooseItem<{ manager: FolderRepositoryManager, repo: GitHubRepository }>(
				githubRepositories,
				itemValue => ({ label: `${itemValue.repo.remote.owner}/${itemValue.repo.remote.repositoryName}` }),
				{ placeHolder: vscode.l10n.t('Which GitHub repository do you want to checkout the pull request from?') }
			);
			if (!githubRepo) {
				return;
			}

			// Create QuickPick to show all PRs
			const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { pr?: PullRequestModel }>();
			quickPick.placeholder = vscode.l10n.t('Enter a pull request number/URL or select from the list');
			quickPick.matchOnDescription = true;
			quickPick.matchOnDetail = true;
			quickPick.show();

			let acceptDisposable: vscode.Disposable | undefined;
			let hideDisposable: vscode.Disposable | undefined;

			try {
				const selectedPromise = new Promise<{ selectedItem: (vscode.QuickPickItem & { prNumber?: number }) | undefined, selectedString: string | undefined }>((resolve) => {
					acceptDisposable = quickPick.onDidAccept(() => {
						let selectedString: string | undefined;
						let selectedItem: (vscode.QuickPickItem & { prNumber?: number }) | undefined;

						if (quickPick.value) {
							selectedString = quickPick.value;
						}

						if (quickPick.selectedItems.length > 0) {
							selectedItem = quickPick.selectedItems[0];
						}

						resolve({ selectedItem, selectedString });
					});
					hideDisposable = quickPick.onDidHide(() => resolve({ selectedItem: undefined, selectedString: undefined }));
				});

				const prs = await githubRepo.repo.getPullRequestNumbers();
				if (!prs) {
					return vscode.window.showErrorMessage(vscode.l10n.t('Failed to fetch pull requests'));
				}
				// Sort PRs by number in descending order (most recent first)
				const sortedPRs = prs.sort((a, b) => b.number - a.number);
				const prItems: (vscode.QuickPickItem & { prNumber: number })[] = sortedPRs.map(pr => ({
					label: `#${pr.number} ${pr.title}`,
					description: `by @${pr.author.login}`,
					prNumber: pr.number
				}));

				quickPick.items = prItems;
				const selected = await selectedPromise;
				quickPick.busy = true;

				if (!selected.selectedItem && !selected.selectedString) {
					return;
				}
				let prModel: PullRequestModel | undefined;

				// Check if user selected from the list or typed a custom value
				if (selected.selectedString) {
					// User typed a PR number or URL
					const parseResult = validateAndParseInput(selected.selectedString, githubRepo.repo.remote.owner, githubRepo.repo.remote.repositoryName);
					if (!parseResult.isValid && !selected.selectedItem) {
						return vscode.window.showErrorMessage(parseResult.errorMessage || vscode.l10n.t('Invalid pull request number or URL'));
					}

					if (parseResult.prNumber !== undefined) {
						// The user may have just entered part of a number and meant to select it from the list
						const selectedItemNumber = selected.selectedItem?.prNumber;
						if (selectedItemNumber !== undefined) {
							const parsedDigits = parseResult.prNumber.toString();
							const selectedDigits = selectedItemNumber.toString();
							if (selectedDigits.length > parsedDigits.length && selectedDigits.startsWith(parsedDigits)) {
								parseResult.prNumber = selectedItemNumber;
							}
						}
						prModel = await githubRepo.manager.fetchById(githubRepo.repo, parseResult.prNumber);
					}
				}
				if (selected.selectedItem?.prNumber && !prModel) {
					// User selected from the list
					prModel = await githubRepo.manager.fetchById(githubRepo.repo, selected.selectedItem.prNumber);
				}

				if (prModel) {
					return ReviewManager.getReviewManagerForFolderManager(reviewsManager.reviewManagers, githubRepo.manager)?.switch(prModel);
				}
			} catch (e) {
				vscode.window.showErrorMessage(vscode.l10n.t('Failed to fetch pull requests: {0}', formatError(e)));
			} finally {
				// Clean up event listeners and QuickPick
				acceptDisposable?.dispose();
				hideDisposable?.dispose();
				quickPick.hide();
				quickPick.dispose();
			}
		}));

	function chooseRepoToOpen() {
		const githubRepositories: GitHubRepository[] = [];
		reposManager.folderManagers.forEach(manager => {
			githubRepositories.push(...(manager.gitHubRepositories));
		});
		return chooseItem<GitHubRepository>(
			githubRepositories,
			itemValue => ({ label: `${itemValue.remote.owner}/${itemValue.remote.repositoryName}` }),
			{ placeHolder: vscode.l10n.t('Which GitHub repository do you want to open?') }
		);
	}
	context.subscriptions.push(
		vscode.commands.registerCommand('pr.openPullsWebsite', async () => {
			const githubRepo = await chooseRepoToOpen();
			if (githubRepo) {
				vscode.env.openExternal(getPullsUrl(githubRepo));
			}
		}));

	context.subscriptions.push(
		vscode.commands.registerCommand('issues.openIssuesWebsite', async () => {
			const githubRepo = await chooseRepoToOpen();
			if (githubRepo) {
				vscode.env.openExternal(getIssuesUrl(githubRepo));
			}
		}));

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.applySuggestion', async (comment: GHPRComment) => {
			/* __GDPR__
				"pr.applySuggestion" : {}
			*/
			telemetry.sendTelemetryEvent('pr.applySuggestion');

			const handler = resolveCommentHandler(comment.parent);

			if (handler instanceof ReviewCommentController) {
				handler.applySuggestion(comment);
			}
		}));
	context.subscriptions.push(
		vscode.commands.registerCommand('pr.applySuggestionWithCopilot', async (comment: GHPRComment | GHPRCommentThread) => {
			/* __GDPR__
				"pr.applySuggestionWithCopilot" : {}
			*/
			telemetry.sendTelemetryEvent('pr.applySuggestionWithCopilot');

			const isThread = GHPRCommentThread.is(comment);
			const commentThread = isThread ? comment : comment.parent;
			const commentBody = isThread ? comment.comments[0].body : comment.body;
			commentThread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
			const message = commentBody instanceof vscode.MarkdownString ? commentBody.value : commentBody;

			if (isThread) {
				// For threads, open the Chat view instead of inline chat
				await vscode.commands.executeCommand(commands.NEW_CHAT, { inputValue: message, isPartialQuery: true, agentMode: true });
				await vscode.commands.executeCommand(commands.OPEN_CHAT);
			} else {
				// For single comments, use inline chat
				await vscode.commands.executeCommand('vscode.editorChat.start', {
					initialRange: commentThread.range,
					message: message,
					autoSend: true,
				});
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('pr.addFileComment', async () => {
			return vscode.commands.executeCommand('workbench.action.addComment', { fileComment: true });
		}));

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.toggleEditorCommentingOn', async () => {
			commands.executeCommand('workbench.action.toggleCommenting');
		}));
	context.subscriptions.push(
		vscode.commands.registerCommand('pr.toggleEditorCommentingOff', async () => {
			commands.executeCommand('workbench.action.toggleCommenting');
		}));

	context.subscriptions.push(
		vscode.commands.registerCommand('review.diffWithPrHead', async (fileChangeNode: GitFileChangeNode) => {
			const fileName = fileChangeNode.fileName;
			let parentURI = toPRUri(
				fileChangeNode.resourceUri,
				fileChangeNode.pullRequest,
				fileChangeNode.pullRequest.base.sha,
				fileChangeNode.pullRequest.head.sha,
				fileChangeNode.fileName,
				true,
				fileChangeNode.status);
			let headURI = toPRUri(
				fileChangeNode.resourceUri,
				fileChangeNode.pullRequest,
				fileChangeNode.pullRequest.base.sha,
				fileChangeNode.pullRequest.head.sha,
				fileChangeNode.fileName,
				false,
				fileChangeNode.status);
			return vscode.commands.executeCommand('vscode.diff', parentURI, headURI, `${fileName} (Pull Request Compare Base with Head)`);
		}));

	context.subscriptions.push(
		vscode.commands.registerCommand('review.diffLocalWithPrHead', async (fileChangeNode: GitFileChangeNode) => {
			const fileName = fileChangeNode.fileName;
			let headURI = toPRUri(
				fileChangeNode.resourceUri,
				fileChangeNode.pullRequest,
				fileChangeNode.pullRequest.base.sha,
				fileChangeNode.pullRequest.head.sha,
				fileChangeNode.fileName,
				false,
				fileChangeNode.status);
			return vscode.commands.executeCommand('vscode.diff', headURI, fileChangeNode.resourceUri, `${fileName} (Pull Request Compare Head with Local)`);
		}));

	async function goToNextPrevDiff(diffs: vscode.LineChange[], next: boolean) {
		const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		const input = tab?.input;
		if (!(input instanceof vscode.TabInputTextDiff)) {
			return vscode.window.showErrorMessage(vscode.l10n.t('Current editor isn\'t a diff editor.'));
		}

		const editor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === input.modified.toString());
		if (!editor) {
			return vscode.window.showErrorMessage(vscode.l10n.t('Unexpectedly unable to find the current modified editor.'));
		}

		const editorUri = editor.document.uri;
		if ((input.original.scheme !== Schemes.Review) && (input.original.scheme !== Schemes.Pr)) {
			return vscode.window.showErrorMessage(vscode.l10n.t('Current file isn\'t a pull request diff.'));
		}

		// Find the next diff in the current file to scroll to
		const cursorPosition = editor.selection.active;
		const iterateThroughDiffs = next ? diffs : diffs.reverse();
		for (const diff of iterateThroughDiffs) {
			const practicalModifiedEndLineNumber = (diff.modifiedEndLineNumber > diff.modifiedStartLineNumber) ? diff.modifiedEndLineNumber : diff.modifiedStartLineNumber as number + 1;
			const diffRange = new vscode.Range(diff.modifiedStartLineNumber ? diff.modifiedStartLineNumber - 1 : diff.modifiedStartLineNumber, 0, practicalModifiedEndLineNumber, 0);

			// cursorPosition.line is 0-based, diff.modifiedStartLineNumber is 1-based
			if (next && cursorPosition.line + 1 < diff.modifiedStartLineNumber) {
				editor.revealRange(diffRange);
				editor.selection = new vscode.Selection(diffRange.start, diffRange.start);
				return;
			} else if (!next && cursorPosition.line + 1 > diff.modifiedStartLineNumber) {
				editor.revealRange(diffRange);
				editor.selection = new vscode.Selection(diffRange.start, diffRange.start);
				return;
			}
		}

		if (input.original.scheme === Schemes.Pr) {
			return vscode.window.showInformationMessage(vscode.l10n.t('No more diffs in this file. Check out the pull request to use this command across files.'));
		}

		// There is no new range to reveal, time to go to the next file.
		const folderManager = reposManager.getManagerForFile(editorUri);
		if (!folderManager) {
			return vscode.window.showErrorMessage(vscode.l10n.t('Unable to find a repository for pull request.'));
		}

		const reviewManager = ReviewManager.getReviewManagerForFolderManager(reviewsManager.reviewManagers, folderManager);
		if (!reviewManager) {
			return vscode.window.showErrorMessage(vscode.l10n.t('Cannot find active pull request.'));
		}

		if (!reviewManager.reviewModel.hasLocalFileChanges || (reviewManager.reviewModel.localFileChanges.length === 0)) {
			return vscode.window.showWarningMessage(vscode.l10n.t('Pull request data is not yet complete, please try again in a moment.'));
		}

		for (let i = 0; i < reviewManager.reviewModel.localFileChanges.length; i++) {
			const index = next ? i : reviewManager.reviewModel.localFileChanges.length - 1 - i;
			const localFileChange = reviewManager.reviewModel.localFileChanges[index];
			if (localFileChange.changeModel.filePath.toString() === editorUri.toString()) {
				const nextIndex = next ? index + 1 : index - 1;
				if (reviewManager.reviewModel.localFileChanges.length > nextIndex) {
					await reviewManager.reviewModel.localFileChanges[nextIndex].openDiff(folderManager);
					// if going backwards, we now need to go to the last diff in the file
					if (!next) {
						const editor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === reviewManager.reviewModel.localFileChanges[nextIndex].changeModel.filePath.toString());
						if (editor) {
							const diffs = await reviewManager.reviewModel.localFileChanges[nextIndex].changeModel.diffHunks();
							const diff = diffs[diffs.length - 1];
							const diffNewEndLine = diff.newLineNumber + diff.newLength;
							const practicalModifiedEndLineNumber = (diffNewEndLine > diff.newLineNumber) ? diffNewEndLine : diff.newLineNumber as number + 1;
							const diffRange = new vscode.Range(diff.newLineNumber ? diff.newLineNumber - 1 : diff.newLineNumber, 0, practicalModifiedEndLineNumber, 0);
							editor.revealRange(diffRange);
							editor.selection = new vscode.Selection(diffRange.start, diffRange.start);
						}
					}
					return;
				}
			}
		}
		// No further files in PR.
		const goInCircle = next ? vscode.l10n.t('Go to first diff') : vscode.l10n.t('Go to last diff');
		return vscode.window.showInformationMessage(vscode.l10n.t('There are no more diffs in this pull request.'), goInCircle).then(result => {
			if (result === goInCircle) {
				return reviewManager.reviewModel.localFileChanges[next ? 0 : reviewManager.reviewModel.localFileChanges.length - 1].openDiff(folderManager);
			}
		});
	}

	context.subscriptions.push(
		vscode.commands.registerDiffInformationCommand('pr.goToNextDiffInPr', async (diffs: vscode.LineChange[]) => {
			goToNextPrevDiff(diffs, true);
		}));
	context.subscriptions.push(
		vscode.commands.registerDiffInformationCommand('pr.goToPreviousDiffInPr', async (diffs: vscode.LineChange[]) => {
			goToNextPrevDiff(diffs, false);
		}));

	context.subscriptions.push(vscode.commands.registerCommand('pr.refreshComments', async () => {
		for (const folderManager of reposManager.folderManagers) {
			for (const githubRepository of folderManager.gitHubRepositories) {
				for (const pullRequest of githubRepository.pullRequestModels) {
					if (pullRequest.isResolved() && pullRequest.reviewThreadsCacheReady) {
						pullRequest.initializeReviewThreadCache();
					}
				}
			}
		}
	}));

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.closeRelatedEditors', closeAllPrAndReviewEditors)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('review.copyPrLink', async () => {
			const activePullRequests: PullRequestModel[] = reposManager.folderManagers
				.map(folderManager => folderManager.activePullRequest!)
				.filter(activePR => !!activePR);

			const pr = await chooseItem<PullRequestModel>(
				activePullRequests,
				itemValue => ({ label: `${itemValue.number}: ${itemValue.title}` }),
				{ placeHolder: vscode.l10n.t('Pull request to create a link for') },
			);
			if (pr) {
				return vscode.env.clipboard.writeText(pr.html_url);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.generateTitleAndDescription', async (args: { rootUri: vscode.Uri; baseBranch: string; compareBranch: string }) => {
			if (!args?.rootUri || !args?.baseBranch || !args?.compareBranch) {
				Logger.error('Missing required arguments for pr.generateTitleAndDescription', logId);
				return undefined;
			}

			const folderManager = reposManager.getManagerForFile(args.rootUri);
			if (!folderManager) {
				Logger.error('Unable to find a repository for the provided rootUri.', logId);
				return undefined;
			}

			const origin = await folderManager.getOrigin();
			const defaults = await folderManager.getPullRequestDefaults();

			const model = new CreatePullRequestDataModel(
				folderManager,
				defaults.owner,
				args.baseBranch,
				origin.remote.owner,
				args.compareBranch,
				origin.remote.repositoryName,
			);

			try {
				const { commitMessages, patches } = await model.getCommitsAndPatches();
				const issues = await model.findIssueContext(commitMessages);
				const template = await folderManager.getPullRequestTemplateBody(defaults.owner);

				const provider = folderManager.getTitleAndDescriptionProvider();
				if (!provider) {
					Logger.error('No title and description provider available.', logId);
					return undefined;
				}

				const tokenSource = new vscode.CancellationTokenSource();
				const result = await provider.provider.provideTitleAndDescription(
					{ commitMessages, patches, issues, template },
					tokenSource.token,
				);

				/* __GDPR__
					"pr.generatedTitleAndDescription" : {
						"providerTitle" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
						"source" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
					}
				*/
				telemetry.sendTelemetryEvent('pr.generatedTitleAndDescription', { providerTitle: provider?.title, source: 'command' });

				tokenSource.dispose();

				return result ? { title: result.title, description: result.description } : undefined;
			} catch (e) {
				Logger.error(`Error generating title and description: ${formatError(e)}`, logId);
				return undefined;
			} finally {
				model.dispose();
			}
		}),
	);
}
