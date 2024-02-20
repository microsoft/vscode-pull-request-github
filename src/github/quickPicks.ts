/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { Buffer } from 'buffer';
import * as vscode from 'vscode';
import { RemoteInfo } from '../../common/views';
import Logger from '../common/logger';
import { DataUri } from '../common/uri';
import { formatError } from '../common/utils';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { GitHubRepository, TeamReviewerRefreshKind } from './githubRepository';
import { IAccount, ILabel, IMilestone, IProject, isSuggestedReviewer, isTeam, ISuggestedReviewer, ITeam, reviewerId, ReviewState } from './interface';
import { PullRequestModel } from './pullRequestModel';

async function getItems<T extends IAccount | ITeam | ISuggestedReviewer>(context: vscode.ExtensionContext, skipList: Set<string>, users: T[], picked: boolean, tooManyAssignable: boolean = false): Promise<(vscode.QuickPickItem & { user?: T })[]> {
	const alreadyAssignedItems: (vscode.QuickPickItem & { user?: T })[] = [];
	// Address skip list before first await
	const filteredUsers: T[] = [];
	for (const user of users) {
		const id = reviewerId(user);
		if (!skipList.has(id)) {
			filteredUsers.push(user);
			skipList.add(id);
		}
	}

	const avatars = await DataUri.avatarCirclesAsImageDataUris(context, filteredUsers, 16, 16, tooManyAssignable);
	for (let i = 0; i < filteredUsers.length; i++) {
		const user = filteredUsers[i];

		let detail: string | undefined;
		if (isSuggestedReviewer(user)) {
			detail = user.isAuthor && user.isCommenter
				? vscode.l10n.t('Recently edited and reviewed changes to these files')
				: user.isAuthor
					? vscode.l10n.t('Recently edited these files')
					: user.isCommenter
						? vscode.l10n.t('Recently reviewed changes to these files')
						: vscode.l10n.t('Suggested reviewer');
		}

		alreadyAssignedItems.push({
			label: isTeam(user) ? `${user.org}/${user.slug}` : (user as IAccount).login,
			description: user.name,
			user,
			picked,
			detail,
			iconPath: avatars[i] ?? userThemeIcon(user)
		});
	}
	return alreadyAssignedItems;
}

export async function getAssigneesQuickPickItems(folderRepositoryManager: FolderRepositoryManager, gitHubRepository: GitHubRepository | undefined, remoteName: string, alreadyAssigned: IAccount[], item?: PullRequestModel, assignYourself?: boolean):
	Promise<(vscode.QuickPickItem & { user?: IAccount })[]> {

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
	const skipList: Set<string> = new Set();

	const assigneePromises: Promise<(vscode.QuickPickItem & { user?: IAccount })[]>[] = [];

	// Start with all currently assigned so they show at the top
	if (alreadyAssigned.length) {
		assigneePromises.push(getItems<IAccount>(folderRepositoryManager.context, skipList, alreadyAssigned ?? [], true));
	}

	// Check if the viewer is allowed to be assigned to the PR
	if (viewer && !skipList.has(viewer.login) && (assignableUsers.findIndex((assignableUser: IAccount) => assignableUser.login === viewer.login) !== -1)) {
		assigneePromises.push(getItems<IAccount>(folderRepositoryManager.context, skipList, [viewer], false));
	}

	// Suggested reviewers
	if (participants.length) {
		assigneePromises.push(getItems<IAccount>(folderRepositoryManager.context, skipList, participants, false));
	}

	if (assigneePromises.length !== 0) {
		assigneePromises.unshift(Promise.resolve([{
			kind: vscode.QuickPickItemKind.Separator,
			label: vscode.l10n.t('Suggestions')
		}]));
	}

	if (assignableUsers.length) {
		const tooManyAssignable = assignableUsers.length > 80;
		assigneePromises.push(getItems<IAccount>(folderRepositoryManager.context, skipList, assignableUsers, false, tooManyAssignable));
	}

	const assignees = (await Promise.all(assigneePromises)).flat();

	if (assignees.length === 0) {
		assignees.push({
			label: vscode.l10n.t('No assignees available for this repository')
		});
	}

	if (assignYourself) {
		const currentUser = viewer ?? await folderRepositoryManager.getCurrentUser(gitHubRepository);
		if (assignees.length !== 0) {
			assignees.unshift({ kind: vscode.QuickPickItemKind.Separator, label: vscode.l10n.t('Users') });
		}
		assignees.unshift({ label: vscode.l10n.t('Assign yourself'), user: currentUser });
	}

	return assignees;
}

function userThemeIcon(user: IAccount | ITeam) {
	return (isTeam(user) ? new vscode.ThemeIcon('organization') : new vscode.ThemeIcon('account'));
}

