/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { GitChangeType } from '../../../common/file';
import { toReviewUri } from '../../../common/uri';
import { GitFileChangeModel } from '../../../view/fileChangeModel';
import { GitFileChangeNode } from '../../../view/treeNodes/fileChangeNode';
import { TreeNodeParent } from '../../../view/treeNodes/treeNode';

function disposable(): vscode.Disposable {
	return { dispose: () => { } };
}

const rootUri = vscode.Uri.file('/root');
const commitSha = '1111111111111111111111111111111111111111';
const headSha = '2222222222222222222222222222222222222222';

describe('GitFileChangeNode', function () {
	const parent: TreeNodeParent = {
		reveal: async () => { },
		refresh: () => { },
		children: undefined,
		view: { visible: true, onDidChangeVisibility: () => disposable() } as unknown as vscode.TreeView<any>,
	} as unknown as TreeNodeParent;

	const pullRequest = {
		number: 1,
		head: { sha: headSha },
		fileChangeViewedState: {},
		reviewThreadsCache: [],
		onDidChangeReviewThreads: () => disposable(),
		onDidChangeFileViewedState: () => disposable(),
	};

	const folderRepositoryManager = {
		repository: { rootUri },
		setFileViewedContext: () => { },
	};

	/**
	 * A file node as created for a commit in the Commits tree: the paths are `review` uris carrying
	 * the sha of that commit, and the node opens a diff instead of the workspace file.
	 */
	function createCommitFileNode(fileName: string, status: GitChangeType): GitFileChangeNode {
		const uri = vscode.Uri.parse(`commit~11111111/${fileName}`);
		const changeModel = new GitFileChangeModel(
			folderRepositoryManager as any,
			pullRequest as any,
			{ status, fileName, blobUrl: undefined },
			toReviewUri(uri, fileName, undefined, commitSha, true, { base: false }, rootUri),
			toReviewUri(uri, fileName, undefined, commitSha, true, { base: true }, rootUri),
			commitSha,
		);

		const node = new GitFileChangeNode(parent, folderRepositoryManager as any, pullRequest as any, changeModel);
		node.useViewChangesCommand();
		return node;
	}

	it('diffs an added file against the head side of the change', async function () {
		// The head side has to be `filePath`. With `parentFilePath` the document is the base of the
		// diff, and commenting ranges for the base of an added file are always empty, so it isn't
		// possible to comment on a file added by the commit being viewed.
		const node = createCommitFileNode('data/added.json', GitChangeType.ADD);

		await node.resolve();

		assert.strictEqual(node.command.command, 'vscode.diff');
		const [left, right] = node.command.arguments as vscode.Uri[];
		assert.strictEqual(right.toString(), node.changeModel.filePath.toString());
		assert.notStrictEqual(right.toString(), node.changeModel.parentFilePath.toString());
		// The base side is the empty document, so the whole file reads as added.
		assert.deepStrictEqual(JSON.parse(left.query), { path: null, commit: null });
	});

	it('diffs a deleted file against the base side of the change', async function () {
		// The content of a deleted file only exists in the base, so unlike the added case the base
		// side is the one holding the document.
		const node = createCommitFileNode('data/deleted.json', GitChangeType.DELETE);

		await node.resolve();

		assert.strictEqual(node.command.command, 'vscode.diff');
		const [left, right] = node.command.arguments as vscode.Uri[];
		assert.strictEqual(left.toString(), node.changeModel.parentFilePath.toString());
		assert.deepStrictEqual(JSON.parse(right.query), { path: null, commit: null });
	});
});
