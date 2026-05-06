/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { GitHubRepository } from './githubRepository';
import Logger from '../common/logger';
import { formatError } from '../common/utils';

export interface FileUploadPlaceholder {
	uri: vscode.Uri;
	name: string;
	placeholder: string;
}

/**
 * Prompt the user for files to upload and compute the placeholder text that
 * should be inserted into a comment textarea while the uploads run.
 * Returns `undefined` when the user cancels.
 */
export async function pickFilesForUpload(): Promise<FileUploadPlaceholder[] | undefined> {
	const fileUris = await vscode.window.showOpenDialog({
		canSelectMany: true,
		canSelectFiles: true,
		canSelectFolders: false,
		openLabel: vscode.l10n.t('Upload'),
		title: vscode.l10n.t('Select files to upload'),
	});
	if (!fileUris || fileUris.length === 0) {
		return undefined;
	}

	const used = new Map<string, number>();
	return fileUris.map(uri => {
		const baseName = path.basename(uri.fsPath);
		const count = used.get(baseName) ?? 0;
		used.set(baseName, count + 1);
		const placeholder = count === 0
			? `<!-- Uploading ${baseName} -->`
			: `<!-- Uploading ${baseName} (${count + 1}) -->`;
		return { uri, name: baseName, placeholder };
	});
}

/**
 * Run the actual file uploads in parallel, invoking the supplied callbacks as
 * each upload finishes (or fails).
 */
export function runFileUploads(
	githubRepository: GitHubRepository,
	uploads: FileUploadPlaceholder[],
	logId: string,
	onComplete: (placeholder: string, name: string, markdown: string) => void | Promise<void>,
	onError: (placeholder: string, name: string, error: string) => void | Promise<void>,
): void {
	for (const u of uploads) {
		githubRepository.uploadFile(u.uri, u.name).then(markdown => {
			return onComplete(u.placeholder, u.name, markdown);
		}).catch(err => {
			Logger.error(`Failed to upload file ${u.name}: ${formatError(err)}`, logId);
			return onError(u.placeholder, u.name, formatError(err));
		});
	}
}
