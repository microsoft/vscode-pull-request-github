/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { shikiToMonaco } from '@shikijs/monaco';
import * as monaco from 'monaco-editor';
import * as React from 'react';
import { createHighlighter } from 'shiki';
import { SessionPullInfo } from '../../src/common/timelineEvent';
import { vscode } from '../common/message';
import type * as messages from './messages';
import { parseSessionLogs, SessionInfo, SessionResponseLogChunk } from './sessionsApi';
import { SessionView } from './sessionView';

const themeName = 'vscode-theme';

type SessionViewState =
	{ state: 'loading' }
	| { state: 'ready'; readonly info: SessionInfo; readonly logs: SessionResponseLogChunk[] }

export function App() {
	const [state, setState] = React.useState<SessionViewState>({ state: 'loading' });
	const [pullInfo, setPullInfo] = React.useState<SessionPullInfo | undefined>(undefined);

	React.useEffect(() => {
		let themeP: Promise<void> | undefined;
		const handleMessage = async (event: MessageEvent) => {
			const message = event.data as messages.InitMessage | messages.ChangeThemeMessage | messages.LoadedMessage;
			switch (message?.type) {
				case 'init': {
					themeP = registerMonacoTheme(message.themeData);
					const state: messages.WebviewState = {
						sessionId: message.sessionId,
						pullInfo: message.pullInfo,
					};
					vscode.setState(state);
					setPullInfo(message.pullInfo);
					break;
				}
				case 'loaded': {
					await themeP;
					setState({
						state: 'ready',
						info: message.info,
						logs: parseSessionLogs(message.logs),
					});
					break;
				}
				case 'changeTheme': {
					registerMonacoTheme(message.themeData);
					break;
				}
			}
		};

		window.addEventListener('message', handleMessage);

		vscode.postMessage({ type: 'ready' });

		return () => window.removeEventListener('message', handleMessage);
	}, []);

	if (state.state === 'loading') {
		return <div className="loading-indicator">Loading session logs...</div>;
	} else {
		return <SessionView info={state.info} logs={state.logs} pullInfo={pullInfo} />;
	}
}

async function registerMonacoTheme(themeData: any) {
	const langs = [
		'css',
		'html',
		'ini',
		'java',
		'lua',
		'makefile',
		'perl',
		'r',
		'ruby',
		'php',
		'sql',
		'xml',
		'xsl',
		'yaml',
		'clojure',
		'coffee',
		'c',
		'cpp',
		'diff',
		'dockerfile',
		'go',
		'groovy',
		'pug',
		'javascript',
		'json',
		'jsonc',
		'less',
		'objc',
		'swift',
		'scss',
		'perl6',
		'powershell',
		'python',
		'rust',
		'scala',
		'shellscript',
		'typescript',
		'csharp',
		'fsharp',
		'dart',
		'handlebars',
		'markdown',
	];

	const highlighter = await createHighlighter({
		themes: [],
		langs: langs,
	});

	await highlighter.loadTheme({
		...themeData,
		name: themeName,
		bg: 'transparent' // Don't set a background color
	});
	highlighter.setTheme(themeName);

	for (const lang of langs) {
		monaco.languages.register({ id: lang });
	}

	shikiToMonaco(highlighter, monaco);
}
