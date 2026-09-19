/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { describeDiffRange, diffRangePresetTitle, diffRangeUnavailableMessage, diffRangeWarningMessage } from '../common/diffRangeLabels';
import Logger from '../common/logger';
import { dateFromNow, formatError } from '../common/utils';
import { OctokitCommon } from '../github/common';
import { ALL_CHANGES, DiffRange, DiffRangeInputs, DiffRangePreset, isUnavailableDiffRange, ResolvableDiffRangePreset, ResolvedDiffRange, resolveDiffRangePreset, shortSha } from '../github/diffRange';
import { PullRequestModel } from '../github/pullRequestModel';

const ID = 'DiffRangeQuickPick';

interface DiffRangeQuickPickItem extends vscode.QuickPickItem {
	preset?: DiffRangePreset;
	resolution?: ResolvedDiffRange;
	unavailable?: boolean;
	custom?: boolean;
}

interface CommitQuickPickItem extends vscode.QuickPickItem {
	sha?: string;
	mergeBase?: boolean;
}

const PRESET_ICONS: Record<ResolvableDiffRangePreset, string> = {
	sinceLastReview: 'git-pull-request-new-changes',
	sinceLastComment: 'comment',
	sinceEarliestUnresolvedThread: 'comment-unresolved',
};

/**
 * Shows a quick pick to choose the commit range used for the pull request's changed files.
 */
export async function selectDiffRange(pullRequest: PullRequestModel): Promise<void> {
	const headSha = pullRequest.head?.sha;
	if (!headSha) {
		vscode.window.showErrorMessage(vscode.l10n.t('The head commit of the pull request is not known yet. Try again after the pull request has loaded.'));
		return;
	}

	const quickPick = vscode.window.createQuickPick<DiffRangeQuickPickItem>();
	quickPick.title = vscode.l10n.t('Select Diff Range');
	quickPick.placeholder = vscode.l10n.t('Choose which commits to compare');
	quickPick.matchOnDescription = true;
	quickPick.busy = true;

	try {
		const accepted = new Promise<DiffRangeQuickPickItem | undefined>(resolve => {
			quickPick.onDidAccept(() => {
				const item = quickPick.selectedItems[0];
				if (!item || item.unavailable) {
					// Unavailable presets explain why they cannot be chosen; keep the picker open.
					return;
				}
				resolve(item);
			});
			quickPick.onDidHide(() => resolve(undefined));
		});
		quickPick.show();

		const [latestReview, threads, viewer, commits] = await Promise.all([
			pullRequest.getViewerLatestReviewCommit(),
			pullRequest.reviewThreadsCacheReady ? Promise.resolve(pullRequest.reviewThreadsCache) : pullRequest.initializeReviewThreadCache(),
			pullRequest.githubRepository.getAuthenticatedUser(),
			pullRequest.getCommits(),
		]);
		const inputs: DiffRangeInputs = { threads, latestReviewSha: latestReview?.sha, viewerLogin: viewer.login, commits, headSha };
		quickPick.items = createRangeItems(pullRequest.diffRange, inputs);
		const currentItem = quickPick.items.find(item => item.preset === pullRequest.diffRange.preset && !item.unavailable);
		if (currentItem) {
			quickPick.activeItems = [currentItem];
		}
		quickPick.busy = false;

		const picked = await accepted;
		if (!picked) {
			return;
		}
		quickPick.hide();

		if (picked.custom) {
			const baseSha = await pickBaseCommit(pullRequest, commits, headSha);
			if (baseSha === undefined) {
				return;
			}
			pullRequest.setDiffRange(baseSha === '' ? ALL_CHANGES : { preset: 'custom', baseSha });
		} else if (picked.preset === 'all' || !picked.resolution) {
			pullRequest.setDiffRange(ALL_CHANGES);
		} else {
			pullRequest.setDiffRange({ preset: picked.preset!, baseSha: picked.resolution.baseSha, warning: picked.resolution.warning });
		}
	} catch (e) {
		Logger.error(`Failed to select a diff range for PR #${pullRequest.number}: ${formatError(e)}`, ID);
		vscode.window.showErrorMessage(vscode.l10n.t('Unable to load the commits of the pull request: {0}', formatError(e)));
	} finally {
		quickPick.dispose();
	}
}

