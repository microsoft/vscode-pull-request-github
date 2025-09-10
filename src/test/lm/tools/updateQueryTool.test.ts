/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { SinonSandbox, createSandbox } from 'sinon';
import * as vscode from 'vscode';
import { UpdateQueryTool } from '../../../lm/tools/updateQueryTool';
import { ISSUES_SETTINGS_NAMESPACE, PR_SETTINGS_NAMESPACE } from '../../../common/settingKeys';

describe('UpdateQueryTool', function () {
	let sinon: SinonSandbox;
	let tool: UpdateQueryTool;

	beforeEach(function () {
		sinon = createSandbox();
		tool = new UpdateQueryTool();
	});

	afterEach(function () {
		sinon.restore();
	});

	describe('toolId', function () {
		it('should have the correct tool ID', function () {
			assert.strictEqual(UpdateQueryTool.toolId, 'github-pull-request_update_query');
		});
	});

	describe('prepareInvocation()', function () {
		it('should return the correct invocation message', async function () {
			const mockInput = {
				namespace: PR_SETTINGS_NAMESPACE,
				queryName: 'My Queries',
				newQuery: 'is:pr state:open'
			};

			const result = await tool.prepareInvocation({ input: mockInput } as any);
			assert.strictEqual(result.invocationMessage, 'Updating query "My Queries"');
		});

		it('should handle unnamed query', async function () {
			const mockInput = {
				namespace: PR_SETTINGS_NAMESPACE,
				queryName: '',
				newQuery: 'is:pr state:open'
			};

			const result = await tool.prepareInvocation({ input: mockInput } as any);
			assert.strictEqual(result.invocationMessage, 'Updating query "unnamed"');
		});
	});

	describe('invoke()', function () {
		it('should return error for missing parameters', async function () {
			const mockInput = {
				namespace: '',
				queryName: '',
				newQuery: ''
			};

			const result = await tool.invoke({ input: mockInput } as any, {} as any);
			assert.ok(result);
			const textPart = result.content[0] as vscode.LanguageModelTextPart;
			assert.ok(textPart.value.includes('Missing required parameters'));
		});

		it('should return error for invalid namespace', async function () {
			const mockInput = {
				namespace: 'invalid',
				queryName: 'test',
				newQuery: 'is:pr state:open'
			};

			const result = await tool.invoke({ input: mockInput } as any, {} as any);
			assert.ok(result);
			const textPart = result.content[0] as vscode.LanguageModelTextPart;
			assert.ok(textPart.value.includes('Invalid namespace'));
		});

		it('should accept valid namespaces', async function () {
			// Mock workspace configuration
			const mockConfig = {
				inspect: sinon.stub().returns({ workspaceValue: [{ label: 'test', query: 'old query' }] }),
				get: sinon.stub().returns([{ label: 'test', query: 'old query' }]),
				update: sinon.stub().resolves()
			};
			sinon.stub(vscode.workspace, 'getConfiguration').returns(mockConfig as any);

			const prInput = {
				namespace: PR_SETTINGS_NAMESPACE,
				queryName: 'test',
				newQuery: 'is:pr state:open'
			};

			const result1 = await tool.invoke({ input: prInput } as any, {} as any);
			assert.ok(result1);
			const textPart1 = result1.content[0] as vscode.LanguageModelTextPart;
			assert.ok(textPart1.value.includes('Successfully updated query'));

			const issuesInput = {
				namespace: ISSUES_SETTINGS_NAMESPACE,
				queryName: 'test',
				newQuery: 'is:issue state:open'
			};

			const result2 = await tool.invoke({ input: issuesInput } as any, {} as any);
			assert.ok(result2);
			const textPart2 = result2.content[0] as vscode.LanguageModelTextPart;
			assert.ok(textPart2.value.includes('Successfully updated query'));
		});
	});
});