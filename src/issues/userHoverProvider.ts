/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ITelemetry } from '../common/telemetry';
import { RepositoriesManager } from '../github/repositoriesManager';
import { shouldShowHover, USER_EXPRESSION, userMarkdown } from './util';


// https://jsdoc.app/index.html
const JSDOC_NON_USERS = ['abstract', 'access', 'alias', 'async', 'augments', 'author', 'borrows', 'callback', 'class', 'classdesc', 'constant', 'constructs', 'copyright', 'default', 'deprecated', 'description', 'enum', 'event', 'example', 'exports', 'external', 'host', 'file', 'fires', 'function', 'generator', 'global', 'hideconstructor', 'ignore', 'implements', 'inheritdoc', 'inner', 'instance', 'interface', 'kind', 'lends', 'license', 'listens', 'member', 'memberof', 'mixes', 'mixin', 'module', 'name', 'namespace', 'override', 'package', 'param', 'private', 'property', 'protected', 'public', 'readonly', 'requires', 'returns', 'see', 'since', 'static', 'summary', 'this', 'throws', 'exception', 'todo', 'tutorial', 'type', 'typedef', 'variation', 'version', 'yields', 'yield', 'link'];

export class UserHoverProvider implements vscode.HoverProvider {
	constructor(private manager: RepositoriesManager, private telemetry: ITelemetry) {}

	async provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
	): Promise<vscode.Hover | undefined> {
		if (!(await shouldShowHover(document, position))) {
			return;
		}

		let wordPosition = document.getWordRangeAtPosition(position, USER_EXPRESSION);
		if (wordPosition && wordPosition.start.character > 0) {
			wordPosition = new vscode.Range(
				new vscode.Position(wordPosition.start.line, wordPosition.start.character),
				wordPosition.end,
			);
			const word = document.getText(wordPosition);
			const match = word.match(USER_EXPRESSION);
			if (match) {
				const username = match[1];
				// JS and TS doc checks
				if (((document.languageId === 'javascript') || (document.languageId === 'typescript'))
					&& JSDOC_NON_USERS.indexOf(username) >= 0) {
					return;
				}
				return this.createHover(document.uri, username, wordPosition);
			}
		} else {
			return;
		}
	}

	private async createHover(
		uri: vscode.Uri,
		username: string,
		range: vscode.Range,
	): Promise<vscode.Hover | undefined> {
		try {
			const folderManager = this.manager.getManagerForFile(uri);
			if (!folderManager) {
				return;
			}
			const origin = await folderManager.getPullRequestDefaults();
			const user = await folderManager.resolveUser(origin.owner, origin.repo, username);
			if (user && user.name) {
				/* __GDPR__
					"issue.userHover" : {}
				*/
				this.telemetry.sendTelemetryEvent('issues.userHover');
				return new vscode.Hover(userMarkdown(origin, user), range);
			} else {
				return;
			}
		} catch (e) {
			// No need to notify about a hover that doesn't work
			return;
		}
	}
}
