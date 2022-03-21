/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as pathLib from 'path';
import * as vscode from 'vscode';
import { GitErrorCodes } from './api/api1';
import { CommentReply, resolveCommentHandler } from './commentHandlerResolver';
import { IComment } from './common/comment';
import Logger from './common/logger';
import { SessionState } from './common/sessionState';
import { ITelemetry } from './common/telemetry';
import { asImageDataURI } from './common/uri';
import { formatError } from './common/utils';
import { EXTENSION_ID } from './constants';
import { CredentialStore } from './github/credentials';
import { FolderRepositoryManager } from './github/folderRepositoryManager';
import { GitHubRepository } from './github/githubRepository';
import { PullRequest } from './github/interface';
import { GHPRComment, TemporaryComment } from './github/prComment';
import { PullRequestModel } from './github/pullRequestModel';
import { PullRequestOverviewPanel } from './github/pullRequestOverview';
import { RepositoriesManager } from './github/repositoriesManager';
import { isInCodespaces } from './github/utils';
import { PullRequestsTreeDataProvider } from './view/prsTreeDataProvider';
import { ReviewManager } from './view/reviewManager';
import { CategoryTreeNode } from './view/treeNodes/categoryNode';
import { CommitNode } from './view/treeNodes/commitNode';
import { DescriptionNode } from './view/treeNodes/descriptionNode';
import {
	GitFileChangeNode,
	InMemFileChangeNode,
	openFileCommand,
	RemoteFileChangeNode,
} from './view/treeNodes/fileChangeNode';
import { PRNode } from './view/treeNodes/pullRequestNode';

const _onDidUpdatePR = new vscode.EventEmitter<PullRequest | void>();
export const onDidUpdatePR: vscode.Event<PullRequest | void> = _onDidUpdatePR.event;

function ensurePR(folderRepoManager: FolderRepositoryManager, pr?: PRNode | PullRequestModel): PullRequestModel {
	// If the command is called from the command palette, no arguments are passed.
	if (!pr) {
		if (!folderRepoManager.activePullRequest) {
			vscode.window.showErrorMessage('Unable to find current pull request.');
			throw new Error('Unable to find current pull request.');
		}

		return folderRepoManager.activePullRequest;
	} else {
		return pr instanceof PRNode ? pr.pullRequestModel : pr;
	}
}

export async function openDescription(
	context: vscode.ExtensionContext,
	telemetry: ITelemetry,
	pullRequestModel: PullRequestModel,
	descriptionNode: DescriptionNode | undefined,
	folderManager: FolderRepositoryManager,
) {
	const pullRequest = ensurePR(folderManager, pullRequestModel);
	descriptionNode?.reveal(descriptionNode, { select: true, focus: true });
	// Create and show a new webview
	await PullRequestOverviewPanel.createOrShow(context.extensionUri, folderManager, pullRequest);

	/* __GDPR__
		"pr.openDescription" : {}
	*/
	telemetry.sendTelemetryEvent('pr.openDescription');
}

async function chooseItem<T>(
	activePullRequests: T[],
	propertyGetter: (itemValue: T) => string,
	options?: vscode.QuickPickOptions,
): Promise<T | undefined> {
	if (activePullRequests.length === 1) {
		return activePullRequests[0];
	}
	interface Item extends vscode.QuickPickItem {
		itemValue: T;
	}
	const items: Item[] = activePullRequests.map(currentItem => {
		return {
			label: propertyGetter(currentItem),
			itemValue: currentItem,
		};
	});
	return (await vscode.window.showQuickPick(items, options))?.itemValue;
}

export async function openPullRequestOnGitHub(e: PRNode | DescriptionNode | PullRequestModel, telemetry: ITelemetry) {
	if (e instanceof PRNode || e instanceof DescriptionNode) {
		vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.pullRequestModel.html_url));
	} else {
		vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.html_url));
	}

	/** __GDPR__
	 "pr.openInGitHub" : {}
	*/
	telemetry.sendTelemetryEvent('pr.openInGitHub');
}

