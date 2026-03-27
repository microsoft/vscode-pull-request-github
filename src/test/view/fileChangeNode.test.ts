/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'assert';
import * as vscode from 'vscode';
import { clearPullRequestDiffViewStates, getPullRequestDiffViewState, storePullRequestDiffViewState } from '../../view/treeNodes/fileChangeNode';

describe('fileChangeNode diff view state', function () {
	beforeEach(function () {
		clearPullRequestDiffViewStates();
	});

	afterEach(function () {
		clearPullRequestDiffViewStates();
	});

	it('stores diff view state per original and modified uri pair', function () {
		const original = vscode.Uri.parse('review:/repo/file.ts?base=true');
		const modified = vscode.Uri.parse('review:/repo/file.ts?base=false');
		const range = new vscode.Range(10, 0, 25, 0);

		storePullRequestDiffViewState(original, modified, range);

		assert.deepStrictEqual(getPullRequestDiffViewState(original, modified), range);
		assert.strictEqual(getPullRequestDiffViewState(original, vscode.Uri.parse('review:/repo/file.ts?base=false&other=true')), undefined);
	});

	it('overwrites the saved state for the same diff pair', function () {
		const original = vscode.Uri.parse('review:/repo/file.ts?base=true');
		const modified = vscode.Uri.parse('review:/repo/file.ts?base=false');
		const firstRange = new vscode.Range(1, 0, 5, 0);
		const secondRange = new vscode.Range(20, 0, 30, 0);

		storePullRequestDiffViewState(original, modified, firstRange);
		storePullRequestDiffViewState(original, modified, secondRange);

		assert.deepStrictEqual(getPullRequestDiffViewState(original, modified), secondRange);
	});
});