async function getReviewersQuickPickItems(folderRepositoryManager: FolderRepositoryManager, remoteName: string, isInOrganization: boolean, author: IAccount, existingReviewers: ReviewState[],
	suggestedReviewers: ISuggestedReviewer[] | undefined, refreshKind: TeamReviewerRefreshKind,
): Promise<(vscode.QuickPickItem & { user?: IAccount | ITeam })[]> {
	if (!suggestedReviewers) {
		return [];
	}

	const allAssignableUsers = await folderRepositoryManager.getAssignableUsers();
	const allTeamReviewers = isInOrganization ? await folderRepositoryManager.getTeamReviewers(refreshKind) : [];
	const teamReviewers: ITeam[] = allTeamReviewers[remoteName] ?? [];
	const assignableUsers: (IAccount | ITeam)[] = [...teamReviewers];
	if (allAssignableUsers[remoteName]) {
		assignableUsers.push(...allAssignableUsers[remoteName]);
	}

	// used to track logins that shouldn't be added to pick list
	// e.g. author, existing and already added reviewers
	const skipList: Set<string> = new Set([
		author.login
	]);

	const reviewersPromises: Promise<(vscode.QuickPickItem & { reviewer?: IAccount | ITeam })[]>[] = [];

	// Start with all existing reviewers so they show at the top
	if (existingReviewers.length) {
		reviewersPromises.push(getItems<IAccount | ITeam>(folderRepositoryManager.context, skipList, existingReviewers.map(reviewer => reviewer.reviewer), true));
	}

	// Suggested reviewers
	reviewersPromises.push(getItems<ISuggestedReviewer>(folderRepositoryManager.context, skipList, suggestedReviewers, false));

	const tooManyAssignable = assignableUsers.length > 60;
	reviewersPromises.push(getItems<IAccount | ITeam>(folderRepositoryManager.context, skipList, assignableUsers, false, tooManyAssignable));

	const reviewers = (await Promise.all(reviewersPromises)).flat();

	if (reviewers.length === 0) {
		reviewers.push({
			label: vscode.l10n.t('No reviewers available for this repository')
		});
	}

	return reviewers;
}

