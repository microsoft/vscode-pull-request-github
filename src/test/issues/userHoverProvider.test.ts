/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { UserHoverProvider } from '../../issues/userHoverProvider';
import { MockTelemetry } from '../mocks/mockTelemetry';

describe('UserHoverProvider', function () {
	// Every test position is inside a comment. Token information isn't available in these tests.
	const originalGetTokenInformation = vscode.languages.getTokenInformationAtPosition;
	before(() => {
		(vscode.languages as any).getTokenInformationAtPosition = async (_document: vscode.TextDocument, position: vscode.Position) =>
			({ type: vscode.StandardTokenType.Comment, range: new vscode.Range(position, position) });
	});
	after(() => {
		(vscode.languages as any).getTokenInformationAtPosition = originalGetTokenInformation;
	});

	// Every name resolves to a user, as it would on GitHub for common words like "return".
	const manager = {
		getManagerForFile: () => ({
			getPullRequestDefaults: async () => ({ owner: 'microsoft', repo: 'vscode-pull-request-github', base: 'main' }),
			resolveUser: async (_owner: string, _repo: string, login: string) => ({
				login,
				name: `User ${login}`,
				url: `https://github.com/${login}`,
				avatarUrl: `https://avatars.githubusercontent.com/${login}`,
				commitContributions: [],
			}),
		}),
	} as unknown as RepositoriesManager;
	const provider = new UserHoverProvider(manager, new MockTelemetry());

	function hoverAt(languageId: string, line: string, word: string): Promise<vscode.Hover | undefined> {
		const document = {
			languageId,
			uri: vscode.Uri.parse('untitled:test'),
			lineAt: () => ({ range: new vscode.Range(0, 0, 0, line.length) }),
			getWordRangeAtPosition: (position: vscode.Position, regex: RegExp) => {
				const match = new RegExp(regex.source, 'g');
				let result: RegExpExecArray | null;
				while ((result = match.exec(line))) {
					if (result.index <= position.character && position.character <= result.index + result[0].length) {
						return new vscode.Range(position.line, result.index, position.line, result.index + result[0].length);
					}
				}
				return undefined;
			},
			getText: (range: vscode.Range) => line.substring(range.start.character, range.end.character),
		} as unknown as vscode.TextDocument;
		const position = new vscode.Position(0, line.indexOf(word) + 1);
		return provider.provideHover(document, position, new vscode.CancellationTokenSource().token);
	}

	it('does not show a user for Lua annotations', async function () {
		for (const tag of ['return', 'param', 'class', 'field', 'type']) {
			const hover = await hoverAt('lua', `---@${tag} string`, `@${tag}`);
			assert.strictEqual(hover, undefined, `@${tag}`);
		}
	});

	it('shows a user for other mentions', async function () {
		assert.ok(await hoverAt('lua', '-- thanks @octocat', '@octocat'));
		assert.ok(await hoverAt('python', '# thanks @return', '@return'));
	});
});
