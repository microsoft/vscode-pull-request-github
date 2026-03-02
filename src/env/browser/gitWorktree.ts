/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export async function getWorktreeForBranch(_branchName: string, _repositoryRootFsPath: string): Promise<string | undefined> {
	return undefined;
}

export async function removeWorktree(_worktreePath: string, _repositoryRootFsPath: string): Promise<void> {
	// Worktrees are not supported in browser environments
}
