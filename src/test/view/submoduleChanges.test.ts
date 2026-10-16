/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import * as vscode from 'vscode';
import { parseDiff } from '../../common/diffHunk';
import { InMemFileChange } from '../../common/file';
import { fromPRUri, toReviewUri } from '../../common/uri';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { IRawFileChange } from '../../github/interface';
import { IResolvedPullRequestModel, PullRequestModel } from '../../github/pullRequestModel';
import { FileChangeModel, GitFileChangeModel, InMemFileChangeModel } from '../../view/fileChangeModel';
import { InMemPRFileSystemProvider, provideDocumentContentForChangeModel } from '../../view/inMemPRContentProvider';
import { GitFileChangeNode, InMemFileChangeNode } from '../../view/treeNodes/fileChangeNode';
import { BaseTreeNode } from '../../view/treeNodes/treeNode';
import { MockRepository } from '../mocks/mockRepository';

describe('Submodule changes', function () {
	const oldPointer = `Subproject commit ${'a'.repeat(40)}`;
	const newPointer = `Subproject commit ${'b'.repeat(40)}`;
	const bumpPatch = `@@ -1 +1 @@\n-${oldPointer}\n+${newPointer}`;
	const parent: BaseTreeNode = {
		reveal: async () => { },
		refresh: () => { },
		children: undefined,
		view: {} as vscode.TreeView<any>,
	};
	let sandbox: SinonSandbox;
	let repository: MockRepository;
	let folderManager: FolderRepositoryManager;
	let pr: PullRequestModel & IResolvedPullRequestModel;
	let show: SinonStub;
	let getObjectDetails: SinonStub;
	let getFile: SinonStub;
	let events: vscode.EventEmitter<any>;

	beforeEach(function () {
		sandbox = createSandbox();
		repository = new MockRepository();
		repository.rootUri = vscode.Uri.parse('vscode-remote://ssh-remote+host/workspace');
		show = sandbox.stub(repository, 'show').rejects(new Error('Could not show object'));
		getObjectDetails = sandbox.stub(repository, 'getObjectDetails').rejects(new Error('Missing submodule object'));
		getFile = sandbox.stub().rejects(new Error('Not a blob'));
		events = new vscode.EventEmitter();
		pr = {
			number: 1,
			head: { sha: 'head' },
			base: { sha: 'base' },
			mergeBase: 'base',
			githubRepository: { remote: { remoteName: 'origin' }, getFile },
			fileChanges: new Map(),
			fileChangeViewedState: {},
			reviewThreadsCache: [],
			onDidChangeReviewThreads: events.event,
			onDidChangeFileViewedState: events.event,
			equals: other => other === pr,
		} as unknown as PullRequestModel & IResolvedPullRequestModel;
		folderManager = {
			repository,
			activePullRequest: pr,
			setFileViewedContext: () => { },
			telemetry: { sendTelemetryEvent: () => { } },
		} as unknown as FolderRepositoryManager;
	});

	afterEach(function () {
		events.dispose();
		sandbox.restore();
	});

	async function parseChange(status = 'modified', patch = bumpPatch): Promise<InMemFileChange> {
		const [change] = await parseDiff([{
			filename: 'modules/dependency',
			previous_filename: status === 'renamed' ? 'old/dependency' : undefined,
			status,
			patch,
			additions: status === 'removed' ? 0 : 1,
			deletions: status === 'added' ? 0 : 1,
			blob_url: 'https://github.com/owner/repo',
		} as IRawFileChange], 'base');
		assert(change instanceof InMemFileChange);
		return change;
	}

	function localModel(change: InMemFileChange): GitFileChangeModel {
		const uri = vscode.Uri.joinPath(repository.rootUri, change.fileName);
		return new GitFileChangeModel(
			folderManager, pr, change, uri,
			toReviewUri(uri, change.previousFileName ?? change.fileName, undefined, 'base', false, { base: true }, repository.rootUri),
			'head',
		);
	}

	async function assertPointerDocuments(model: FileChangeModel, base: string, head: string) {
		const provider = new InMemPRFileSystemProvider(undefined!, undefined!, undefined!);
		const registration = provider.registerTextDocumentContentProvider(pr.number, uri =>
			provideDocumentContentForChangeModel(folderManager, pr, fromPRUri(uri)!, model));
		try {
			for (const [uri, expected, isBase] of [
				[model.parentFilePath, base, true],
				[model.filePath, head, false],
			] as const) {
				assert.strictEqual(uri.scheme, 'pr');
				assert.strictEqual(uri.authority, repository.rootUri.authority);
				const params = fromPRUri(uri)!;
				assert.strictEqual(params.isBase, isBase);
				assert.strictEqual(params.baseCommit, 'base');
				assert.strictEqual(params.headCommit, 'head');
				assert.strictEqual(params.fileName, model.fileName);
				assert.strictEqual(params.submoduleContent, expected);
				assert.strictEqual(new TextDecoder().decode(await provider.readFile(uri)), expected);
				assert.strictEqual(await provideDocumentContentForChangeModel(folderManager, pr, params, model), expected);
			}
			assert.strictEqual(show.called, false);
			assert.strictEqual(getObjectDetails.called, false);
			assert.strictEqual(getFile.called, false);
		} finally {
			registration.dispose();
		}
	}

	for (const [status, patch, base, head] of [
		['modified', bumpPatch, `${oldPointer}\n`, `${newPointer}\n`],
		['added', `@@ -0,0 +1 @@\n+${newPointer}`, '', `${newPointer}\n`],
		['removed', `@@ -1 +0,0 @@\n-${oldPointer}`, `${oldPointer}\n`, ''],
		['renamed', bumpPatch, `${oldPointer}\n`, `${newPointer}\n`],
	]) {
		it(`opens a ${status} submodule from the checked-out PR tree as a pointer diff`, async function () {
			const model = localModel(await parseChange(status, patch));
			const node = new GitFileChangeNode(parent, folderManager, pr, model);
			const configuration = vscode.workspace.getConfiguration('git', repository.rootUri);
			sandbox.stub(vscode.workspace, 'getConfiguration').callThrough()
				.withArgs('git', repository.rootUri).returns({
					...configuration,
					get: () => false,
				});
			try {
				await node.resolve();
				assert.strictEqual(node.command.command, 'vscode.diff');
				assert.strictEqual((node.openFileCommand().arguments![0] as vscode.Uri).scheme, 'pr');
				assert.strictEqual(await model.showBase(), base);
				await assertPointerDocuments(model, base, head);
			} finally {
				node.dispose();
			}
		});

		for (const isCurrentPR of [true, false]) {
			it(`reads a ${status} submodule for a ${isCurrentPR ? 'current' : 'remote'} PR without fetching blobs`, async function () {
				const model = new InMemFileChangeModel(folderManager, pr, await parseChange(status, patch), isCurrentPR, 'base');
				const node = new InMemFileChangeNode(folderManager, parent, pr, model);
				try {
					await node.resolve();
					assert.strictEqual(node.command.command, 'vscode.diff');
					await assertPointerDocuments(model, base, head);
				} finally {
					node.dispose();
				}
			});
		}
	}

	it('opens pointer documents from the PR description Changes view', async function () {
		const change = await parseChange();
		pr.fileChanges.set(change.fileName, change);
		const executeCommand = sandbox.stub(vscode.commands, 'executeCommand').resolves();
		await PullRequestModel.openChanges(folderManager, pr);
		const [command, , entries] = executeCommand.firstCall.args;
		assert.strictEqual(command, 'vscode.changes');
		assert.strictEqual(entries[0][1].scheme, 'pr');
		assert.strictEqual(entries[0][2].scheme, 'pr');
	});

	it('opens pointer documents from a link to a checked-out PR diff', async function () {
		const change = await parseChange();
		const executeCommand = sandbox.stub(vscode.commands, 'executeCommand').resolves();
		await PullRequestModel.openDiff(folderManager, pr, change, change.fileName);
		const [command, baseUri, headUri] = executeCommand.firstCall.args;
		assert.strictEqual(command, 'vscode.diff');
		assert.strictEqual(baseUri.scheme, 'pr');
		assert.strictEqual(headUri.scheme, 'pr');
		assert.strictEqual(fromPRUri(baseUri)!.submoduleContent, `${oldPointer}\n`);
		assert.strictEqual(fromPRUri(headUri)!.submoduleContent, `${newPointer}\n`);
	});

	it('keeps pointer documents tied to their URI when the PR receives another push', async function () {
		const original = localModel(await parseChange());
		const provider = new InMemPRFileSystemProvider(undefined!, undefined!, undefined!);
		const registration = provider.registerTextDocumentContentProvider(pr.number, uri =>
			provideDocumentContentForChangeModel(folderManager, pr, fromPRUri(uri)!, original));
		try {
			const nextPointer = `Subproject commit ${'c'.repeat(40)}`;
			const nextChange = await parseChange('modified', `@@ -1 +1 @@\n-${oldPointer}\n+${nextPointer}`);
			const next = new GitFileChangeModel(folderManager, pr, nextChange, original.filePath, original.parentFilePath, 'next-head');
			assert.strictEqual(fromPRUri(next.filePath)!.headCommit, 'next-head');
			assert.strictEqual(new TextDecoder().decode(await provider.readFile(next.filePath)), `${nextPointer}\n`);
			assert.strictEqual(new TextDecoder().decode(await provider.readFile(original.filePath)), `${newPointer}\n`);
			registration.dispose();
			assert.strictEqual(new TextDecoder().decode(await provider.readFile(next.filePath)), `${nextPointer}\n`);
		} finally {
			registration.dispose();
		}
	});

	for (const patch of [
		'@@ -1 +1 @@\n-old text\n+new text',
		`@@ -2 +2 @@\n-${oldPointer}\n+${newPointer}`,
		`@@ -1,2 +1,2 @@\n context\n-${oldPointer}\n+${newPointer}`,
		'',
	]) {
		it(`preserves normal-file URIs for ${JSON.stringify(patch)}`, async function () {
			const change = await parseChange('modified', patch);
			const model = localModel(change);
			assert.strictEqual(model.filePath.scheme, 'vscode-remote');
			assert.strictEqual(model.parentFilePath.scheme, 'review');
			const inMemory = new InMemFileChangeModel(folderManager, pr, change, true, 'base');
			assert.strictEqual(inMemory.filePath.scheme, 'vscode-remote');
			assert.strictEqual(inMemory.parentFilePath.scheme, 'review');
		});
	}

	it('continues reconstructing normal text-file contents', async function () {
		const change = await parseChange('modified', '@@ -1 +1 @@\n-old text\n+new text');
		show.resolves('old text\n');
		getObjectDetails.resolves({ mode: '100644', object: 'blob', size: 9 });
		const model = new InMemFileChangeModel(folderManager, pr, change, false, 'base');
		assert.strictEqual(await provideDocumentContentForChangeModel(folderManager, pr, fromPRUri(model.filePath)!, model), 'new text\n');
		assert.strictEqual(show.calledOnce, true);
	});
});
