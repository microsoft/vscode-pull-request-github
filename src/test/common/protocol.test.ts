/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert = require('assert');
import * as ssh from '../../env/node/ssh';
import { Protocol, ProtocolType } from '../../common/protocol';

const SSH_CONFIG_WITH_HOST_ALIASES = `
Host gh_nocap
  User git
  Hostname github.com

Host gh_cap
  User git
  HostName github.com
`;

const str = (x: any) => JSON.stringify(x);

const testRemote = (remote: { uri: any, expectedType: ProtocolType, expectedHost: string, expectedOwner: string, expectedRepositoryName: string }) => describe(`new Protocol(${str(remote.uri)})`, () => {
	let protocol: Protocol;
	before(() => protocol = new Protocol(remote.uri));

	it(`type should be ${ProtocolType[remote.expectedType]}`, () =>
		assert.equal(protocol.type, remote.expectedType));
	it(`host should be ${str(remote.expectedHost)}`, () =>
		assert.equal(protocol.host, remote.expectedHost));
	it(`owner should be ${str(remote.expectedOwner)}`, () =>
		assert.equal(protocol.owner, remote.expectedOwner));
	it(`repositoryName should be ${str(remote.expectedRepositoryName)}`, () =>
		assert.equal(protocol.repositoryName, remote.expectedRepositoryName));
});

describe('Protocol', () => {
	describe('with HTTP and HTTPS remotes', () =>
		[
			{ uri: 'http://rmacfarlane@github.com/Microsoft/vscode', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'http://rmacfarlane:password@github.com/Microsoft/vscode', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'http://rmacfarlane:password@www.github.com/Microsoft/vscode', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'http://github.com/Microsoft/vscode', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'http://github.com/Microsoft/vscode.git', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'http://www.github.com/Microsoft/vscode.git', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'http://github.com:/Microsoft/vscode.git', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'http://github.com:433/Microsoft/vscode.git', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'https://rmacfarlane@github.com/Microsoft/vscode', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'https://rmacfarlane:password@github.com/Microsoft/vscode', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'https://github.com/Microsoft/vscode', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'https://github.com/Microsoft/vscode.git', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'https://github.com:/Microsoft/vscode.git', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'https://github.com:433/Microsoft/vscode.git', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'https://www.github.com:433/Microsoft/vscode.git', expectedType: ProtocolType.HTTP, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'https://github.enterprise.corp/Microsoft/vscode.git', expectedType: ProtocolType.HTTP, expectedHost: 'github.enterprise.corp', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' }
		].forEach(testRemote)
	);

	it('should handle SSH remotes', () =>
		[
			{ uri: 'ssh://git@github.com/Microsoft/vscode', expectedType: ProtocolType.SSH, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'ssh://github.com:Microsoft/vscode.git', expectedType: ProtocolType.SSH, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'ssh://git@github.com:433/Microsoft/vscode', expectedType: ProtocolType.SSH, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'ssh://user@git.server.org:project.git', expectedType: ProtocolType.SSH, expectedHost: 'git.server.org', expectedOwner: '', expectedRepositoryName: 'project' }

		].forEach(testRemote)
	);

	it('should handle SCP-like remotes', () =>
		[
			{ uri: 'git@github.com:Microsoft/vscode', expectedType: ProtocolType.SSH, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'git@github.com:Microsoft/vscode.git', expectedType: ProtocolType.SSH, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'github.com:Microsoft/vscode.git', expectedType: ProtocolType.SSH, expectedHost: 'github.com', expectedOwner: 'Microsoft', expectedRepositoryName: 'vscode' },
			{ uri: 'user@git.server.org:project.git', expectedType: ProtocolType.SSH, expectedHost: 'git.server.org', expectedOwner: '', expectedRepositoryName: 'project' },
			{ uri: 'git.server2.org:project.git', expectedType: ProtocolType.SSH, expectedHost: 'git.server2.org', expectedOwner: '', expectedRepositoryName: 'project' }
		].forEach(testRemote)
	);

	it('should handle local remotes', () =>
		[
			{ uri: '/opt/git/project.git', expectedType: ProtocolType.Local, expectedHost: '', expectedOwner: '', expectedRepositoryName: '' },
			{ uri: 'file:///opt/git/project.git', expectedType: ProtocolType.Local, expectedHost: '', expectedOwner: '', expectedRepositoryName: '' }
		].forEach(testRemote)
	);

	describe('toString when generating github remotes', () =>
		[
			{ uri: 'ssh://git@github.com/Microsoft/vscode', expected: 'git@github.com:Microsoft/vscode' },
			{ uri: 'ssh://github.com:Microsoft/vscode.git', expected: 'git@github.com:Microsoft/vscode' },
			{ uri: 'ssh://git@github.com:433/Microsoft/vscode', expected: 'git@github.com:Microsoft/vscode' },
		].forEach(remote =>
			it(`should generate "${remote.expected}" from "${remote.uri}`, () =>
				assert.equal(new Protocol(remote.uri).toString(), remote.expected))
		)
	);

	describe('Protocol.update when changing protocol type to SSH', () =>
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
		].forEach(remote =>
			it(`should change "${remote.uri}" to "${remote.expected}"`, () => {
				const protocol = new Protocol(remote.uri);
				protocol.update(remote.change);
				assert.equal(protocol.toString(), remote.expected);
			})
		)
	);

	describe('with a ~/.ssh/config', () => {
		before(() =>
			ssh.Resolvers.current = ssh.Resolvers.fromConfig(SSH_CONFIG_WITH_HOST_ALIASES));
		after(() =>
			ssh.Resolvers.current = ssh.Resolvers.default);

		testRemote({
			uri: 'gh_cap:queerviolet/vscode',
			expectedType: ProtocolType.SSH,
			expectedHost: 'github.com',
			expectedOwner: 'queerviolet',
			expectedRepositoryName: 'vscode'
		});

		testRemote({
			uri: 'gh_nocap:queerviolet/vscode',
			expectedType: ProtocolType.SSH,
			expectedHost: 'github.com',
			expectedOwner: 'queerviolet',
			expectedRepositoryName: 'vscode'
		});
	});
});