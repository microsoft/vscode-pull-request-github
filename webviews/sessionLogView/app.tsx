/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { shikiToMonaco } from '@shikijs/monaco';
import * as monaco from 'monaco-editor';
import * as React from 'react';
import { createHighlighter } from 'shiki';
import { ChangeThemeMessage, InitMessage } from './messages';
import { parseSessionLogs, SessionInfo, SessionResponseLogChunk } from './sessionsApi';
import { SessionView } from './sessionView';

const themeName = 'vscode-theme';

type SessionViewState =
	{ state: 'loading' }
	| { state: 'ready'; readonly info: SessionInfo; readonly logs: SessionResponseLogChunk[]; themeData: any }


export function App() {
	const [state, setState] = React.useState<SessionViewState>({ state: 'loading' });

	React.useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data as InitMessage | ChangeThemeMessage;
			switch (message?.type) {
				case 'init': {
					init(message);
					break;
				}
				case 'changeTheme': {
					registerMonacoTheme(message.themeData);
					break;
				}
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

	async function init(message: InitMessage) {
		await registerMonacoTheme(message.themeData);

		setState({
			state: 'ready',
			info: message.info,
			logs: parseSessionLogs(message.logs),
			themeData: message.themeData,
		});
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
