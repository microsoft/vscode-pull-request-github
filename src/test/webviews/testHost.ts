/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach } from 'mocha';
import { createWebviewHost, WebviewHost, WebviewTransport } from '../../../webviews/common/host';

const hosts = new Set<WebviewHost>();

export function createTestHost(state?: unknown, transport?: WebviewTransport): WebviewHost {
	const host = createWebviewHost(transport);
	if (state !== undefined) {
		host.setState(state);
	}
	hosts.add(host);
	return host;
}

afterEach(() => {
	for (const host of hosts) {
		host.dispose();
	}
	hosts.clear();
});
