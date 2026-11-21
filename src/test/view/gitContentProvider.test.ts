/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import * as vscode from 'vscode';
import { GitApiImpl } from '../../api/api1';
import { toReviewUri } from '../../common/uri';
import { CredentialStore } from '../../github/credentials';
import { GitContentFileSystemProvider } from '../../view/gitContentProvider';
import { MockRepository } from '../mocks/mockRepository';

describe('GitContentFileSystemProvider', function () {
	let sandbox: SinonSandbox;
	let provider: GitContentFileSystemProvider;
	let showErrorMessage: SinonStub;

	beforeEach(function () {
		sandbox = createSandbox();
		const gitApi = {
			state: 'initialized',
			repositories: [new MockRepository()],
		} as unknown as GitApiImpl;
		const credentialStore = {
			isAnyAuthenticated: () => true,
		} as unknown as CredentialStore;
		provider = new GitContentFileSystemProvider(gitApi, credentialStore, () => []);
		provider.registerTextDocumentContentFallback(async () => '');
		showErrorMessage = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
	});

	afterEach(function () {
		sandbox.restore();
	});

	it('does not show an error for a repository from a previous workspace', async function () {
		sandbox.stub(vscode.workspace, 'getWorkspaceFolder').returns(undefined);

		await provider.readFile(createReviewUri('/previous-workspace'));

		assert.strictEqual(showErrorMessage.called, false);
	});

	it('shows an error when the repository belongs to the current workspace', async function () {
		const rootUri = vscode.Uri.file('/current-workspace');
		sandbox.stub(vscode.workspace, 'getWorkspaceFolder').returns({
			uri: rootUri,
			name: 'current-workspace',
			index: 0,
		});

		await provider.readFile(createReviewUri(rootUri.path));

		assert.strictEqual(showErrorMessage.calledOnce, true);
	});
});

function createReviewUri(rootPath: string): vscode.Uri {
	const rootUri = vscode.Uri.file(rootPath);
	return toReviewUri(
		vscode.Uri.joinPath(rootUri, 'file.ts'),
		'file.ts',
		undefined,
		'commit',
		false,
		{ base: true },
		rootUri,
	);
}
