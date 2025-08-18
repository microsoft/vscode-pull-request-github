/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Repository } from '../api/api';
import { GitApiImpl } from '../api/api1';

/**
 * Determines if a repository is a submodule by checking if its path
 * appears in any other repository's submodules list.
 */
export function isSubmodule(repo: Repository, git: GitApiImpl): boolean {
	const repoPath = repo.rootUri.fsPath;

	// Check all other repositories to see if this repo is listed as a submodule
	for (const otherRepo of git.repositories) {
		if (otherRepo.rootUri.toString() === repo.rootUri.toString()) {
			continue; // Skip self
		}

		// Check if this repo's path appears in the other repo's submodules
		for (const submodule of otherRepo.state.submodules) {
			// The submodule path is relative to the parent repo, so we need to resolve it
			const submodulePath = vscode.Uri.joinPath(otherRepo.rootUri, submodule.path).fsPath;
			if (submodulePath === repoPath) {
				return true;
			}
		}
	}

	return false;
}