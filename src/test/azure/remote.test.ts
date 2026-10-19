/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { azureRepositoryUrl, parseAzureRemote } from '../../azure/remote';
import { resolveGitUrlAlias } from '../../common/gitUrl';

describe('Azure DevOps remotes', () => {
	const expected = { organizationUrl: 'https://dev.azure.com/example', project: 'My Project', repository: 'My Repo' };

	for (const url of [
		'https://dev.azure.com/example/My%20Project/_git/My%20Repo',
		'https://example@dev.azure.com/example/My%20Project/_git/My%20Repo',
		'https://example.visualstudio.com/My%20Project/_git/My%20Repo',
		'https://example.visualstudio.com/DefaultCollection/My%20Project/_git/My%20Repo',
		'git@ssh.dev.azure.com:v3/example/My%20Project/My%20Repo',
		'ssh://git@ssh.dev.azure.com/v3/example/My%20Project/My%20Repo',
		'example@vs-ssh.visualstudio.com:v3/example/My%20Project/My%20Repo',
		'ssh://example@vs-ssh.visualstudio.com/v3/example/My%20Project/My%20Repo',
	]) {
		it(`parses ${url}`, () => assert.deepStrictEqual(parseAzureRemote(url), expected));
	}

	it('does not expose embedded credentials in API or browser URLs', () => {
		const remote = parseAzureRemote('https://user:secret@dev.azure.com/example/My%20Project/_git/My%20Repo?token=secret#secret');
		assert.deepStrictEqual(remote, expected);
		assert.strictEqual(azureRepositoryUrl(remote!), 'https://dev.azure.com/example/My%20Project/_git/My%20Repo');
	});

	it('requires explicit trust for a server collection', () => {
		const url = 'https://server.example:8443/tfs/Collection/Project/_git/Repo';
		assert.strictEqual(parseAzureRemote(url), undefined);
		assert.deepStrictEqual(parseAzureRemote(url, ['https://server.example:8443/tfs/Collection/']), {
			organizationUrl: 'https://server.example:8443/tfs/Collection', project: 'Project', repository: 'Repo',
		});
	});

	it('does not trust other collections, ports, or lookalike hosts', () => {
		const trusted = ['https://server.example/tfs/Collection'];
		for (const url of [
			'https://server.example/tfs/Other/Project/_git/Repo',
			'https://server.example:8443/tfs/Collection/Project/_git/Repo',
			'https://server.example.attacker.test/tfs/Collection/Project/_git/Repo',
			'https://dev.azure.com.attacker.test/example/Project/_git/Repo',
			'https://example.visualstudio.com.attacker.test/Project/_git/Repo',
		]) {
			assert.strictEqual(parseAzureRemote(url, trusted), undefined);
		}
	});

	it('maps Server SSH paths only to explicitly trusted HTTPS collections', () => {
		const url = 'ssh://git@server.example:22/tfs/Collection/Project/_git/Repo';
		assert.strictEqual(parseAzureRemote(url), undefined);
		assert.deepStrictEqual(parseAzureRemote(url, ['https://server.example:8443/tfs/Collection']), {
			organizationUrl: 'https://server.example:8443/tfs/Collection', project: 'Project', repository: 'Repo',
		});
		assert.strictEqual(parseAzureRemote(url, ['https://server.example/tfs/Other']), undefined);
		assert.strictEqual(parseAzureRemote(url, ['https://server.example.attacker.test/tfs/Collection']), undefined);
	});

	it('ignores non-Azure, insecure, and incomplete remotes', () => {
		for (const url of [
			'', '/tmp/repo', 'git@github.com:owner/repo.git', 'https://github.com/owner/repo',
			'http://dev.azure.com/example/Project/_git/Repo', 'https://dev.azure.com/example/Project',
			'https://dev.azure.com/example/Project/_git/Repo/extra',
		]) {
			assert.strictEqual(parseAzureRemote(url), undefined);
		}
	});

	it('preserves .git in Azure repository names rather than guessing', () => {
		assert.strictEqual(parseAzureRemote('https://dev.azure.com/example/Project/_git/Repo.git')?.repository, 'Repo.git');
	});

	it('resolves the longest Git URL alias before Azure discovery', () => {
		const configs = [
			{ key: 'url.https://dev.azure.com/other/.insteadOf', value: 'ado:' },
			{ key: 'url.https://dev.azure.com/example/.insteadOf', value: 'ado:example/' },
		];
		assert.deepStrictEqual(parseAzureRemote(resolveGitUrlAlias('ado:example/My%20Project/_git/My%20Repo', configs)), expected);
		assert.strictEqual(resolveGitUrlAlias('https://unrelated.example/repo', configs), 'https://unrelated.example/repo');
	});
});
