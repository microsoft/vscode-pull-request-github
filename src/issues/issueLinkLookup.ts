/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IssueModel } from '../github/issueModel';
import { RepositoriesManager } from '../github/repositoriesManager';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';

const PERMALINK = /http(s)?\:\/\/github\.com\/([^\/]+)\/([^\/]+)\/blob\/([0-9a-fA-F]{40})\/([^#]+)#L(\d+)-L(\d+)/;

function findCodeLink(issueContent: string): RegExpMatchArray | null {
	return issueContent.match(PERMALINK);
}

export function issueBodyHasLink(issueModel: IssueModel): boolean {
	return !!findCodeLink(issueModel.body);
}

export async function openCodeLink(issueModel: IssueModel, repositoriesManager: RepositoriesManager) {
	const issueLink = findCodeLink(issueModel.body);
	if (!issueLink) {
		// This would be unexpected, since the command that lands you here shouldn't be available on issues withot a link.
		return vscode.window.showInformationMessage('Issue has no link.');
	}

	const owner = issueLink[2];
	const repo = issueLink[3];
	const repoSubPath = issueLink[5];
	// subract 1 because VS Code starts lines at 0, whereas GitHub starts at 1.
	const startingLine = Number(issueLink[6]) - 1;
	const endingLine = Number(issueLink[7]) - 1;
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
		// Maybe we should open the link in the browser in this case and in other cases where we can't find the file?
		return vscode.window.showInformationMessage(`No folder open that contains ${repoSubPath}.`);
	}

	const path = vscode.Uri.joinPath(linkFolderManager.repository.rootUri, repoSubPath);
	try {
		await vscode.workspace.fs.stat(path);
	} catch (e) {
		return vscode.window.showInformationMessage(`File ${path.fsPath} does not exist.`);
	}

	const textDocument = await vscode.workspace.openTextDocument(path);
	const endingTextDocumentLine =
		textDocument.lineAt(endingLine <= textDocument.lineCount ? endingLine : textDocument.lineCount);
	const selection = new vscode.Range(startingLine, 0, endingLine, endingTextDocumentLine.text.length);
	return vscode.window.showTextDocument(path, { selection });
}
