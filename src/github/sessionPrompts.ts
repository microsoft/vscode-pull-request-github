/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CheckState, PullRequestCheckStatus } from './interface';
import { PullRequestModel } from './pullRequestModel';
import { DiffSide, IReviewThread, SubjectType } from '../common/comment';
import { commands } from '../common/executeCommands';
import Logger from '../common/logger';
import { formatError } from '../common/utils';

const LOG_ID = 'SessionPrompts';

type ChatAttachment = vscode.Uri | { uri: vscode.Uri; range: vscode.Range };

/**
 * Puts `query` in the chat input without sending it, so that it can be edited first, with `attachFiles` as its context.
 * In the Agents window this is the input of the active session's chat.
 */
async function prefillChatInput(query: string, attachFiles: ChatAttachment[]): Promise<void> {
	await vscode.commands.executeCommand(commands.OPEN_CHAT, { query, isPartialQuery: true, attachFiles });
}

function pullRequestReference(pullRequest: PullRequestModel): string {
	return `${pullRequest.remote.owner}/${pullRequest.remote.repositoryName}#${pullRequest.number} (${pullRequest.html_url})`;
}

function checkName(status: PullRequestCheckStatus): string {
	return status.workflowName ? `${status.workflowName} / ${status.context}` : status.context;
}

/** Logs written this long ago have long been sent with their prompt, so they can be deleted. */
const CHECK_LOGS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Deletes the logs written for fixes a day or more ago, so that they do not pile up. */
async function deleteOldCheckLogs(root: vscode.Uri): Promise<void> {
	let folders: [string, vscode.FileType][];
	try {
		folders = await vscode.workspace.fs.readDirectory(root);
	} catch {
		// No logs were written yet.
		return;
	}
	const now = Date.now();
	await Promise.all(folders.map(async ([name]) => {
		const folder = vscode.Uri.joinPath(root, name);
		try {
			if (now - (await vscode.workspace.fs.stat(folder)).mtime >= CHECK_LOGS_MAX_AGE_MS) {
				await vscode.workspace.fs.delete(folder, { recursive: true, useTrash: false });
			}
		} catch (e) {
			Logger.warn(`Failed to delete the old check logs ${name}: ${formatError(e)}`, LOG_ID);
		}
	}));
}

/**
 * Writes the logs of the failed check runs to files, which, unlike the virtual documents that show logs, chat can attach.
 * Replaces the logs written for an earlier fix of the same pull request, and deletes those of fixes a day or more ago.
 */
async function writeCheckLogs(pullRequest: PullRequestModel, failed: PullRequestCheckStatus[], storageUri: vscode.Uri): Promise<Map<PullRequestCheckStatus, vscode.Uri>> {
	const root = vscode.Uri.joinPath(storageUri, 'checkLogs');
	await deleteOldCheckLogs(root);
	// Owner names cannot contain dots, so each pull request has a folder of its own.
	const folder = vscode.Uri.joinPath(root, `${pullRequest.remote.owner}.${pullRequest.remote.repositoryName}.${pullRequest.number}`);
	try {
		await vscode.workspace.fs.delete(folder, { recursive: true, useTrash: false });
	} catch {
		// There are no earlier logs.
	}
	await vscode.workspace.fs.createDirectory(folder);

	const files = new Map<PullRequestCheckStatus, vscode.Uri>();
	await Promise.all(failed.map(async status => {
		if (!status.isCheckRun || !status.databaseId) {
			return;
		}
		try {
			const logs = await pullRequest.githubRepository.getCheckRunLogs(status.databaseId);
			const file = vscode.Uri.joinPath(folder, `${checkName(status).replace(/[^\w.-]+/g, '-')}-${status.databaseId}.log`);
			await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(logs));
			files.set(status, file);
		} catch (e) {
			Logger.error(`Failed to get the logs of check ${checkName(status)}: ${formatError(e)}`, LOG_ID);
		}
	}));
	return files;
}

/**
 * Puts a prompt to fix the failed checks of `pullRequest` in the chat input, with the logs of the failed check runs
 * attached. Returns whether there were failed checks.
 */
