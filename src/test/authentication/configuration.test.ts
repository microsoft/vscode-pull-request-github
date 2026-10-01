/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import * as vscode from 'vscode';
import { addEnterpriseUri, getEnterpriseUris, parseEnterpriseUri } from '../../authentication/configuration';

describe('Enterprise configuration', function () {
	const hostA = 'https://host-a.example';
	const hostB = 'https://host-b.example';
	let sinon: SinonSandbox;
	let get: SinonStub;
	let inspect: SinonStub;
	let update: SinonStub;
	let trusted: SinonStub;
	let workspaceFolders: SinonStub;

	function configure(legacy?: unknown, plural?: unknown, scope = 'globalValue'): void {
		get.withArgs('uri').returns(legacy);
		get.withArgs('uris').returns(plural === undefined ? [] : plural);
		inspect.withArgs('uris').returns({ key: 'github-enterprise.uris', defaultValue: [], [scope]: plural });
	}

	beforeEach(function () {
		sinon = createSandbox();
		get = sinon.stub();
		inspect = sinon.stub();
		update = sinon.stub().resolves();
		const configuration: vscode.WorkspaceConfiguration = { get, inspect, update, has: sinon.stub() };
		sinon.stub(vscode.workspace, 'getConfiguration').returns(configuration);
		trusted = sinon.stub(vscode.workspace, 'isTrusted').value(true);
		sinon.stub(vscode.workspace, 'workspaceFile').value(undefined);
		workspaceFolders = sinon.stub(vscode.workspace, 'workspaceFolders').value([
			{ index: 0, name: 'workspace', uri: vscode.Uri.file(__dirname) },
		]);
	});

	afterEach(function () {
		sinon.restore();
	});

	for (const { name, legacy, plural, expected } of [
		{ name: 'no settings', legacy: undefined, plural: undefined, expected: [] },
		{ name: 'legacy with a plural schema default', legacy: hostA, plural: undefined, expected: [hostA] },
		{ name: 'plural only', legacy: undefined, plural: [hostB], expected: [hostB] },
		{ name: 'plural overrides legacy', legacy: hostA, plural: [hostB], expected: [hostB] },
		{ name: 'explicit empty suppresses legacy', legacy: hostA, plural: [], expected: [] },
		{ name: 'plural ignores invalid legacy', legacy: 'invalid', plural: [hostB], expected: [hostB] },
	]) {
		it(`resolves ${name}`, function () {
			configure(legacy, plural);
			assert.deepStrictEqual(getEnterpriseUris().map(uri => uri.toString()), expected.map(uri => parseEnterpriseUri(uri).toString()));
			assert.strictEqual(update.called, false);
		});
	}

	for (const scope of ['globalValue', 'workspaceValue', 'workspaceFolderValue']) {
		it(`honors explicit empty at ${scope}`, function () {
			configure(hostA, [], scope);
			assert.deepStrictEqual(getEnterpriseUris(), []);
		});
	}

	it('uses the effective list rather than merging configuration scopes', function () {
		configure(hostA, [hostB]);
		inspect.withArgs('uris').returns({
			key: 'github-enterprise.uris',
			globalValue: [hostA],
			workspaceValue: [hostB],
		});
		assert.deepStrictEqual(getEnterpriseUris().map(uri => uri.toString()), [parseEnterpriseUri(hostB).toString()]);
	});

	for (const scope of ['workspaceValue', 'workspaceFolderValue']) {
		it(`ignores an untrusted ${scope} that would suppress user legacy configuration`, function () {
			configure(hostA, [], scope);
			trusted.value(false);
			assert.deepStrictEqual(getEnterpriseUris().map(uri => uri.toString()), [parseEnterpriseUri(hostA).toString()]);
		});

		it(`uses eligible user configuration rather than raw untrusted ${scope}`, function () {
			configure(hostA, [hostB]);
			inspect.withArgs('uris').returns({ key: 'github-enterprise.uris', globalValue: [hostB], [scope]: [] });
			trusted.value(false);
			assert.deepStrictEqual(getEnterpriseUris().map(uri => uri.toString()), [parseEnterpriseUri(hostB).toString()]);
		});
	}

	for (const plural of [null, hostA, [42], ['invalid'], [hostA, 'https://github.com']]) {
		it(`rejects invalid plural configuration ${JSON.stringify(plural)} without a legacy fallback`, function () {
			configure(hostB, plural);
			assert.throws(() => getEnterpriseUris(), /GitHub Enterprise/);
			assert.strictEqual(update.called, false);
		});
	}

	for (const value of [
		'', 'invalid', 'file:///host', 'https://github.com', 'https://www.github.com',
		'https://api.github.com', 'https://GITHUB.COM.', 'https://user@host.example',
		'https://host.example?query', 'https://host.example#fragment',
		'https://host.example/a/../b', 'https://host.example/a//b',
	]) {
		it(`rejects invalid instance URL ${value}`, function () {
			assert.throws(() => parseEnterpriseUri(value), /Invalid GitHub Enterprise instance URL/);
		});
	}

	it('preserves schemes, ports and path case while deduplicating equivalent instances', function () {
		configure(undefined, [
			'https://HOST.EXAMPLE:8443/Team%20One/',
			'https://host.example:8443/Team%20One',
			'http://host.example:8443/Team%20One',
			'https://host.example:9443/Team%20One',
			'https://host.example:8443/team%20one',
		]);
		const instances = getEnterpriseUris();
		assert.strictEqual(instances.length, 4);
		assert.strictEqual(instances[0].authority, 'host.example:8443');
		assert.strictEqual(instances[0].path, '/Team One');
		assert.strictEqual(instances[1].scheme, 'http');
		assert.strictEqual(instances[2].authority, 'host.example:9443');
		assert.strictEqual(instances[3].path, '/team one');
	});

	describe('adding an instance', function () {
		for (const { name, legacy, plural, expected } of [
			{ name: 'legacy-only configuration', legacy: hostA, plural: undefined, expected: [hostA, hostB] },
			{ name: 'an existing user list', legacy: undefined, plural: [hostA], expected: [hostA, hostB] },
			{ name: 'an explicit empty list', legacy: hostA, plural: [], expected: [hostB] },
			{ name: 'no configuration', legacy: undefined, plural: undefined, expected: [hostB] },
		]) {
			it(`preserves ${name} when writing the plural workspace setting`, async function () {
				configure(legacy, plural);
				await addEnterpriseUri(hostB);
				assert.deepStrictEqual(update.args, [[
					'uris', expected.map(uri => parseEnterpriseUri(uri).toString()), vscode.ConfigurationTarget.Workspace,
				]]);
			});
		}

		it('does not write an equivalent duplicate', async function () {
			configure(undefined, ['https://HOST-B.EXAMPLE/']);
			await addEnterpriseUri(hostB);
			assert.strictEqual(update.called, false);
		});

		it('reads configuration at the time of each addition', async function () {
			configure(undefined, [hostA]);
			await addEnterpriseUri(hostB);
			configure(undefined, [hostA, hostB, 'https://host-c.example']);
			await addEnterpriseUri('https://host-d.example');
			assert.deepStrictEqual(update.lastCall.args[1], [hostA, hostB, 'https://host-c.example', 'https://host-d.example'].map(uri => parseEnterpriseUri(uri).toString()));
		});

		it('does not write into an untrusted workspace', async function () {
			configure();
			trusted.value(false);
			await assert.rejects(addEnterpriseUri(hostB), /trusted workspace/);
			assert.strictEqual(update.called, false);
		});

		it('does not silently change user settings without an open workspace', async function () {
			configure();
			workspaceFolders.value(undefined);
			await assert.rejects(addEnterpriseUri(hostB), /user settings/);
			assert.strictEqual(update.called, false);
		});

		it('rejects a workspace write shadowed by a folder setting', async function () {
			configure(undefined, [hostA], 'workspaceFolderValue');
			await assert.rejects(addEnterpriseUri(hostB), /folder setting overrides/);
			assert.strictEqual(update.called, false);
		});

		it('preserves invalid configuration instead of replacing it', async function () {
			configure(hostA, [42]);
			await assert.rejects(addEnterpriseUri(hostB), /Invalid GitHub Enterprise/);
			assert.strictEqual(update.called, false);
		});

		it('propagates a configuration-write failure', async function () {
			configure();
			update.rejects(new Error('Settings are read-only'));
			await assert.rejects(addEnterpriseUri(hostB), /Settings are read-only/);
		});
	});
});
