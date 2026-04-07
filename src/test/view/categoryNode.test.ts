/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { createSandbox, SinonSandbox } from 'sinon';
import { PRType } from '../../github/interface';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { CategoryTreeNode, PRCategoryActionNode, PRCategoryActionType } from '../../view/treeNodes/categoryNode';

describe('CategoryTreeNode', function () {
	let sinon: SinonSandbox;

	beforeEach(function () {
		sinon = createSandbox();
	});

	afterEach(function () {
		sinon.restore();
	});

	it('uses the enterprise sign-in command for the enterprise login action', function () {
		const node = new PRCategoryActionNode({} as any, PRCategoryActionType.LoginEnterprise);

		assert.strictEqual(node.command?.command, 'pr.signinenterprise');
	});

	it('uses the custom enterprise sign-in command when a custom enterprise URI is configured', function () {
		const originalGetConfiguration = vscode.workspace.getConfiguration;
		vscode.workspace.getConfiguration = ((section?: string) => {
			if (section === 'githubPullRequests') {
				return {
					get: (key: string, defaultValue?: string) => key === 'customEnterpriseUri' ? 'https://pr.example.com/' : defaultValue,
				} as unknown as vscode.WorkspaceConfiguration;
			}

			return originalGetConfiguration(section);
		}) as typeof vscode.workspace.getConfiguration;

		try {
			const node = new PRCategoryActionNode({} as any, PRCategoryActionType.LoginEnterprise);

			assert.strictEqual(node.command?.command, 'pr.signinCustomEnterprise');
		} finally {
			vscode.workspace.getConfiguration = originalGetConfiguration;
		}
	});

	it('offers Login again and recreates credentials when fetching pull requests fails with bad credentials', async function () {
		const recreateStub = sinon.stub().resolves({ canceled: false });
		const folderRepoManager = {
			credentialStore: {
				recreate: recreateStub,
			},
		} as any;
		const prsTreeModel = {
			hasLoaded: true,
			getPullRequestsForQuery: sinon.stub().rejects(new Error('Bad credentials')),
		} as any;
		const parent = {
			children: undefined,
			refresh: sinon.stub(),
			reveal: sinon.stub().resolves(),
			view: {} as vscode.TreeView<any>,
		} as any;
		sinon.stub(vscode.window as any, 'showErrorMessage').callsFake(async (...args: any[]) => args[1]);

		const node = new CategoryTreeNode(
			parent,
			folderRepoManager,
			new MockTelemetry(),
			PRType.Query,
			{} as any,
			prsTreeModel,
			'Assigned To Me',
			'is:open assignee:${user}',
		);

		await node.getChildren();
		await Promise.resolve();

		assert.strictEqual(recreateStub.calledOnce, true);
		assert.strictEqual(recreateStub.firstCall.args[0], 'Your login session is no longer valid.');
	});
});