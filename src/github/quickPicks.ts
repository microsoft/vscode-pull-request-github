/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { Buffer } from 'buffer';
import * as vscode from 'vscode';
import { RemoteInfo } from '../../common/views';
import { DataUri } from '../common/uri';
import { formatError } from '../common/utils';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { GitHubRepository, TeamReviewerRefreshKind } from './githubRepository';
import { IAccount, ILabel, IMilestone, isTeam, ISuggestedReviewer, ITeam, reviewerId, ReviewState } from './interface';
import { PullRequestModel } from './pullRequestModel';

export async function getAssigneesQuickPickItems(folderRepositoryManager: FolderRepositoryManager, remoteName: string, alreadyAssigned: IAccount[], item?: PullRequestModel):
	Promise<(vscode.QuickPickItem & { assignee?: IAccount })[]> {

	const [allAssignableUsers, participantsAndViewer] = await Promise.all([
		folderRepositoryManager.getAssignableUsers(),
		item ? folderRepositoryManager.getPullRequestParticipants(item.githubRepository, item.number) : undefined
	]);
	const viewer = participantsAndViewer?.viewer;
	const participants = participantsAndViewer?.participants ?? [];

	let assignableUsers = allAssignableUsers[remoteName];

	assignableUsers = assignableUsers ?? [];
	// used to track logins that shouldn't be added to pick list
	// e.g. author, existing and already added reviewers
	const skipList: Set<string> = new Set([...(alreadyAssigned.map(assignee => assignee.login) ?? [])]);

	const assignees: Promise<(vscode.QuickPickItem & { assignee?: IAccount })>[] = [];
	// Start will all currently assigned so they show at the top
	for (const current of (alreadyAssigned ?? [])) {
		assignees.push(DataUri.avatarCircleAsImageDataUri(current, 16, 16).then(avatarUrl => {
			return {
				label: current.login,
				description: current.name,
				assignee: current,
				picked: true,
				iconPath: avatarUrl
			};
		}));
	}

	// Check if the viewer is allowed to be assigned to the PR
	if (viewer && !skipList.has(viewer.login) && (assignableUsers.findIndex((assignableUser: IAccount) => assignableUser.login === viewer.login) !== -1)) {
		assignees.push(DataUri.avatarCircleAsImageDataUri(viewer, 16, 16).then(avatarUrl => {
			return {
				label: viewer.login,
				description: viewer.name,
				assignee: viewer,
				iconPath: avatarUrl
			};
		}));
		skipList.add(viewer.login);
	}

	for (const suggestedReviewer of participants) {
		if (skipList.has(suggestedReviewer.login)) {
			continue;
		}

		assignees.push(DataUri.avatarCircleAsImageDataUri(suggestedReviewer, 16, 16).then(avatarUrl => {
			return {
				label: suggestedReviewer.login,
				description: suggestedReviewer.name,
				assignee: suggestedReviewer,
				iconPath: avatarUrl
			};
		}));
		// this user shouldn't be added later from assignable users list
		skipList.add(suggestedReviewer.login);
	}

	if (assignees.length !== 0) {
		assignees.unshift(Promise.resolve({
			kind: vscode.QuickPickItemKind.Separator,
			label: vscode.l10n.t('Suggestions')
		}));
	}

	for (const user of assignableUsers) {
		if (skipList.has(user.login)) {
			continue;
		}

		assignees.push(DataUri.avatarCircleAsImageDataUri(user, 16, 16).then(avatarUrl => {
			return {
				label: user.login,
				description: user.name,
				assignee: user,
				iconPath: avatarUrl
			};
		}));
	}

	if (assignees.length === 0) {
		assignees.push(Promise.resolve({
			label: vscode.l10n.t('No assignees available for this repository')
		}));
	}

	return Promise.all(assignees);
}