export async function reviewersQuickPick(folderRepositoryManager: FolderRepositoryManager, remoteName: string, isInOrganization: boolean, teamsCount: number, author: IAccount, existingReviewers: ReviewState[],
	suggestedReviewers: ISuggestedReviewer[] | undefined): Promise<vscode.QuickPick<vscode.QuickPickItem & {
		user?: IAccount | ITeam | undefined;
	}>> {
	const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { user?: IAccount | ITeam }>();
	// The quick-max is used to show the "update reviewers" button. If the number of teams is less than the quick-max, then they'll be automatically updated when the quick pick is opened.
	const quickMaxTeamReviewers = 100;
	const defaultPlaceholder = vscode.l10n.t('Add reviewers');
	quickPick.busy = true;
	quickPick.canSelectMany = true;
	quickPick.matchOnDescription = true;
	quickPick.placeholder = defaultPlaceholder;
	if (isInOrganization) {
		quickPick.buttons = [{ iconPath: new vscode.ThemeIcon('organization'), tooltip: vscode.l10n.t('Show or refresh team reviewers') }];
	}
	quickPick.show();
	const updateItems = async (refreshKind: TeamReviewerRefreshKind) => {
		const slowWarning = setTimeout(() => {
			quickPick.placeholder = vscode.l10n.t('Getting team reviewers can take several minutes. Results will be cached.');
		}, 3000);
		const start = performance.now();
		quickPick.items = await getReviewersQuickPickItems(folderRepositoryManager, remoteName, isInOrganization, author, existingReviewers, suggestedReviewers, refreshKind);
		Logger.appendLine(`Setting quick pick reviewers took ${performance.now() - start}ms`, 'QuickPicks');
		clearTimeout(slowWarning);
		quickPick.selectedItems = quickPick.items.filter(item => item.picked);
		quickPick.placeholder = defaultPlaceholder;
	};

	await updateItems((teamsCount !== 0 && teamsCount <= quickMaxTeamReviewers) ? TeamReviewerRefreshKind.Try : TeamReviewerRefreshKind.None);
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

type ProjectQuickPickItem = vscode.QuickPickItem & { id: string; project: IProject };

function isProjectQuickPickItem(x: vscode.QuickPickItem | ProjectQuickPickItem): x is ProjectQuickPickItem {
	return !!(x as ProjectQuickPickItem).id && !!(x as ProjectQuickPickItem).project;
}

export async function getProjectFromQuickPick(folderRepoManager: FolderRepositoryManager, githubRepository: GitHubRepository, currentProjects: IProject[] | undefined, callback: (projects: IProject[]) => Promise<void>): Promise<void> {
	try {
		let selectedItems: vscode.QuickPickItem[] = [];
		async function getProjectOptions(): Promise<(ProjectQuickPickItem | vscode.QuickPickItem)[]> {
			const projects = await folderRepoManager.getAllProjects(githubRepository);
			if (!projects || !projects.length) {
				return [
					{
						label: vscode.l10n.t('No projects created for this repository.'),
					},
				];
			}

			const projectItems: (ProjectQuickPickItem | vscode.QuickPickItem)[] = projects.map(result => {
				const item = {
					iconPath: new vscode.ThemeIcon('github-project'),
					label: result.title,
					id: result.id,
					project: result
				};
				if (currentProjects && currentProjects.find(project => project.id === result.id)) {
					selectedItems.push(item);
				}
				return item;
			});
			return projectItems;
		}

		const quickPick = vscode.window.createQuickPick();
		quickPick.busy = true;
		quickPick.canSelectMany = true;
		quickPick.title = vscode.l10n.t('Set projects');
		quickPick.show();
		quickPick.items = await getProjectOptions();
		quickPick.selectedItems = selectedItems;
		quickPick.busy = false;

		// Kick off a cache refresh
		folderRepoManager.getOrgProjects(true);
		quickPick.onDidAccept(async () => {
			quickPick.hide();
			const projectsToAdd = quickPick.selectedItems.map(item => isProjectQuickPickItem(item) ? item.project : undefined).filter(project => project !== undefined) as IProject[];
			if (projectsToAdd) {
				await callback(projectsToAdd);
			}
		});
	} catch (e) {
		vscode.window.showErrorMessage(`Failed to add project: ${formatError(e)}`);
	}
}

type MilestoneQuickPickItem = vscode.QuickPickItem & { id: string; milestone: IMilestone };

function isMilestoneQuickPickItem(x: vscode.QuickPickItem | MilestoneQuickPickItem): x is MilestoneQuickPickItem {
	return !!(x as MilestoneQuickPickItem).id && !!(x as MilestoneQuickPickItem).milestone;
}

export async function getMilestoneFromQuickPick(folderRepositoryManager: FolderRepositoryManager, githubRepository: GitHubRepository, currentMilestone: IMilestone | undefined, callback: (milestone: IMilestone | undefined) => Promise<void>): Promise<void> {
	try {
		const removeMilestoneItem: vscode.QuickPickItem = {
			label: vscode.l10n.t('Remove Milestone')
		};
		let selectedItem: vscode.QuickPickItem | undefined;
		async function getMilestoneOptions(): Promise<(MilestoneQuickPickItem | vscode.QuickPickItem)[]> {
			const milestones = await githubRepository.getMilestones();
			if (!milestones || !milestones.length) {
				return [
					{
						label: vscode.l10n.t('No milestones created for this repository.'),
					},
				];
			}

			const milestonesItems: (MilestoneQuickPickItem | vscode.QuickPickItem)[] = milestones.map(result => {
				const item = {
					iconPath: new vscode.ThemeIcon('milestone'),
					label: result.title,
					id: result.id,
					milestone: result
				};
				if (currentMilestone && currentMilestone.id === result.id) {
					selectedItem = item;
				}
				return item;
			});
			if (currentMilestone) {
				milestonesItems.unshift({ label: 'Milestones', kind: vscode.QuickPickItemKind.Separator });
				milestonesItems.unshift(removeMilestoneItem);
			}
			return milestonesItems;
		}

		const quickPick = vscode.window.createQuickPick();
		quickPick.busy = true;
		quickPick.canSelectMany = false;
		quickPick.title = vscode.l10n.t('Set milestone');
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
		quickPick.activeItems = selectedItem ? [selectedItem] : (currentMilestone ? [quickPick.items[1]] : [quickPick.items[0]]);
		quickPick.busy = false;

		quickPick.onDidAccept(async () => {
			quickPick.hide();
			const milestoneToAdd = quickPick.selectedItems[0];
			if (milestoneToAdd && isMilestoneQuickPickItem(milestoneToAdd)) {
				await callback(milestoneToAdd.milestone);
			} else if (milestoneToAdd && milestoneToAdd === removeMilestoneItem) {
				await callback(undefined);
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

export async function pickEmail(githubRepository: GitHubRepository, current: string): Promise<string | undefined> {
	async function getEmails(): Promise<(vscode.QuickPickItem)[]> {
		const emails = await githubRepository.getAuthenticatedUserEmails();
		return emails.map(email => {
			return {
				label: email,
				picked: email.toLowerCase() === current.toLowerCase()
			};
		});
	}

	const result = await vscode.window.showQuickPick(getEmails(), { canPickMany: false, title: vscode.l10n.t('Choose an email') });
	return result ? result.label : undefined;
}