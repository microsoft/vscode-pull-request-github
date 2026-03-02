/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as nodePath from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

export async function getWorktreeForBranch(branchName: string, repositoryRootFsPath: string): Promise<string | undefined> {
	const gitPath = vscode.workspace.getConfiguration('git').get<string>('path') || 'git';
	const { stdout } = await execFileAsync(gitPath, ['worktree', 'list', '--porcelain'], {
		cwd: repositoryRootFsPath,
	});

	const worktrees = stdout.split('\n\n');
	for (const entry of worktrees) {
		const lines = entry.trim().split('\n');
		let worktreePath: string | undefined;
		let branch: string | undefined;
		for (const line of lines) {
			if (line.startsWith('worktree ')) {
				worktreePath = line.substring('worktree '.length);
			} else if (line.startsWith('branch ')) {
				branch = line.substring('branch '.length);
				// branch line is like "branch refs/heads/branchName"
				const prefix = 'refs/heads/';
				if (branch.startsWith(prefix)) {
					branch = branch.substring(prefix.length);
				}
			}
		}
		if (branch === branchName && worktreePath) {
			// Don't return the main worktree (the repository root itself)
			if (nodePath.resolve(worktreePath) !== nodePath.resolve(repositoryRootFsPath)) {
				return worktreePath;
			}
		}
	}
	return undefined;
}

export async function removeWorktree(worktreePath: string, repositoryRootFsPath: string): Promise<void> {
	const gitPath = vscode.workspace.getConfiguration('git').get<string>('path') || 'git';
	await execFileAsync(gitPath, ['worktree', 'remove', worktreePath], {
		cwd: repositoryRootFsPath,
	});
}
