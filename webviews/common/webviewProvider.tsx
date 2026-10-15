/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { createWebviewHost, WebviewHost } from './host';

export function WebviewProvider<T extends { dispose(): void }>({ context, createContext, children }: {
	context: React.Context<T>;
	createContext: (host: WebviewHost) => T;
	children: React.ReactNode;
}) {
	const [owned] = React.useState(() => {
		const host = createWebviewHost();
		return { host, context: createContext(host) };
	});
	React.useLayoutEffect(() => () => {
		owned.context.dispose();
		owned.host.dispose();
	}, [owned]);
	return <context.Provider value={owned.context}>{children}</context.Provider>;
}
