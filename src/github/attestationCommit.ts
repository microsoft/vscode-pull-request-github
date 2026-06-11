/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Repository } from '../api/api';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { PullRequestModel } from './pullRequestModel';
import Logger from '../common/logger';
import { ENABLE_ATTESTATION_COMMITS, PR_SETTINGS_NAMESPACE } from '../common/settingKeys';
import { formatError } from '../common/utils';

const LOG_ID = 'AttestationCommit';

const DEFAULT_ATTESTATION_COMMIT_MESSAGE = 'Attestation commit';

/**
 * Returns true when the repository has a signing key configured (via git
 * config `user.signingkey`), which is required to produce a signed commit.
 */
async function hasCommitSigningConfigured(repository: Repository): Promise<boolean> {
	const readConfig = async (key: string): Promise<string | undefined> => {
		try {
			const value = await repository.getConfig(key);
			return value?.trim() || undefined;
		} catch {
			// `getConfig` rejects when the key is not set.
			return undefined;
		}
	};

	const signingKey = await readConfig('user.signingkey');
	return !!signingKey;
}

/**
 * Reads the `githubPullRequests.enableAttestationCommits` setting.
 * Returns `false` when the feature is disabled, otherwise the commit message
 * that should be used for the attestation commit.
 */
export function getAttestationCommitSetting(): false | string {
	const value = vscode.workspace
		.getConfiguration(PR_SETTINGS_NAMESPACE)
		.get<boolean | string>(ENABLE_ATTESTATION_COMMITS, false);

	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed.length === 0) {
			return false;
		}
		return trimmed;
	}
	return value === true ? DEFAULT_ATTESTATION_COMMIT_MESSAGE : false;
}

/**
 * Whether the attestation commit feature is enabled by the user setting.
 */
export function isAttestationCommitsEnabled(): boolean {
	return getAttestationCommitSetting() !== false;
}

/**
 * Adds an empty, signed "attestation" commit to the head of the given pull request branch
 * and pushes it to the corresponding remote. Requires that the pull request is currently
 * checked out and that the user has commit signing configured.
 *
 * Returns `true` when the attestation commit was created and pushed, `false` otherwise.
 */
export async function addAttestationCommit(
	folderRepositoryManager: FolderRepositoryManager,
	pullRequestModel: PullRequestModel,
): Promise<boolean> {
	const message = getAttestationCommitSetting();
	if (message === false) {
		vscode.window.showWarningMessage(vscode.l10n.t('Attestation commits are not enabled. Enable them via the `githubPullRequests.enableAttestationCommits` setting.'));
		return false;
	}

	const activePullRequest = folderRepositoryManager.activePullRequest;
	if (!activePullRequest || !activePullRequest.equals(pullRequestModel)) {
		vscode.window.showErrorMessage(vscode.l10n.t('The pull request must be checked out before an attestation commit can be added.'));
		return false;
	}

	const repository = folderRepositoryManager.repository;
	const head = repository.state.HEAD;
	if (!head || !head.name) {
		vscode.window.showErrorMessage(vscode.l10n.t('Unable to add an attestation commit: no branch is currently checked out.'));
		return false;
	}

	if (!await hasCommitSigningConfigured(repository)) {
		vscode.window.showErrorMessage(vscode.l10n.t('Unable to add an attestation commit: commit signing is not configured. Set `user.signingkey` in your git config and ensure your signing tool (GPG, SSH, or X.509) is set up.'));
		return false;
	}

	try {
		Logger.appendLine(`Creating attestation commit on branch ${head.name} for PR #${pullRequestModel.number}`, LOG_ID);
		await repository.commit(message, {
			empty: true,
			signCommit: true,
		});

		const upstream = head.upstream;
		if (upstream) {
			await repository.push(upstream.remote, head.name);
		} else {
			await repository.push();
		}

		vscode.window.showInformationMessage(vscode.l10n.t('Added attestation commit to pull request #{0}.', pullRequestModel.number));
		return true;
	} catch (e) {
		Logger.error(`Failed to add attestation commit: ${formatError(e)}`, LOG_ID);
		vscode.window.showErrorMessage(vscode.l10n.t('Failed to add attestation commit: {0}', formatError(e)));
		return false;
	}
}