export async function fixChecksInSession(pullRequest: PullRequestModel, storageUri: vscode.Uri): Promise<boolean> {
	const [checks] = await pullRequest.getStatusChecks();
	const failed = checks?.statuses.filter(status => status.state === CheckState.Failure) ?? [];
	if (failed.length === 0) {
		vscode.window.showInformationMessage(vscode.l10n.t('Pull request #{0} has no failed checks.', pullRequest.number));
		return false;
	}

	const logs = await writeCheckLogs(pullRequest, failed, storageUri);
	const lines = [
		vscode.l10n.t('Fix the failed checks of pull request {0}. Find the cause of each failure, using the attached logs of the check where there are any, and fix it.', pullRequestReference(pullRequest)),
		'',
		vscode.l10n.t('Failed checks:'),
	];
	for (const status of failed) {
		const required = status.isRequired ? ` ${vscode.l10n.t('(required)')}` : '';
		lines.push(`- ${checkName(status)}${required}${status.description ? `: ${status.description}` : ''}`);
		if (status.targetUrl) {
			lines.push(`  ${vscode.l10n.t('Details: {0}', status.targetUrl)}`);
		}
		const log = logs.get(status);
		if (log) {
			lines.push(`  ${vscode.l10n.t('Logs: {0}', log.path.substring(log.path.lastIndexOf('/') + 1))}`);
		}
	}

	await prefillChatInput(lines.join('\n'), [...logs.values()]);
	return true;
}

function lineRange(start: number | undefined, end: number | undefined): string | undefined {
	if (!end) {
		return undefined;
	}
	return start && start !== end ? `${start}-${end}` : `${end}`;
}

function threadLocation(thread: IReviewThread): string {
	if (thread.subjectType === SubjectType.FILE) {
		return vscode.l10n.t('{0} (file)', thread.path);
	}
	const outdated = thread.isOutdated || !thread.endLine;
	const lines = outdated ? lineRange(thread.originalStartLine, thread.originalEndLine) : lineRange(thread.startLine, thread.endLine);
	const location = lines ? `${thread.path}:${lines}` : thread.path;
	if (outdated) {
		return vscode.l10n.t('{0} (outdated)', location);
	}
	return thread.diffSide === DiffSide.LEFT ? vscode.l10n.t('{0} (base branch)', location) : location;
}

/** The lines of the head of the pull request that a thread comments on, in `checkoutRoot`, where the pull request is checked out. */
function threadAttachment(thread: IReviewThread, checkoutRoot: vscode.Uri): ChatAttachment | undefined {
	const uri = vscode.Uri.joinPath(checkoutRoot, thread.path);
	if (thread.subjectType === SubjectType.FILE) {
		return uri;
	}
	if (thread.isOutdated || thread.diffSide !== DiffSide.RIGHT || !thread.endLine) {
		return undefined;
	}
	return { uri, range: new vscode.Range((thread.startLine || thread.endLine) - 1, 0, thread.endLine - 1, Number.MAX_SAFE_INTEGER) };
}

/**
 * Puts a prompt to address the unresolved review threads of `pullRequest` in the chat input. When the pull request is
 * checked out in `checkoutRoot`, the lines the threads comment on are attached.
 * Returns whether there were unresolved threads.
 */
export async function addressCommentsInSession(pullRequest: PullRequestModel, checkoutRoot: vscode.Uri | undefined): Promise<boolean> {
	const threads = (await pullRequest.getReviewThreads())
		.filter(thread => !thread.isResolved)
		.map(thread => ({ thread, comments: thread.comments.filter(comment => !comment.isDraft) }))
		.filter(({ comments }) => comments.length > 0);
	if (threads.length === 0) {
		vscode.window.showInformationMessage(vscode.l10n.t('Pull request #{0} has no unresolved comments.', pullRequest.number));
		return false;
	}

	const lines = [
		vscode.l10n.t('Address the unresolved review comments of pull request {0}. Make the changes they ask for, or explain why a change is not needed.', pullRequestReference(pullRequest)),
		'',
	];
	const attachFiles: ChatAttachment[] = [];
	for (const { thread, comments } of threads) {
		lines.push(`- ${threadLocation(thread)}`);
		for (const comment of comments) {
			const author = comment.user?.login ? `@${comment.user.login}` : vscode.l10n.t('Unknown author');
			const [first, ...rest] = comment.body.trim().split(/\r?\n/);
			lines.push(`  > ${author}: ${first}`, ...rest.map(line => `  > ${line}`));
		}
		lines.push(`  ${comments[0].htmlUrl}`);
		const attachment = checkoutRoot ? threadAttachment(thread, checkoutRoot) : undefined;
		if (attachment) {
			attachFiles.push(attachment);
		}
	}

	await prefillChatInput(lines.join('\n'), attachFiles);
	return true;
}
