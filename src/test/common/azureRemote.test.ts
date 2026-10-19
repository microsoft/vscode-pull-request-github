/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as vscode from 'vscode';
import { AuthProvider } from '../../common/authentication';
import { GitHubRef, findLocalRepoRemoteFromGitHubRef } from '../../common/githubRef';
import { Protocol, ProtocolType } from '../../common/protocol';
import { parseRemote } from '../../common/remote';
import { MockRepository } from '../mocks/mockRepository';

describe('Azure repository identities in shared Git workflows', () => {
	it('normalizes cloud HTTPS, legacy HTTPS and SSH to the full organization/project/repository identity', () => {
		const urls = [
			'https://dev.azure.com/Org/My%20Project/_git/Repo.git',
			'https://Org.visualstudio.com/My%20Project/_git/Repo.git',
			'git@ssh.dev.azure.com:v3/Org/My%20Project/Repo.git',
			'ssh://git@ssh.dev.azure.com/v3/Org/My%20Project/Repo.git',
		];
		const protocols = urls.map(url => new Protocol(url));
		for (const protocol of protocols) {
			assert.strictEqual(protocol.owner, 'My Project');
			assert.strictEqual(protocol.repositoryName, 'Repo.git');
			assert.strictEqual(protocol.normalizeUri()?.toString().toLowerCase(), urls[0].toLowerCase());
			assert.ok(protocol.equals(protocols[0]));
		}
		assert.strictEqual(protocols[2].type, ProtocolType.SSH);
		assert.strictEqual(protocols[2].toString(), 'ssh://git@ssh.dev.azure.com/v3/Org/My%20Project/Repo.git');
		protocols[2].update({ type: ProtocolType.HTTP });
		assert.strictEqual(protocols[2].toString(), urls[0]);
	});

	it('does not collapse matching project/repository names across organizations', () => {
		const first = parseRemote('origin', 'https://dev.azure.com/First/Project/_git/Repo');
		const second = parseRemote('origin', 'https://dev.azure.com/Second/Project/_git/Repo');
		assert.ok(first && second);
		assert.strictEqual(first.equals(second), false);
		assert.strictEqual(first.normalizedHost, 'https://dev.azure.com/First');
		assert.strictEqual(first.authProviderId, AuthProvider.azureDevOps);
		assert.strictEqual(first.matchesServerUri(vscode.Uri.parse('https://dev.azure.com/Second')), false);
		assert.strictEqual(first.matchesServerUri(vscode.Uri.parse('https://dev.azure.com/First')), true);
	});

	it('matches the exact Azure repository during shared checkout rather than the first same-named remote', () => {
		const repository = new MockRepository();
		repository.state.remotes.push(
			{ name: 'wrong', fetchUrl: 'https://dev.azure.com/Wrong/Project/_git/Repo', isReadOnly: false },
			{ name: 'correct', fetchUrl: 'git@ssh.dev.azure.com:v3/Right/Project/Repo', isReadOnly: false },
		);
		const ref = new GitHubRef('feature', 'feature', 'commit', 'https://dev.azure.com/Right/Project/_git/Repo', 'Project', 'Repo', true);
		assert.strictEqual(findLocalRepoRemoteFromGitHubRef(repository, ref)?.name, 'correct');
		assert.strictEqual(ref.repositoryCloneUrl.normalizeUri()?.path, '/Right/Project/_git/Repo');
	});

	it('preserves trusted Server collection paths and explicit SSH ports', async () => {
		const configuration = vscode.workspace.getConfiguration('azureDevOpsPullRequests');
		const previous = configuration.inspect<string[]>('serverCollections')?.globalValue;
		await configuration.update('serverCollections', ['https://devops.example.com:8443/tfs/Collection'], vscode.ConfigurationTarget.Global);
		try {
			const https = parseRemote('origin', 'https://devops.example.com:8443/tfs/Collection/Project/_git/Repo.git');
			const ssh = parseRemote('origin', 'ssh://git@devops.example.com:22/tfs/Collection/Project/_git/Repo.git');
			assert.ok(https && ssh);
			assert.strictEqual(https.normalizedHost, 'https://devops.example.com:8443/tfs/Collection');
			assert.ok(https.equals(ssh));
			assert.strictEqual(ssh.gitProtocol.toString(), 'ssh://git@devops.example.com:22/tfs/Collection/Project/_git/Repo.git');
			assert.strictEqual(https.matchesServerUri(vscode.Uri.parse('https://devops.example.com:8443/tfs/Other')), false);
			assert.throws(() => https.gitProtocol.update({ owner: 'OtherProject' }), /immutable/);
		} finally {
			await configuration.update('serverCollections', previous, vscode.ConfigurationTarget.Global);
		}
	});
});