async function getReviewersQuickPickItems(folderRepositoryManager: FolderRepositoryManager, remoteName: string, isInOrganization: boolean, author: IAccount, existingReviewers: ReviewState[],
	suggestedReviewers: ISuggestedReviewer[] | undefined, refreshKind: TeamReviewerRefreshKind,
): Promise<(vscode.QuickPickItem & { reviewer?: IAccount | ITeam })[]> {
	if (!suggestedReviewers) {
		return [];
	}

	const allAssignableUsers = await folderRepositoryManager.getAssignableUsers();
	const allTeamReviewers = isInOrganization ? await folderRepositoryManager.getTeamReviewers(refreshKind) : [];
	const teamReviewers: ITeam[] = allTeamReviewers[remoteName] ?? [];
	const assignableUsers: (IAccount | ITeam)[] = [...teamReviewers];
	assignableUsers.push(...allAssignableUsers[remoteName]);
	let hasTeams = teamReviewers.length > 0;

	// used to track logins that shouldn't be added to pick list
	// e.g. author, existing and already added reviewers
	const skipList: Set<string> = new Set([
		author.login,
		...existingReviewers.map(reviewer => {
			if (isTeam(reviewer.reviewer)) {
				hasTeams = true;
			}
			return reviewerId(reviewer.reviewer);
		}),
	]);

	const reviewers: Promise<(vscode.QuickPickItem & { reviewer?: IAccount | ITeam })>[] = [];
	// Start will all existing reviewers so they show at the top
	for (const reviewer of existingReviewers) {
		const label = isTeam(reviewer.reviewer) ? `$(organization) ${reviewer.reviewer.org}/${reviewer.reviewer.slug}` : `${hasTeams ? `$(account) ` : ''}${reviewer.reviewer.login}`;
		reviewers.push(DataUri.avatarCircleAsImageDataUri(reviewer.reviewer, 16, 16).then(avatarUrl => {
			return {
				label,
				description: reviewer.reviewer.name,
				reviewer: reviewer.reviewer,
				picked: true,
				iconPath: avatarUrl
			};
		}));
	}

	for (const user of suggestedReviewers) {
		const { login, name, isAuthor, isCommenter } = user;
		if (skipList.has(login)) {
			continue;
		}

		const suggestionReason: string =
			isAuthor && isCommenter
				? vscode.l10n.t('Recently edited and reviewed changes to these files')
				: isAuthor
					? vscode.l10n.t('Recently edited these files')
					: isCommenter
						? vscode.l10n.t('Recently reviewed changes to these files')
						: vscode.l10n.t('Suggested reviewer');

		const label = `${hasTeams ? `$(account) ` : ''}${login}`;
		reviewers.push(DataUri.avatarCircleAsImageDataUri(user, 16, 16).then(avatarUrl => {
			return {
				label,
				description: name,
				detail: suggestionReason,
				reviewer: user,
				iconPath: avatarUrl
			};
		}));
		// this user shouldn't be added later from assignable users list
		skipList.add(login);
	}

	for (const user of assignableUsers) {
		if (skipList.has(reviewerId(user))) {
			continue;
		}

		const label = isTeam(user) ? `$(organization) ${user.org}/${user.slug}` : `${hasTeams ? `$(account) ` : ''}${user.login}`;
		reviewers.push(DataUri.avatarCircleAsImageDataUri(user, 16, 16).then(avatarUrl => {
			return {
				label,
				description: user.name,
				reviewer: user,
				iconPath: avatarUrl
			};
		}));
	}

	if (reviewers.length === 0) {
		reviewers.push(Promise.resolve({
			label: vscode.l10n.t('No reviewers available for this repository')
		}));
	}

	return Promise.all(reviewers);
}

export async function reviewersQuickPick(folderRepositoryManager: FolderRepositoryManager, remoteName: string, isInOrganization: boolean, teamsCount: number, author: IAccount, existingReviewers: ReviewState[],
	suggestedReviewers: ISuggestedReviewer[] | undefined): Promise<vscode.QuickPick<vscode.QuickPickItem & {
		reviewer?: IAccount | ITeam | undefined;
	}>> {
	const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { reviewer?: IAccount | ITeam }>();
	// The quick-max is used to show the "update reviewers" button. If the number of teams is less than the quick-max, then they'll be automatically updated when the quick pick is opened.
	const quickMaxTeamReviewers = 100;
	const defaultPlaceholder = vscode.l10n.t('Add reviewers');
	quickPick.busy = true;
	quickPick.canSelectMany = true;
	quickPick.matchOnDescription = true;
	quickPick.placeholder = defaultPlaceholder;
	quickPick.show();
	const updateItems = async (refreshKind: TeamReviewerRefreshKind) => {
		const slowWarning = setTimeout(() => {
			quickPick.placeholder = vscode.l10n.t('Getting team reviewers can take several minutes. Results will be cached.');
		}, 3000);
		quickPick.items = await getReviewersQuickPickItems(folderRepositoryManager, remoteName, isInOrganization, author, existingReviewers, suggestedReviewers, refreshKind);
		clearTimeout(slowWarning);
		quickPick.selectedItems = quickPick.items.filter(item => item.picked);
		quickPick.placeholder = defaultPlaceholder;
	};

	await updateItems((teamsCount !== 0 && teamsCount <= quickMaxTeamReviewers) ? TeamReviewerRefreshKind.Try : TeamReviewerRefreshKind.None);
	if (isInOrganization) {
		quickPick.buttons = [{ iconPath: new vscode.ThemeIcon('organization'), tooltip: vscode.l10n.t('Show or refresh team reviewers') }];
	}
	quickPick.onDidTriggerButton(() => {
		quickPick.busy = true;
		quickPick.ignoreFocusOut = true;
		updateItems(TeamReviewerRefreshKind.Force).then(() => {
			quickPick.ignoreFocusOut = false;
			quickPick.busy = false;
		});
	});
	return quickPick;
}

