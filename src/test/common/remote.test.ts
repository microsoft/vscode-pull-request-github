/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { parseRepositoryRemotesAsync } from '../../common/remote';
import { MockRepository } from '../mocks/mockRepository';

describe('parseRepositoryRemotesAsync', () => {
	it('resolves a remote URL using a global "url.<base>.insteadOf" alias', async () => {
		const repository = new MockRepository();
		// Simulate `git config url."https://github.abc.com/".insteadOf github:`
		await repository.setConfig('url.https://github.abc.com/.insteadof', 'github:');
		// And a remote stored as `github:org/repo` (as returned by `git config --get remote.origin.url`
		// when the user clones with `git clone github:org/repo`).
		await repository.addRemote('origin', 'github:org/repo');

		const remotes = await parseRepositoryRemotesAsync(repository);

		assert.strictEqual(remotes.length, 1);
		assert.strictEqual(remotes[0].remoteName, 'origin');
		assert.strictEqual(remotes[0].host, 'github.abc.com');
		assert.strictEqual(remotes[0].owner, 'org');
		assert.strictEqual(remotes[0].repositoryName, 'repo');
	});

	it('applies the longest matching insteadOf prefix when multiple match', async () => {
		const repository = new MockRepository();
		await repository.setConfig('url.https://short.example.com/.insteadof', 'gh:');
		await repository.setConfig('url.https://long.example.com/.insteadof', 'gh:org/');
		await repository.addRemote('origin', 'gh:org/repo');

		const remotes = await parseRepositoryRemotesAsync(repository);

		assert.strictEqual(remotes.length, 1);
		assert.strictEqual(remotes[0].host, 'long.example.com');
		assert.strictEqual(remotes[0].repositoryName, 'repo');
	});

	it('leaves URLs unchanged when no insteadOf alias matches', async () => {
		const repository = new MockRepository();
		await repository.setConfig('url.https://github.abc.com/.insteadof', 'github:');
		await repository.addRemote('origin', 'https://github.com/owner/repo');

		const remotes = await parseRepositoryRemotesAsync(repository);

		assert.strictEqual(remotes.length, 1);
		assert.strictEqual(remotes[0].host, 'github.com');
		assert.strictEqual(remotes[0].owner, 'owner');
		assert.strictEqual(remotes[0].repositoryName, 'repo');
	});
});
