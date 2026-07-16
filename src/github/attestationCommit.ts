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
import { CommitEvent, EventType } from '../common/timelineEvent';
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
 * Returns the SHA of the new attestation commit plus a synthetic `CommitEvent` that
 * callers can splice into the timeline (avoiding an extra `getTimelineEvents` round-trip
 * to GitHub) when successful, otherwise `undefined`.
 */
export async function addAttestationCommit(
	folderRepositoryManager: FolderRepositoryManager,
	pullRequestModel: PullRequestModel,
): Promise<{ sha: string; event: CommitEvent } | undefined> {
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

	const originalSha = head.commit;
	try {
		Logger.appendLine(`Creating attestation commit on branch ${head.name} for PR #${pullRequestModel.number}`, LOG_ID);
		await repository.commit(message, {
			empty: true,
			signCommit: true,
			noVerify: true,
		});

		try {
			const upstream = head.upstream;
			if (upstream) {
				// When the local branch name differs from its upstream (e.g. a
				// checked-out PR branch `pr/<owner>/<n>` tracking `their/branch`
				// on the fork), pass an explicit `<local>:<remote>` refspec so
				// git pushes to the tracked branch instead of trying to create
				// a new remote branch named after the local ref.
				const refspec = head.name && head.name !== upstream.name
					? `${head.name}:${upstream.name}`
					: head.name;
				await repository.push(upstream.remote, refspec);
			} else {
				await repository.push();
			}
		} catch (pushError) {
			// Push failed (e.g. no write access to a fork). Rewind the local
			// commit so the branch doesn't diverge from the remote.
			await rewindLocalCommit(repository, originalSha);
			const errText = formatError(pushError);
			const isPermissionDenied = /permission denied|forbidden|403|401/i.test(errText);
			const detail = isPermissionDenied
				? vscode.l10n.t('You do not have push access to the pull request branch (`{0}:{1}`). The local attestation commit was rewound.', pullRequestModel.head?.repositoryCloneUrl.owner ?? '', pullRequestModel.head?.ref ?? '')
				: vscode.l10n.t('Failed to push the attestation commit: {0}. The local commit was rewound.', errText);
			Logger.error(`Attestation commit push failed: ${errText}`, LOG_ID);
			vscode.window.showErrorMessage(detail);
			return undefined;
		}

		const sha = repository.state.HEAD?.commit;
		if (!sha) {
			return undefined;
		}

		const currentUser = await folderRepositoryManager.getCurrentUser(pullRequestModel.githubRepository);
		// Derive the commit URL from the PR's html_url (e.g. `.../pull/123` -> `.../commit/<sha>`).
		const commitHtmlUrl = pullRequestModel.html_url.replace(/\/pull\/\d+.*$/, `/commit/${sha}`);
		const event: CommitEvent = {
			id: sha,
			sha,
			event: EventType.Committed,
			author: currentUser,
			htmlUrl: commitHtmlUrl,
			message,
			committedDate: new Date(),
		};
		return { sha, event };
	} catch (e) {
		Logger.error(`Failed to add attestation commit: ${formatError(e)}`, LOG_ID);
		vscode.window.showErrorMessage(vscode.l10n.t('Failed to add attestation commit: {0}', formatError(e)));
		return undefined;
	}
}

/**
 * Best-effort rewind of the just-created (empty) attestation commit when we
 * fail to push it. Uses the VS Code git extension's internal `_repository.reset`
 * when available so the branch pointer moves back to `originalSha` without
 * leaving a divergent local state.
 */
async function rewindLocalCommit(repository: Repository, originalSha: string | undefined): Promise<void> {
	if (!originalSha) {
		return;
	}
	try {
		const internal = (repository as unknown as { _repository?: { reset?: (treeish: string, hard?: boolean) => Promise<void> } })._repository;
		if (internal?.reset) {
			await internal.reset(originalSha, true);
			await repository.status();
		} else {
			Logger.warn(`Cannot rewind attestation commit: internal reset API not available. Run 'git reset --hard ${originalSha}' to clean up.`, LOG_ID);
		}
	} catch (e) {
		Logger.error(`Failed to rewind attestation commit: ${formatError(e)}. Run 'git reset --hard ${originalSha}' to clean up.`, LOG_ID);
	}
}
