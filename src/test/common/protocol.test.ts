/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Protocol, ProtocolType } from '../../common/protocol';

describe('Protocol', () => {
	it('should handle HTTP and HTTPS remotes', () => {
		[
			{ uri: 'http://rmacfarlane@github.com/Microsoft/vscode', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'http://rmacfarlane:password@github.com/Microsoft/vscode', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'http://github.com/Microsoft/vscode', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'http://github.com/Microsoft/vscode.git', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'http://github.com:/Microsoft/vscode.git', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'http://github.com:433/Microsoft/vscode.git', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'https://rmacfarlane@github.com/Microsoft/vscode', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'https://rmacfarlane:password@github.com/Microsoft/vscode', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'https://github.com/Microsoft/vscode', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'https://github.com/Microsoft/vscode.git', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'https://github.com:/Microsoft/vscode.git', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'https://github.com:433/Microsoft/vscode.git', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'https://github.enterprise.corp/Microsoft/vscode.git', expectedType: ProtocolType.HTTP, expectedHost: 'github.enterprise.corp', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' }
		].forEach(remote => {
			const protocol = new Protocol(remote.uri);
			assert.equal(protocol.type, remote.expectedType);
			assert.equal(protocol.host, remote.expectedHost);
			assert.equal(protocol.owner, remote.expectedOwner);
			assert.equal(protocol.repositoryName, remote.expectedRepositoryName);
		});
	});

	it('should handle SSH remotes', () => {
		[
			{ uri: 'ssh://git@github.com/Microsoft/vscode', expectedType: ProtocolType.SSH, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'ssh://github.com:Microsoft/vscode.git', expectedType: ProtocolType.SSH, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'ssh://git@github.com:433/Microsoft/vscode', expectedType: ProtocolType.SSH, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'ssh://user@git.server.org:project.git', expectedType: ProtocolType.SSH, expectedHost: 'git.server.org', expectedOwner: null, expectedRepositoryName: 'project' }

		].forEach(remote => {
			const protocol = new Protocol(remote.uri);
			assert.equal(protocol.type, remote.expectedType);
			assert.equal(protocol.host, remote.expectedHost);
			assert.equal(protocol.owner, remote.expectedOwner);
			assert.equal(protocol.repositoryName, remote.expectedRepositoryName);
		});
	});

	it('should handle SCP-like remotes', () => {
		[
			{ uri: 'git@github.com:Microsoft/vscode', expectedType: ProtocolType.SSH, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'git@github.com:Microsoft/vscode.git', expectedType: ProtocolType.SSH, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'github.com:Microsoft/vscode.git', expectedType: ProtocolType.SSH, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'user@git.server.org:project.git', expectedType: ProtocolType.SSH, expectedHost: 'git.server.org', expectedOwner: null, expectedRepositoryName: 'project' },
			{ uri: 'git.server2.org:project.git', expectedType: ProtocolType.SSH, expectedHost: 'git.server2.org', expectedOwner: null, expectedRepositoryName: 'project' }
		].forEach(remote => {
			const protocol = new Protocol(remote.uri);
			assert.equal(protocol.type, remote.expectedType);
			assert.equal(protocol.host, remote.expectedHost);
			assert.equal(protocol.owner, remote.expectedOwner);
			assert.equal(protocol.repositoryName, remote.expectedRepositoryName);
		});
	});

	it('should handle local remotes', () => {
		[
			{ uri: '/opt/git/project.git', expectedType: ProtocolType.OTHER, expectedHost: '', expectedOwner: '', expectedRepositoryName: '' },
			{ uri: 'file:///opt/git/project.git', expectedType: ProtocolType.Local, expectedHost: '', expectedOwner: '', expectedRepositoryName: '' }
		].forEach(remote => {
			const protocol = new Protocol(remote.uri);
			assert.equal(protocol.type, remote.expectedType);
			assert.equal(protocol.host, remote.expectedHost);
			assert.equal(protocol.owner, remote.expectedOwner);
			assert.equal(protocol.repositoryName, remote.expectedRepositoryName);
		});
	});

	it('toString generate github remotes', () => {
		[
			{ uri: 'ssh://git@github.com/Microsoft/vscode', expected: 'git@github.com:Microsoft/vscode' },
			{ uri: 'ssh://github.com:Microsoft/vscode.git', expected: 'git@github.com:Microsoft/vscode' },
			{ uri: 'ssh://git@github.com:433/Microsoft/vscode', expected: 'git@github.com:Microsoft/vscode' },

		].forEach(remote => {
			const protocol = new Protocol(remote.uri);
			assert.equal(protocol.toString(), remote.expected);
		});
	});

	it('Protocol.update', () => {
		[
			{ uri: 'http://rmacfarlane@github.com/Microsoft/vscode', change: { type: ProtocolType.SSH }, expected: 'git@github.com:Microsoft/vscode' },
			{ uri: 'http://rmacfarlane:password@github.com/Microsoft/vscode', change: { type: ProtocolType.SSH }, expected: 'git@github.com:Microsoft/vscode' },
			{ uri: 'http://github.com/Microsoft/vscode', change: { type: ProtocolType.SSH }, expected: 'git@github.com:Microsoft/vscode' },
			{ uri: 'http://github.com/Microsoft/vscode.git', change: { type: ProtocolType.SSH }, expected: 'git@github.com:Microsoft/vscode' },
			{ uri: 'http://github.com:/Microsoft/vscode.git', change: { type: ProtocolType.SSH }, expected: 'git@github.com:Microsoft/vscode' },
			{ uri: 'http://github.com:433/Microsoft/vscode.git', change: { type: ProtocolType.SSH }, expected: 'git@github.com:Microsoft/vscode' },
			{ uri: 'https://rmacfarlane@github.com/Microsoft/vscode', change: { type: ProtocolType.SSH }, expected: 'git@github.com:Microsoft/vscode' },
			{ uri: 'https://rmacfarlane:password@github.com/Microsoft/vscode', change: { type: ProtocolType.SSH }, expected: 'git@github.com:Microsoft/vscode' },
			{ uri: 'https://github.com/Microsoft/vscode', change: { type: ProtocolType.SSH }, expected: 'git@github.com:Microsoft/vscode' },
			{ uri: 'https://github.com/Microsoft/vscode.git', change: { type: ProtocolType.SSH }, expected: 'git@github.com:Microsoft/vscode' },
			{ uri: 'https://github.com:/Microsoft/vscode.git', change: { type: ProtocolType.SSH }, expected: 'git@github.com:Microsoft/vscode' },
			{ uri: 'https://github.com:433/Microsoft/vscode.git', change: { type: ProtocolType.SSH }, expected: 'git@github.com:Microsoft/vscode' },
			{ uri: 'https://github.enterprise.corp/Microsoft/vscode.git', change: { type: ProtocolType.SSH }, expected: 'git@github.enterprise.corp:Microsoft/vscode' }
		].forEach(remote => {
			const protocol = new Protocol(remote.uri);
			protocol.update(remote.change);
			assert.equal(protocol.toString(), remote.expected);
		});
	});
});