function createRangeItems(current: DiffRange, inputs: DiffRangeInputs): DiffRangeQuickPickItem[] {
	const currentDetail = vscode.l10n.t('Currently selected');
	const available: DiffRangeQuickPickItem[] = [{
		label: `$(git-compare) ${diffRangePresetTitle('all')}`,
		description: `${vscode.l10n.t('merge base')}..${shortSha(inputs.headSha)}`,
		detail: current.preset === 'all' ? currentDetail : undefined,
		preset: 'all',
	}];
	const unavailable: DiffRangeQuickPickItem[] = [];

	const presets: ResolvableDiffRangePreset[] = ['sinceLastReview', 'sinceLastComment', 'sinceEarliestUnresolvedThread'];
	for (const preset of presets) {
		const resolution = resolveDiffRangePreset(preset, inputs);
		if (isUnavailableDiffRange(resolution)) {
			unavailable.push({
				label: `$(circle-slash) ${diffRangePresetTitle(preset)}`,
				description: vscode.l10n.t('Unavailable: {0}', diffRangeUnavailableMessage(resolution.unavailable)),
				alwaysShow: true,
				preset,
				unavailable: true,
			});
			continue;
		}
		const details: string[] = [];
		if (current.preset === preset) {
			details.push(currentDetail);
		}
		if (resolution.anchor) {
			details.push(resolution.anchor.path
				? vscode.l10n.t('Comment on {0} {1}', resolution.anchor.path, dateFromNow(resolution.anchor.createdAt))
				: vscode.l10n.t('Comment {0}', dateFromNow(resolution.anchor.createdAt)));
		}
		if (resolution.warning) {
			details.push(`$(warning) ${diffRangeWarningMessage(resolution.warning)}`);
		}
		available.push({
			label: `$(${PRESET_ICONS[preset]}) ${diffRangePresetTitle(preset)}`,
			description: `${shortSha(resolution.baseSha)}..${shortSha(resolution.headSha)}`,
			detail: details.length ? details.join(' ') : undefined,
			preset,
			resolution,
		});
	}

	const items: DiffRangeQuickPickItem[] = [
		...available,
		{ label: '', kind: vscode.QuickPickItemKind.Separator },
		{
			label: `$(list-selection) ${diffRangePresetTitle('custom')}...`,
			description: vscode.l10n.t('Pick the base commit from the commits of the pull request'),
			detail: current.preset === 'custom' ? `${currentDetail}: ${describeDiffRange(current, current.baseSha, inputs.headSha)}` : undefined,
			custom: true,
		},
	];
	if (unavailable.length) {
		items.push({ label: vscode.l10n.t('Unavailable'), kind: vscode.QuickPickItemKind.Separator }, ...unavailable);
	}
	return items;
}

/**
 * Lets the user pick the base commit for a custom range.
 * @returns the commit sha, the empty string for the merge base, or `undefined` when cancelled.
 */
async function pickBaseCommit(pullRequest: PullRequestModel, commits: OctokitCommon.PullsListCommitsResponseData, headSha: string): Promise<string | undefined> {
	const current = pullRequest.diffRange;
	const currentDetail = vscode.l10n.t('Currently selected');
	const items: CommitQuickPickItem[] = [{
		label: `$(git-merge) ${vscode.l10n.t('Merge base')}`,
		description: vscode.l10n.t('The base branch of the pull request; shows all changes'),
		detail: current.preset === 'all' ? currentDetail : undefined,
		mergeBase: true,
	}];

	// Newest first, excluding the head since comparing it with itself shows nothing.
	for (const commit of [...commits].reverse()) {
		if (commit.sha === headSha) {
			continue;
		}
		const author = commit.author?.login ?? commit.commit.author?.name;
		const date = commit.commit.committer?.date ?? commit.commit.author?.date;
		const description = [author, date ? dateFromNow(date) : undefined].filter(part => !!part).join(', ');
		items.push({
			label: `$(git-commit) ${shortSha(commit.sha)} ${commit.commit.message.split('\n')[0]}`,
			description,
			detail: current.preset === 'custom' && current.baseSha === commit.sha ? currentDetail : undefined,
			sha: commit.sha,
		});
	}

	const picked = await vscode.window.showQuickPick(items, {
		title: vscode.l10n.t('Select Base Commit'),
		placeHolder: vscode.l10n.t('Changes are shown from the selected commit to the head of the pull request ({0})', shortSha(headSha)),
		matchOnDescription: true,
	});
	if (!picked) {
		return undefined;
	}
	return picked.mergeBase ? '' : picked.sha;
}
