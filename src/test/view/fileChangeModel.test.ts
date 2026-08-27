/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox } from 'sinon';
import * as vscode from 'vscode';
import { GitChangeType, InMemFileChange } from '../../common/file';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { PullRequestModel } from '../../github/pullRequestModel';
import { GitFileChangeModel } from '../../view/fileChangeModel';
import { MockRepository } from '../mocks/mockRepository';

describe('GitFileChangeModel', function () {
	let sinon: SinonSandbox;

	beforeEach(function () {
		sinon = createSandbox();
	});

	afterEach(function () {
		sinon.restore();
	});

	it('loads base content from the previous filename for a rename', async function () {
		const repository = new MockRepository();
		const baseCommit = 'base';
		const fileName = 'src/b/thing.py';
		const previousFileName = 'src/a/thing.py';
		const baseContent = 'print("unchanged")';
		const show = sinon.stub(repository, 'show').resolves(baseContent);
		const change = new InMemFileChange(
			baseCommit,
			GitChangeType.RENAME,
			fileName,
			previousFileName,
			'',
			[],
			'https://example.com/thing.py',
		);
		const model = new GitFileChangeModel(
			{ repository } as unknown as FolderRepositoryManager,
			{} as PullRequestModel,
			change,
			vscode.Uri.joinPath(repository.rootUri, fileName),
			vscode.Uri.joinPath(repository.rootUri, previousFileName),
			'head',
		);

		assert.strictEqual(await model.showBase(), baseContent);
		assert.strictEqual(show.calledOnceWithExactly(
			baseCommit,
			vscode.Uri.joinPath(repository.rootUri, previousFileName).fsPath,
		), true);
	});
});
