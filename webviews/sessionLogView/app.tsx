/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { InitMessage } from './messages';
import { parseSessionLogs, SessionInfo, SessionResponseLogChunk } from './sessionsApi';
import { SessionView } from './sessionView';

type SessionViewState =
	{ state: 'loading' }
	| { state: 'ready'; readonly info: SessionInfo; readonly logs: SessionResponseLogChunk[] }


export function App() {
	const [state, setState] = React.useState<SessionViewState>({ state: 'loading' });

	React.useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data as InitMessage;
			if (message && message.type === 'init') {
				setState({
					state: 'ready',
					info: message.info,
					logs: parseSessionLogs(message.logs),
				});
			}
		};

		window.addEventListener('message', handleMessage);
		return () => window.removeEventListener('message', handleMessage);
	}, []);

	if (state.state === 'loading') {
		return <div className="loading-indicator">Loading session logs...</div>;
	} else {
		return <SessionView info={state.info} logs={state.logs} />;
	}
}
