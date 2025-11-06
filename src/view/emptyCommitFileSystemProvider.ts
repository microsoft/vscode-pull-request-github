/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ReadonlyFileSystemProvider } from './readonlyFileSystemProvider';

/**
 * File system provider for displaying empty commits.
 * This provides a simple file that explains when a commit has no content.
 */
export class EmptyCommitFileSystemProvider extends ReadonlyFileSystemProvider {
	async readFile(_uri: vscode.Uri): Promise<Uint8Array> {
		const message = vscode.l10n.t('No changes to show.\nThis commit has no content.');
		return new TextEncoder().encode(message);
	}
}
