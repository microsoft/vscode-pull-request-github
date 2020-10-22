/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IssueModel } from '../github/issueModel';
import { RepositoriesManager } from '../github/repositoriesManager';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';

export const CODE_PERMALINK = /http(s)?\:\/\/github\.com\/([^\/]+)\/([^\/]+)\/blob\/([0-9a-fA-F]{40})\/([^#]+)#L(\d+)(-L(\d+))?/;

function findCodeLink(issueContent: string): RegExpMatchArray | null {
	return issueContent.match(CODE_PERMALINK);
}

export function issueBodyHasLink(issueModel: IssueModel): boolean {
	return !!findCodeLink(issueModel.body);
}

interface CodeLink {
	file: vscode.Uri;
	start: number;
	end: number;
}

export async function findCodeLinkLocally(codeLink: RegExpMatchArray, repositoriesManager: RepositoriesManager,
	silent: boolean = true): Promise<CodeLink | undefined> {

	const owner = codeLink[2];
	const repo = codeLink[3];
	const repoSubPath = codeLink[5];
	// subract 1 because VS Code starts lines at 0, whereas GitHub starts at 1.
	const startingLine = Number(codeLink[6]) - 1;
	const endingLine = codeLink[8] ? Number(codeLink[8]) - 1 : startingLine;
	let linkFolderManager: FolderRepositoryManager | undefined;

	for (const folderManager of repositoriesManager.folderManagers) {
		const remotes = folderManager.getGitHubRemotes();
		for (const remote of remotes) {
			if (owner.toLowerCase() === remote.owner.toLowerCase() &&
				repo.toLowerCase() === remote.repositoryName.toLowerCase()) {
				linkFolderManager = folderManager;
				break;
			}
		}
		if (linkFolderManager) {
			break;
		}
	}

	if (!linkFolderManager) {
		return;
	}

	const path = vscode.Uri.joinPath(linkFolderManager.repository.rootUri, repoSubPath);
	try {
		await vscode.workspace.fs.stat(path);
	} catch (e) {
		return;
	}
	return {
		file: path,
		start: startingLine,
		end: endingLine
	};
}

export async function openCodeLink(issueModel: IssueModel, repositoriesManager: RepositoriesManager) {
	const issueLink = findCodeLink(issueModel.body);
	if (!issueLink) {
		vscode.window.showInformationMessage('Issue has no link.');
		return;
	}
	const codeLink = await findCodeLinkLocally(issueLink, repositoriesManager, false);
	if (!codeLink) {
		return vscode.env.openExternal(vscode.Uri.parse(issueLink[0]));
	}
	const textDocument = await vscode.workspace.openTextDocument(codeLink?.file);
	const endingTextDocumentLine =
		textDocument.lineAt(codeLink.end < textDocument.lineCount ? codeLink.end : textDocument.lineCount - 1);
	const selection = new vscode.Range(codeLink.start, 0, codeLink.end, endingTextDocumentLine.text.length);
	return vscode.window.showTextDocument(codeLink.file, { selection });
}
