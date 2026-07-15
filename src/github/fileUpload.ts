/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as buffer from 'buffer';
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

export interface PendingFileUpload {
	name: string;
	placeholder: string;
	getBytes(): Thenable<Uint8Array>;
}

/**
 * Decode a base64 string to a {@linkcode Uint8Array}.
 */
export function decodeBase64(input: string): Uint8Array {
	return buffer.Buffer.from(input, 'base64');
}

/**
 * Guess a file extension (including the dot) for a given MIME type, falling back
 * to an empty string when no good guess is available.
 */
export function guessExtensionFromMime(mimeType: string): string {
	const lower = mimeType.toLowerCase();
	switch (lower) {
		case 'image/png': return '.png';
		case 'image/jpeg': return '.jpg';
		case 'image/gif': return '.gif';
		case 'image/webp': return '.webp';
		case 'image/svg+xml': return '.svg';
		case 'image/bmp': return '.bmp';
		case 'image/heic': return '.heic';
		case 'video/mp4': return '.mp4';
		case 'video/quicktime': return '.mov';
		case 'video/webm': return '.webm';
		case 'application/pdf': return '.pdf';
		case 'application/zip': return '.zip';
		case 'application/json': return '.json';
		case 'text/plain': return '.txt';
		case 'text/markdown': return '.md';
		default: return '';
	}
}

/**
 * Compute placeholder strings for the given file names, deduplicating
 * by name with `(2)`, `(3)` suffixes.
 */
export function placeholdersForNames(names: readonly string[]): { name: string; placeholder: string }[] {
	const used = new Map<string, number>();
	return names.map(name => {
		const count = used.get(name) ?? 0;
		used.set(name, count + 1);
		const placeholder = count === 0
			? `<!-- Uploading ${name} -->`
			: `<!-- Uploading ${name} (${count + 1}) -->`;
		return { name, placeholder };
	});
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

	const names = fileUris.map(uri => path.basename(uri.fsPath));
	const placeholders = placeholdersForNames(names);
	return fileUris.map((uri, i) => ({ uri, name: placeholders[i].name, placeholder: placeholders[i].placeholder }));
}

/**
 * Maximum number of file uploads to run in parallel. Limiting concurrency
 * avoids memory and network spikes when many files are uploaded at once.
 */
const MAX_CONCURRENT_UPLOADS = 3;

/**
 * Run the actual file uploads with limited concurrency, invoking the supplied
 * callbacks as each upload finishes (or fails).
 */
export function runFileUploads(
	githubRepository: GitHubRepository,
	uploads: readonly FileUploadPlaceholder[],
	logId: string,
	onComplete: (placeholder: string, name: string, markdown: string) => void | Promise<void>,
	onError: (placeholder: string, name: string, error: string) => void | Promise<void>,
): void {
	runPendingUploads(
		githubRepository,
		uploads.map(u => ({
			name: u.name,
			placeholder: u.placeholder,
			getBytes: () => vscode.workspace.fs.readFile(u.uri),
		})),
		logId,
		onComplete,
		onError,
	);
}

/**
 * Run uploads in parallel, fetching the bytes lazily via {@linkcode PendingFileUpload.getBytes}.
 */
export function runPendingUploads(
	githubRepository: GitHubRepository,
	uploads: readonly PendingFileUpload[],
	logId: string,
	onComplete: (placeholder: string, name: string, markdown: string) => void | Promise<void>,
	onError: (placeholder: string, name: string, error: string) => void | Promise<void>,
): void {
	let next = 0;

	const runOne = async (): Promise<void> => {
		while (next < uploads.length) {
			const u = uploads[next++];
			(async () => {
				const bytes = await u.getBytes();
				return githubRepository.uploadFileBytes(bytes, u.name);
			})().then(markdown => {
				return onComplete(u.placeholder, u.name, markdown);
			}).catch(err => {
				Logger.error(`Failed to upload file ${u.name}: ${formatError(err)}`, logId);
				return onError(u.placeholder, u.name, formatError(err));
			});
		}
	};

	const workerCount = Math.min(MAX_CONCURRENT_UPLOADS, uploads.length);
	for (let i = 0; i < workerCount; i++) {
		void runOne();
	}
}
