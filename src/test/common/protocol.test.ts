/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Protocol } from '../../common/protocol';

describe('Protocol', () => {
	it('should handle remote uris', () => {
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
			'https://github.com:433/Microsoft/vscode.git',
			'git@github.com:Microsoft/vscode',
			'git@github.com:Microsoft/vscode.git',
			'ssh://git@github.com/Microsoft/vscode',
			'git://github.com/Microsoft/vscode',
			'ssh://git@github.com:433/Microsoft/vscode',
			'git://github.com:433/Microsoft/vscode'
		].forEach(remoteUri => {
			const protocol = new Protocol(remoteUri);
			assert.equal(protocol.host, 'github.com');
			assert.equal(protocol.owner, 'Microsoft');
			assert.equal(protocol.repositoryName, 'vscode');
		});
	});
});