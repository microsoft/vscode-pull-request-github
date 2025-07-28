/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as vscode from 'vscode';
import { createSandbox, SinonSandbox } from 'sinon';
import { toOpenPullRequestWebviewUri } from '../../common/uri';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';

suite('CopilotRemoteAgent URI Generation', function () {
	let sinon: SinonSandbox;

	setup(function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);
	});

	teardown(function () {
		sinon.restore();
	});

	test('toOpenPullRequestWebviewUri generates correct link format', async function () {
		const params = {
			owner: 'microsoft',
			repo: 'vscode',
			pullRequestNumber: 123
		};

		const uri = await toOpenPullRequestWebviewUri(params);
		
		assert.ok(uri.toString().includes('open-pull-request-webview'));
		assert.ok(uri.toString().includes('microsoft'));
		assert.ok(uri.toString().includes('vscode'));
		assert.ok(uri.toString().includes('123'));
		
		// Verify the URI format contains expected structure
		const uriString = uri.toString();
		assert.ok(uriString.startsWith('vscode://'));
		assert.ok(uriString.includes('GitHub.vscode-pull-request-github'));
	});
});