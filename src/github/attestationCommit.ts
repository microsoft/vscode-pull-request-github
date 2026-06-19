/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { PullRequestModel } from './pullRequestModel';
import { Repository } from '../api/api';
import Logger from '../common/logger';
import { ENABLE_ATTESTATION_COMMITS, PR_SETTINGS_NAMESPACE } from '../common/settingKeys';
import { formatError } from '../common/utils';

const LOG_ID = 'AttestationCommit';

const DEFAULT_ATTESTATION_COMMIT_MESSAGE = 'Attestation commit';

/**
 * Returns true when the repository appears to have commit signing configured.
 *
 * Accepts any of the following (checked across local + global git config):
 *  - `user.signingkey` is set, OR
 *  - `commit.gpgsign` is a truthy git boolean (`true`/`1`/`yes`/`on`), OR
 *  - `gpg.format` is set to `ssh` or `x509` (the user is explicitly opting in
 *    to a non-default signing format).
 */
async function hasCommitSigningConfigured(repository: Repository): Promise<boolean> {
	const read = async (key: string): Promise<string | undefined> => {
		const tryRead = async (fn: (k: string) => Promise<string>): Promise<string | undefined> => {
			try {
				const value = await fn(key);
				return value?.trim() || undefined;
			} catch {
				// `getConfig`/`getGlobalConfig` reject when the key is not set.
				return undefined;
			}
		};
		return (await tryRead(k => repository.getConfig(k)))
			?? (await tryRead(k => repository.getGlobalConfig(k)));
	};

	const [signingKey, commitGpgSign, gpgFormat] = await Promise.all([
		read('user.signingkey'),
		read('commit.gpgsign'),
		read('gpg.format'),
	]);

	if (signingKey) {
		return true;
	}
	// `commit.gpgsign` is a git boolean: true/1/yes/on (case-insensitive) are all truthy.
	if (commitGpgSign && ['true', '1', 'yes', 'on'].includes(commitGpgSign.toLowerCase())) {
		return true;
	}
	if (gpgFormat && ['ssh', 'x509'].includes(gpgFormat.toLowerCase())) {
		return true;
	}
	return false;
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
 * Returns the SHA of the new attestation commit when successful, otherwise `undefined`.
 */
export async function addAttestationCommit(
	folderRepositoryManager: FolderRepositoryManager,
	pullRequestModel: PullRequestModel,
): Promise<string | undefined> {
	const message = getAttestationCommitSetting();
	if (message === false) {
		vscode.window.showWarningMessage(vscode.l10n.t('Attestation commits are not enabled. Enable them via the `githubPullRequests.enableAttestationCommits` setting.'));
		return undefined;
	}

	const activePullRequest = folderRepositoryManager.activePullRequest;
	if (!activePullRequest || !activePullRequest.equals(pullRequestModel)) {
		vscode.window.showErrorMessage(vscode.l10n.t('The pull request must be checked out before an attestation commit can be added.'));
		return undefined;
	}

	const repository = folderRepositoryManager.repository;
	const head = repository.state.HEAD;
	if (!head || !head.name) {
		vscode.window.showErrorMessage(vscode.l10n.t('Unable to add an attestation commit: no branch is currently checked out.'));
		return undefined;
	}

	if (!await hasCommitSigningConfigured(repository)) {
		vscode.window.showErrorMessage(vscode.l10n.t('Unable to add an attestation commit: commit signing does not appear to be configured. Set `user.signingkey` (or enable `commit.gpgsign`) in your git config and ensure your signing tool (GPG, SSH, or X.509) is set up.'));
		return undefined;
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

		return repository.state.HEAD?.commit;
	} catch (e) {
		Logger.error(`Failed to add attestation commit: ${formatError(e)}`, LOG_ID);
		vscode.window.showErrorMessage(vscode.l10n.t('Failed to add attestation commit: {0}', formatError(e)));
		return undefined;
	}
}