export function registerCommands(
	context: vscode.ExtensionContext,
	sessionState: SessionState,
	reposManager: RepositoriesManager,
	reviewManagers: ReviewManager[],
	telemetry: ITelemetry,
	credentialStore: CredentialStore,
	tree: PullRequestsTreeDataProvider,
) {
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'pr.openPullRequestOnGitHub',
			async (e: PRNode | DescriptionNode | PullRequestModel | undefined) => {
				if (!e) {
					const activePullRequests: PullRequestModel[] = reposManager.folderManagers
						.map(folderManager => folderManager.activePullRequest!)
						.filter(activePR => !!activePR);

					if (activePullRequests.length >= 1) {
						const result = await chooseItem<PullRequestModel>(
							activePullRequests,
							itemValue => itemValue.html_url,
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
							itemValue => itemValue.activePr.html_url,
						)
					)
					: activePullRequestsWithFolderManager[0];

				if (!activePullRequestAndFolderManager) {
					return;
				}

				const { folderManager } = activePullRequestAndFolderManager;
				const reviewManager = ReviewManager.getReviewManagerForFolderManager(reviewManagers, folderManager);

				if (!reviewManager) {
					return;
				}

				reviewManager.reviewModel.localFileChanges
					.forEach(localFileChange => localFileChange.openDiff(folderManager, { preview: false }));
			}
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('review.suggestDiff', async e => {
			try {
				const folderManager = await chooseItem<FolderRepositoryManager>(
					reposManager.folderManagers,
					itemValue => pathLib.basename(itemValue.repository.rootUri.fsPath),
				);
				if (!folderManager || !folderManager.activePullRequest) {
					return;
				}

				const { indexChanges, workingTreeChanges } = folderManager.repository.state;

				if (!indexChanges.length) {
					if (workingTreeChanges.length) {
						const stageAll = await vscode.window.showWarningMessage(
							'There are no staged changes to suggest.\n\nWould you like to automatically stage all your of changes and suggest them?',
							{ modal: true },
							'Yes',
						);
						if (stageAll === 'Yes') {
							await vscode.commands.executeCommand('git.stageAll');
						} else {
							return;
						}
					} else {
						vscode.window.showInformationMessage('There are no changes to suggest.');
						return;
					}
				}

				const diff = await folderManager.repository.diff(true);

				let suggestEditMessage = 'Suggested edit:\n';
				if (e && e.inputBox && e.inputBox.value) {
					suggestEditMessage = `${e.inputBox.value}\n`;
					e.inputBox.value = '';
				}

				const suggestEditText = `${suggestEditMessage}\`\`\`diff\n${diff}\n\`\`\``;
				await folderManager.activePullRequest.createIssueComment(suggestEditText);

				// Reset HEAD and then apply reverse diff
				await vscode.commands.executeCommand('git.unstageAll');

				const tempFilePath = pathLib.join(
					folderManager.repository.rootUri.fsPath,
					'.git',
					`${folderManager.activePullRequest.number}.diff`,
				);
				const encoder = new TextEncoder();
				const tempUri = vscode.Uri.file(tempFilePath);

				await vscode.workspace.fs.writeFile(tempUri, encoder.encode(diff));
				await folderManager.repository.apply(tempFilePath, true);
				await vscode.workspace.fs.delete(tempUri);
			} catch (err) {
				const moreError = `${err}${err.stderr ? `\n${err.stderr}` : ''}`;
				Logger.appendLine(`Applying patch failed: ${moreError}`);
				vscode.window.showErrorMessage(`Applying patch failed: ${formatError(err)}`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.openFileOnGitHub', async (e: GitFileChangeNode | RemoteFileChangeNode) => {
			if (e instanceof RemoteFileChangeNode) {
				const choice = await vscode.window.showInformationMessage(
					`${e.fileName} can't be opened locally. Do you want to open it on GitHub?`,
					'Open',
				);
				if (!choice) {
					return;
				}
			}
			if (e.blobUrl) {
				return vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.blobUrl));
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.copyCommitHash', (e: CommitNode) => {
			vscode.env.clipboard.writeText(e.sha);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.openOriginalFile', async (e: GitFileChangeNode) => {
			// if this is an image, encode it as a base64 data URI
			const folderManager = reposManager.getManagerForIssueModel(e.pullRequest);
			if (folderManager) {
				const imageDataURI = await asImageDataURI(e.parentFilePath, folderManager.repository);
				vscode.commands.executeCommand('vscode.open', imageDataURI || e.parentFilePath);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.openModifiedFile', (e: GitFileChangeNode) => {
			vscode.commands.executeCommand('vscode.open', e.filePath);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'pr.openDiffView',
			(fileChangeNode: GitFileChangeNode | InMemFileChangeNode) => {
				const folderManager = reposManager.getManagerForIssueModel(fileChangeNode.pullRequest);
				if (!folderManager) {
					return;
				}
				fileChangeNode.openDiff(folderManager);
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
			const DELETE_BRANCH_FORCE = 'delete branch (even if not merged)';
			let error = null;

			try {
				await folderManager.deleteLocalPullRequest(pullRequestModel);
			} catch (e) {
				if (e.gitErrorCode === GitErrorCodes.BranchNotFullyMerged) {
					const action = await vscode.window.showErrorMessage(
						`The branch '${pullRequestModel.localBranchName}' is not fully merged, are you sure you want to delete it? `,
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
				// fire and forget
				vscode.commands.executeCommand('pr.refreshList');
			}
		}),
	);

	function chooseReviewManager(repoPath?: string) {
		if (repoPath) {
			const uri = vscode.Uri.file(repoPath).toString();
			for (const mgr of reviewManagers) {
				if (mgr.repository.rootUri.toString() === uri) {
					return mgr;
				}
			}
		}
		return chooseItem<ReviewManager>(
			reviewManagers,
			itemValue => pathLib.basename(itemValue.repository.rootUri.fsPath),
			{ placeHolder: 'Choose a repository to create a pull request in', ignoreFocusOut: true },
		);
	}

	function isSourceControl(x: any): x is { rootUri: vscode.Uri } {
		return !!x?.rootUri;
	}

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'pr.create',
			async (args?: { repoPath: string; compareBranch: string } | { rootUri: vscode.Uri }) => {
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
		vscode.commands.registerCommand('pr.pick', async (pr: PRNode | DescriptionNode | PullRequestModel) => {
			let pullRequestModel: PullRequestModel;

			if (pr instanceof PRNode || pr instanceof DescriptionNode) {
				pullRequestModel = pr.pullRequestModel;
			} else {
				pullRequestModel = pr;
			}

			const fromDescriptionPage = pr instanceof PullRequestModel;
			/* __GDPR__
			"pr.checkout" : {
				"fromDescriptionPage" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
			}
		*/
			telemetry.sendTelemetryEvent('pr.checkout', { fromDescription: fromDescriptionPage.toString() });

			return vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.SourceControl,
					title: `Switching to Pull Request #${pullRequestModel.number}`,
				},
				async () => {
					await ReviewManager.getReviewManagerForRepository(
						reviewManagers,
						pullRequestModel.githubRepository,
					)?.switch(pullRequestModel);
				},
			);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.exit', async (pr: PRNode | DescriptionNode | PullRequestModel) => {
			let pullRequestModel: PullRequestModel;

			if (pr instanceof PRNode || pr instanceof DescriptionNode) {
				pullRequestModel = pr.pullRequestModel;
			} else {
				pullRequestModel = pr;
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
					title: `Exiting Pull Request`,
				},
				async () => {
					const branch = await pullRequestModel.githubRepository.getDefaultBranch();
					const manager = reposManager.getManagerForIssueModel(pullRequestModel);
					if (manager) {
						manager.checkoutDefaultBranch(branch);
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

			return vscode.window
				.showWarningMessage(
					`Are you sure you want to merge this pull request on GitHub?`,
					{ modal: true },
					'Yes',
				)
				.then(async value => {
					let newPR;
					if (value === 'Yes') {
						try {
							newPR = await folderManager.mergePullRequest(pullRequest);
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
		vscode.commands.registerCommand('pr.readyForReview', async (pr?: PRNode) => {
			const folderManager = reposManager.getManagerForIssueModel(pr?.pullRequestModel);
			if (!folderManager) {
				return;
			}
			const pullRequest = ensurePR(folderManager, pr);
			return vscode.window
				.showWarningMessage(
					`Are you sure you want to mark this pull request as ready to review on GitHub?`,
					{ modal: true },
					'Yes',
				)
				.then(async value => {
					let isDraft;
					if (value === 'Yes') {
						try {
							isDraft = await pullRequest.setReadyForReview();
							vscode.commands.executeCommand('pr.refreshList');
							return isDraft;
						} catch (e) {
							vscode.window.showErrorMessage(
								`Unable to mark pull request as ready to review. ${formatError(e)}`,
							);
							return isDraft;
						}
					}
				});
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.close', async (pr?: PRNode | PullRequestModel, message?: string) => {
			let pullRequestModel: PullRequestModel | undefined;
			if (pr) {
				pullRequestModel = pr instanceof PullRequestModel ? pr : pr.pullRequestModel;
			} else {
				const activePullRequests: PullRequestModel[] = reposManager.folderManagers
					.map(folderManager => folderManager.activePullRequest!)
					.filter(activePR => !!activePR);
				pullRequestModel = await chooseItem<PullRequestModel>(
					activePullRequests,
					itemValue => `${itemValue.number}: ${itemValue.title}`,
					{ placeHolder: 'Pull request to close' },
				);
			}
			if (!pullRequestModel) {
				return;
			}
			const pullRequest: PullRequestModel = pullRequestModel;
			return vscode.window
				.showWarningMessage(
					`Are you sure you want to close this pull request on GitHub? This will close the pull request without merging.`,
					{ modal: true },
					'Yes',
					'No',
				)
				.then(async value => {
					if (value === 'Yes') {
						try {
							let newComment: IComment | undefined = undefined;
							if (message) {
								newComment = await pullRequest.createIssueComment(message);
							}

							const newPR = await pullRequest.close();
							vscode.commands.executeCommand('pr.refreshList');
							_onDidUpdatePR.fire(newPR);
							return newComment;
						} catch (e) {
							vscode.window.showErrorMessage(`Unable to close pull request. ${formatError(e)}`);
							_onDidUpdatePR.fire();
						}
					}

					_onDidUpdatePR.fire();
				});
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'pr.openDescription',
			async (argument: DescriptionNode | PullRequestModel | undefined) => {
				let pullRequestModel: PullRequestModel | undefined;
				if (!argument) {
					const activePullRequests: PullRequestModel[] = reposManager.folderManagers
						.map(manager => manager.activePullRequest!)
						.filter(activePR => !!activePR);
					if (activePullRequests.length >= 1) {
						pullRequestModel = await chooseItem<PullRequestModel>(
							activePullRequests,
							itemValue => itemValue.title,
						);
					}
				} else {
					pullRequestModel = argument instanceof DescriptionNode ? argument.pullRequestModel : argument;
				}

				if (!pullRequestModel) {
					Logger.appendLine('No pull request found.');
					return;
				}

				const folderManager = reposManager.getManagerForIssueModel(pullRequestModel);
				if (!folderManager) {
					return;
				}

				let descriptionNode: DescriptionNode | undefined;
				if (argument instanceof DescriptionNode) {
					descriptionNode = argument;
				} else {
					const reviewManager = ReviewManager.getReviewManagerForFolderManager(reviewManagers, folderManager);
					if (!reviewManager) {
						return;
					}

					descriptionNode = reviewManager.changesInPrDataProvider.getDescriptionNode(folderManager);
				}

				await openDescription(context, telemetry, pullRequestModel, descriptionNode, folderManager);
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.refreshDescription', async () => {
			if (PullRequestOverviewPanel.currentPanel) {
				PullRequestOverviewPanel.refresh();
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.openDescriptionToTheSide', async (descriptionNode: DescriptionNode) => {
			const folderManager = reposManager.getManagerForIssueModel(descriptionNode.pullRequestModel);
			if (!folderManager) {
				return;
			}
			const pr = descriptionNode.pullRequestModel;
			const pullRequest = ensurePR(folderManager, pr);
			descriptionNode.reveal(descriptionNode, { select: true, focus: true });
			// Create and show a new webview
			PullRequestOverviewPanel.createOrShow(context.extensionUri, folderManager, pullRequest, true);

			/* __GDPR__
			"pr.openDescriptionToTheSide" : {}
		*/
			telemetry.sendTelemetryEvent('pr.openDescriptionToTheSide');
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.signin', async () => {
			await reposManager.authenticate();
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
		vscode.commands.registerCommand('pr.openReview', async (reply: CommentReply) => {
			/* __GDPR__
				"pr.openReview" : {}
			*/
			telemetry.sendTelemetryEvent('pr.openReview');
			const handler = resolveCommentHandler(reply.thread);

			if (handler) {
				await handler.openReview(reply.thread);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.resolveReviewThread', async (reply: CommentReply) => {
			/* __GDPR__
			"pr.resolveReviewThread" : {}
			*/
			telemetry.sendTelemetryEvent('pr.resolveReviewThread');
			const handler = resolveCommentHandler(reply.thread);

			if (handler) {
				await handler.resolveReviewThread(reply.thread, reply.text);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.unresolveReviewThread', async (reply: CommentReply) => {
			/* __GDPR__
			"pr.unresolveReviewThread" : {}
			*/
			telemetry.sendTelemetryEvent('pr.unresolveReviewThread');
			const handler = resolveCommentHandler(reply.thread);

			if (handler) {
				await handler.unresolveReviewThread(reply.thread, reply.text);
			}
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
			return query.editQuery();
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

			const shouldDelete = await vscode.window.showWarningMessage('Delete comment?', { modal: true }, 'Delete');

			if (shouldDelete === 'Delete') {
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
		vscode.commands.registerCommand('pr.refreshChanges', _ => {
			reviewManagers.forEach(reviewManager => {
				reviewManager.updateComments();
				PullRequestOverviewPanel.refresh();
				reviewManager.changesInPrDataProvider.refresh();
			});
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.setFileListLayoutAsTree', _ => {
			vscode.workspace.getConfiguration('githubPullRequests').update('fileListLayout', 'tree', true);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.setFileListLayoutAsFlat', _ => {
			vscode.workspace.getConfiguration('githubPullRequests').update('fileListLayout', 'flat', true);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.refreshPullRequest', (prNode: PRNode) => {
			const folderManager = reposManager.getManagerForIssueModel(prNode.pullRequestModel);
			if (folderManager && prNode.pullRequestModel.equals(folderManager?.activePullRequest)) {
				ReviewManager.getReviewManagerForFolderManager(reviewManagers, folderManager)?.updateComments();
			}

			PullRequestOverviewPanel.refresh();
			tree.refresh(prNode);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.markFileAsViewed', async (treeNode: GitFileChangeNode | vscode.Uri) => {
			try {
				if (treeNode instanceof GitFileChangeNode) {
					await treeNode.pullRequest.markFileAsViewed(treeNode.fileName);
				} else {
					const manager = reposManager.getManagerForFile(treeNode);
					await manager?.activePullRequest?.markFileAsViewed(treeNode.path);
				}
			} catch (e) {
				vscode.window.showErrorMessage(`Marked file as viewed failed: ${e}`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.unmarkFileAsViewed', async (treeNode: GitFileChangeNode | vscode.Uri) => {
			try {
				if (treeNode instanceof GitFileChangeNode) {
					await treeNode.pullRequest.unmarkFileAsViewed(treeNode.fileName);
				} else {
					const manager = reposManager.getManagerForFile(treeNode);
					await manager?.activePullRequest?.unmarkFileAsViewed(treeNode.path);
				}
			} catch (e) {
				vscode.window.showErrorMessage(`Marked file as not viewed failed: ${e}`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.expandAllComments', () => {
			sessionState.commentsExpandState = true;
		}));

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.collapseAllComments', () => {
			sessionState.commentsExpandState = false;
		}));

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.checkoutByNumber', async () => {

			const githubRepositories: { manager: FolderRepositoryManager, repo: GitHubRepository }[] = [];
			reposManager.folderManagers.forEach(manager => {
				githubRepositories.push(...(manager.gitHubRepositories.map(repo => { return { manager, repo }; })));
			});
			const githubRepo = await chooseItem<{ manager: FolderRepositoryManager, repo: GitHubRepository }>(
				githubRepositories,
				itemValue => `${itemValue.repo.remote.owner}/${itemValue.repo.remote.repositoryName}`,
				{ placeHolder: 'Which GitHub repository do you want to checkout the pull request from?' }
			);
			if (!githubRepo) {
				return;
			}
			const prNumberMatcher = /^#?(\d*)$/;
			const prNumber = await vscode.window.showInputBox({
				ignoreFocusOut: true, prompt: 'Enter the a pull request number',
				validateInput: (input: string) => {
					const matches = input.match(prNumberMatcher);
					if (!matches || (matches.length !== 2) || Number.isNaN(Number(matches[1]))) {
						return 'Value must be a number';
					}
					return undefined;
				}
			});
			if ((prNumber === undefined) || prNumber === '#') {
				return;
			}
			const prModel = await githubRepo.manager.fetchById(githubRepo.repo, Number(prNumber.match(prNumberMatcher)![1]));
			if (prModel) {
				return ReviewManager.getReviewManagerForFolderManager(reviewManagers, githubRepo.manager)?.switch(prModel);
			}
		}));
}
