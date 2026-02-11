/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Logger from '../common/logger';
import { Schemes } from '../common/uri';
import { RepositoriesManager } from '../github/repositoriesManager';

interface CheckRunLogParams {
	owner: string;
	repo: string;
	checkRunDatabaseId: number;
	checkName: string;
}

export function toCheckRunLogUri(params: CheckRunLogParams): vscode.Uri {
	return vscode.Uri.from({
		scheme: Schemes.CheckRunLog,
		path: `/${params.owner}/${params.repo}/${params.checkName}.log`,
		query: JSON.stringify(params),
	});
}

function fromCheckRunLogUri(uri: vscode.Uri): CheckRunLogParams | undefined {
	if (uri.scheme !== Schemes.CheckRunLog) {
		return undefined;
	}
	try {
		return JSON.parse(uri.query);
	} catch {
		return undefined;
	}
}

export class CheckRunLogContentProvider implements vscode.TextDocumentContentProvider {
	constructor(private readonly _reposManager: RepositoriesManager) { }

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const params = fromCheckRunLogUri(uri);
		if (!params) {
			return '';
		}

		for (const folderManager of this._reposManager.folderManagers) {
			const repo = folderManager.findRepo(r =>
				r.remote.owner === params.owner && r.remote.repositoryName === params.repo
			);
			if (repo) {
				try {
					return await repo.getCheckRunLogs(params.checkRunDatabaseId);
				} catch (e) {
					Logger.error(`Failed to fetch check run logs: ${e}`, 'CheckRunLog');
					return `Failed to fetch check run logs: ${e}`;
				}
			}
		}

		Logger.error(`No repository found for ${params.owner}/${params.repo}`, 'CheckRunLog');
		return `Unable to fetch logs: repository ${params.owner}/${params.repo} not found.`;
	}
}
