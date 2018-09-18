/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Protocol } from '../../common/protocol';

describe('Protocol', () => {
	it('should handle HTTP and HTTPS remotes', () => {
		[
			'http://rmacfarlane@github.com/Microsoft/vscode',
			'http://rmacfarlane:password@github.com/Microsoft/vscode',
			'http://github.com/Microsoft/vscode',
			'http://github.com/Microsoft/vscode.git',
			'http://github.com:/Microsoft/vscode.git',
			'http://github.com:433/Microsoft/vscode.git',
			'https://rmacfarlane@github.com/Microsoft/vscode',
			'https://rmacfarlane:password@github.com/Microsoft/vscode',
			'https://github.com/Microsoft/vscode',
			'https://github.com/Microsoft/vscode.git',
			'https://github.com:/Microsoft/vscode.git',
			'https://github.com:433/Microsoft/vscode.git'
		].forEach(remoteUri => {
			const protocol = new Protocol(remoteUri);
			assert.equal(protocol.host, 'github.com');
			assert.equal(protocol.owner, 'Microsoft');
			assert.equal(protocol.repositoryName, 'vscode');
		});
	});

	it('should handle SSH remotes', () => {
		[
			{ uri: 'ssh://git@github.com/Microsoft/vscode', expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'ssh://github.com:Microsoft/vscode.git', expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'ssh://git@github.com:433/Microsoft/vscode', expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'ssh://user@git.server.org:project.git', expectedHost: 'git.server.org', expectedOwner: null, expectedRepositoryName: 'project' }

		].forEach(remote => {
			const protocol = new Protocol(remote.uri);
			assert.equal(protocol.host, remote.expectedHost);
			assert.equal(protocol.owner, remote.expectedOwner);
			assert.equal(protocol.repositoryName, remote.expectedRepositoryName);
		});
	});

	it('should handle SCP-like remotes', () => {
		[
			{ uri: 'git@github.com:Microsoft/vscode', expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'git@github.com:Microsoft/vscode.git', expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'github.com:Microsoft/vscode.git', expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'user@git.server.org:project.git', expectedHost: 'git.server.org', expectedOwner: null, expectedRepositoryName: 'project' },
			{ uri: 'git.server2.org:project.git', expectedHost: 'git.server2.org', expectedOwner: null, expectedRepositoryName: 'project' }
		].forEach(remote => {
			const protocol = new Protocol(remote.uri);
			assert.equal(protocol.host, remote.expectedHost);
			assert.equal(protocol.owner, remote.expectedOwner);
			assert.equal(protocol.repositoryName, remote.expectedRepositoryName);
		});
	});

	it('should handle local remotes', () => {
		[
			{ uri: '/opt/git/project.git', expectedHost: '', expectedOwner: '', expectedRepositoryName: '' },
			{ uri: 'file:///opt/git/project.git', expectedHost: '', expectedOwner: '', expectedRepositoryName: '' }
		].forEach(remote => {
			const protocol = new Protocol(remote.uri);
			assert.equal(protocol.host, remote.expectedHost);
			assert.equal(protocol.owner, remote.expectedOwner);
			assert.equal(protocol.repositoryName, remote.expectedRepositoryName);
		});
	});
});