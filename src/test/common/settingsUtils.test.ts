/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { createSandbox, SinonSandbox } from 'sinon';
import { areStacksEnabled, assertStacksEnabled } from '../../common/settingsUtils';
import { mockStackSetting } from '../mocks/mockStackSetting';

describe('Stack settings', function () {
	let sinon: SinonSandbox;
	let setStacksEnabled: (enabled: boolean) => void;

	beforeEach(function () {
		sinon = createSandbox();
		setStacksEnabled = mockStackSetting(sinon);
	});

	afterEach(function () {
		sinon.restore();
	});

	it('checks the current setting on every assertion', function () {
		assert.strictEqual(areStacksEnabled(), true);
		assert.doesNotThrow(() => assertStacksEnabled());

		setStacksEnabled(false);
		assert.strictEqual(areStacksEnabled(), false);
		assert.throws(() => assertStacksEnabled(), /Pull request stack features are disabled/);

		setStacksEnabled(true);
		assert.doesNotThrow(() => assertStacksEnabled());
	});

	it('localizes the disabled-feature error', function () {
		setStacksEnabled(false);
		const localize = sinon.stub(vscode.l10n, 't').returns('Localized stacks-disabled message.');

		assert.throws(() => assertStacksEnabled(), { message: 'Localized stacks-disabled message.' });
		assert(localize.calledOnce);
		assert.deepStrictEqual(localize.firstCall.args, ['Pull request stack features are disabled.']);
	});
});
