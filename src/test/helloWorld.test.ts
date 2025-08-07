/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';

describe('Hello World Command', function () {
	let showInformationMessageStub: sinon.SinonStub;

	beforeEach(() => {
		showInformationMessageStub = sinon.stub(vscode.window, 'showInformationMessage');
	});

	afterEach(() => {
		showInformationMessageStub.restore();
	});

	it('should show hello world message', async () => {
		// Execute the command
		await vscode.commands.executeCommand('pr.helloWorld');

		// Verify that the information message was shown
		assert.strictEqual(showInformationMessageStub.calledOnce, true);
		assert.strictEqual(
			showInformationMessageStub.calledWith('Hello World from GitHub Pull Request extension!'),
			true
		);
	});
});