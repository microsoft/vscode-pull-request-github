/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { shikiToMonaco } from '@shikijs/monaco';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import * as React from 'react';
import { createHighlighter } from 'shiki';
import { parseSessionLogs, SessionResponseLogChunk } from '../../common/sessionParsing';
import { vscode } from '../common/message';
import type * as messages from './messages';
import { SessionInfo, SessionSetupStepResponse } from './sessionsApi';
import { SessionView } from './sessionView';

const themeName = 'vscode-theme';

type SessionViewState =
	| { state: 'loading' }
	| { state: 'ready'; readonly info: SessionInfo; readonly logs: readonly SessionResponseLogChunk[]; readonly pullInfo: messages.PullInfo | undefined; readonly setupSteps?: readonly SessionSetupStepResponse[] }
	| { state: 'error'; readonly url: string | undefined }
	;

export function App() {
	const [state, setState] = React.useState<SessionViewState>({ state: 'loading' });

	React.useEffect(() => {
		let themeP: Promise<void> | undefined;
		const handleMessage = async (event: MessageEvent) => {
			const message = event.data as messages.InitMessage | messages.ChangeThemeMessage | messages.LoadedMessage | messages.UpdateMessage | messages.ErrorMessage | messages.ResetMessage;
			switch (message?.type) {
				case 'init': {
					themeP = registerMonacoTheme(message.themeData);
					break;
				}
				case 'reset': {
					setState({ state: 'loading' });
					break;
				}
				case 'loaded':
				case 'update': {
					const state: messages.WebviewState = {
						sessionId: message.info.id,
						pullInfo: message.pullInfo,
					};
					vscode.setState(state);

					await themeP;
					setState({
						state: 'ready',
						info: message.info,
						logs: parseSessionLogs(message.logs),
						pullInfo: message.pullInfo,
						setupSteps: message.setupSteps
					});
					break;
				}
				case 'changeTheme': {
					registerMonacoTheme(message.themeData);
					break;
				}
				case 'error': {
					setState({
						state: 'error',
						url: message.logsWebLink,
					});
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
	} else if (state.state === 'error') {
		return (
			<div className="error-view">
				<p>Failed to load session logs</p>
				{state.url && (
					<p>
						<a href={state.url}>Try viewing logs in your browser</a>. {/* CodeQL [SM01507] The url is a GitHub workflow run. */}
					</p>
				)}
			</div>
		);
	} else {
		return <SessionView info={state.info} logs={state.logs} pullInfo={state.pullInfo} setupSteps={state.setupSteps} />;
	}
}

async function registerMonacoTheme(themeData: any) {
	const langs = [
		'bash',
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

	const transparent = '#00000000';
	await highlighter.loadTheme({
		...themeData,
		name: themeName,
		bg: 'transparent', // Don't set a background color
		colors: {
			...(themeData.colors ?? {}),
			'editor.background': transparent,
			'editorGutter.background': transparent
		}
	});
	highlighter.setTheme(themeName);

	for (const lang of langs) {
		monaco.languages.register({ id: lang });
	}

	shikiToMonaco(highlighter, monaco);
}