type MilestoneQuickPickItem = vscode.QuickPickItem & { id: string; milestone: IMilestone };

function isMilestoneQuickPickItem(x: vscode.QuickPickItem | MilestoneQuickPickItem): x is MilestoneQuickPickItem {
	return !!(x as MilestoneQuickPickItem).id && !!(x as MilestoneQuickPickItem).milestone;
}

export async function getMilestoneFromQuickPick(folderRepositoryManager: FolderRepositoryManager, githubRepository: GitHubRepository, callback: (milestone: IMilestone) => Promise<void>): Promise<void> {
	try {
		async function getMilestoneOptions(): Promise<(MilestoneQuickPickItem | vscode.QuickPickItem)[]> {
			const milestones = await githubRepository.getMilestones();
			if (!milestones.length) {
				return [
					{
						label: vscode.l10n.t('No milestones created for this repository.'),
					},
				];
			}

			return milestones.map(result => {
				return {
					iconPath: new vscode.ThemeIcon('milestone'),
					label: result.title,
					id: result.id,
					milestone: result,
				};
			});
		}

		const quickPick = vscode.window.createQuickPick();
		quickPick.busy = true;
		quickPick.canSelectMany = false;
		quickPick.title = vscode.l10n.t('Select a milestone to add');
		quickPick.buttons = [{
			iconPath: new vscode.ThemeIcon('add'),
			tooltip: 'Create',
		}];
		quickPick.onDidTriggerButton((_) => {
			quickPick.hide();

			const inputBox = vscode.window.createInputBox();
			inputBox.title = vscode.l10n.t('Create new milestone');
			inputBox.placeholder = vscode.l10n.t('New milestone title');
			if (quickPick.value !== '') {
				inputBox.value = quickPick.value;
			}
			inputBox.show();
			inputBox.onDidAccept(async () => {
				inputBox.hide();
				if (inputBox.value === '') {
					return;
				}
				if (inputBox.value.length > 255) {
					vscode.window.showErrorMessage(vscode.l10n.t(`Failed to create milestone: The title can contain a maximum of 255 characters`));
					return;
				}
				// Check if milestone already exists (only check open ones)
				for (const existingMilestone of quickPick.items) {
					if (existingMilestone.label === inputBox.value) {
						vscode.window.showErrorMessage(vscode.l10n.t('Failed to create milestone: The milestone \'{0}\' already exists', inputBox.value));
						return;
					}
				}
				try {
					const milestone = await folderRepositoryManager.createMilestone(githubRepository, inputBox.value);
					if (milestone !== undefined) {
						await callback(milestone);
					}
				} catch (e) {
					if (e.errors && Array.isArray(e.errors) && e.errors.find(error => error.code === 'already_exists') !== undefined) {
						vscode.window.showErrorMessage(vscode.l10n.t('Failed to create milestone: The milestone already exists and might be closed'));
					}
					else {
						vscode.window.showErrorMessage(`Failed to create milestone: ${formatError(e)}`);
					}
				}
			});
		});

		quickPick.show();
		quickPick.items = await getMilestoneOptions();
		quickPick.busy = false;

		quickPick.onDidAccept(async () => {
			quickPick.hide();
			const milestoneToAdd = quickPick.selectedItems[0];
			if (milestoneToAdd && isMilestoneQuickPickItem(milestoneToAdd)) {
				await callback(milestoneToAdd.milestone);
			}
		});
	} catch (e) {
		vscode.window.showErrorMessage(`Failed to add milestone: ${formatError(e)}`);
	}
}

export async function getLabelOptions(
	folderRepoManager: FolderRepositoryManager,
	labels: ILabel[],
	base: RemoteInfo
): Promise<{ newLabels: ILabel[], labelPicks: vscode.QuickPickItem[] }> {
	const newLabels = await folderRepoManager.getLabels(undefined, { owner: base.owner, repo: base.repositoryName });

	const labelPicks = newLabels.map(label => {
		return {
			label: label.name,
			description: label.description,
			picked: labels.some(existingLabel => existingLabel.name === label.name),
			iconPath: DataUri.asImageDataURI(Buffer.from(`<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
				<rect x="2" y="2" width="12" height="12" rx="6" fill="#${label.color}"/>
				</svg>`, 'utf8'))
		};
	});
	return { newLabels, labelPicks };
}