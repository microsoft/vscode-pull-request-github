/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import MarkdownIt from 'markdown-it';
import type monacoType from 'monaco-editor';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.main';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { Temporal } from 'temporal-polyfill';
import { vscode } from '../common/message';
import { CodeView } from './codeView';
import './index.css'; // Create this file for styling
import { PullInfo } from './messages';
import { parseDiff, type SessionInfo, type SessionResponseLogChunk } from './sessionsApi';

interface SessionViewProps {
	readonly pullInfo: PullInfo | undefined;
	readonly info: SessionInfo;
	readonly logs: readonly SessionResponseLogChunk[];
}

export const SessionView: React.FC<SessionViewProps> = (props) => {
	return (
		<div className="session-container">
			<SessionHeader info={props.info} pullInfo={props.pullInfo} />
			<SessionLog logs={props.logs} />
			{props.info.state === 'in_progress' && (
				<div className="session-in-progress-indicator">
					<span className="icon"><i className="codicon codicon-loading"></i></span>
					Session is in progress...</div>
			)}
		</div>
	);
};

// Session Header component
interface SessionHeaderProps {
	pullInfo: PullInfo | undefined;
	info: SessionInfo;
}

const SessionHeader: React.FC<SessionHeaderProps> = ({ info, pullInfo }) => {
	const createdAt = Temporal.Instant.from(info.created_at);
	const completedAt = info.completed_at ? Temporal.Instant.from(info.completed_at) : undefined;
	const duration = completedAt && completedAt.epochMilliseconds > 0
		? completedAt.since(createdAt, { smallestUnit: 'second', largestUnit: 'hour' })
		: undefined;

	return (
		<header className="session-header">
			<div className='session-header-title'>
				<h1>Coding Agent Session Log</h1>

				{pullInfo && <>
					<h2>
						<a onClick={() => {
							vscode.postMessage({ type: 'openPullRequestView' });
						}} title='Back to pull request'>
							<span className="icon"><i className={'codicon codicon-git-pull-request'}></i></span> {pullInfo.title} <span className="pull-request-id">#{pullInfo.pullId}</span>
						</a>
					</h2>

					<nav>
						<ul>
							<li>
								<button onClick={() => {
									vscode.postMessage({ type: 'openOnWeb' });
								}}>Open on GitHub</button>
							</li>
						</ul>
					</nav>
				</>}
			</div>

			<div className="session-header-info">
				<div className="session-status">
					<div className="session-label">Status</div>
					<div className="session-value">{info.state}</div>
				</div>

				{duration && (
					<div className="session-duration">
						<div className="session-label">Duration</div>
						<div className="session-value">{duration.toLocaleString()}</div>
					</div>
				)}

				<div className="session-premium">
					<div className="session-label">Premium requests</div>
					<div className="session-value">{info.premium_requests}</div>
				</div>
			</div>
		</header>
	);
};

// Session Log component
interface SessionLogProps {
	readonly logs: readonly SessionResponseLogChunk[];
}

const SessionLog: React.FC<SessionLogProps> = ({ logs }) => {
	const components = logs.flatMap(x => x.choices).map((choice, index) => {
		if (!choice.delta.content) {
			return;
		}
		if (choice.delta.role === 'assistant') {
			if (choice.finish_reason === 'stop' && choice.delta.content.startsWith('<pr_title>')) {
				return;
			} else {
				// For markdown content, use a custom renderer component
				return (
					<MarkdownContent
						key={`markdown-${index}`}
						content={choice.delta.content}
					/>
				);
			}
		} else {
			let name: string | undefined = undefined;
			if (!choice.delta.tool_calls?.length) {
				return;
			}

			const args = JSON.parse(choice.delta.tool_calls[0].function.arguments);
			name = choice.delta.tool_calls[0].function.name;

			if (name === 'str_replace_editor') {
				if (args.command === 'view') {
					const content = parseDiff(choice.delta.content);
					if (content) {
						const file = content.fileA ?? content.fileB;
						const lang = (file && getLanguageForResource(file)) ?? 'plaintext';

						return (
							<CodeView
								key={`view-${index}`}
								label="View"
								description={file && toFileLabel(file)}
								content={{ value: content.content, lang }}
							/>
						);
					}
				} else {
					return (
						<CodeView
							key={`edit-${index}`}
							label="Edit"
							description={args.path}
							content={{ value: choice.delta.content, lang: 'diff' }}
						/>
					);
				}
			} else if (name === 'think') {
				return (
					<CodeView
						key={`thought-${index}`}
						label="Thought"
						content={{ value: choice.delta.content, lang: 'markdown' }}
					/>
				);
			} else if (name === 'report_progress') {
				return (
					<CodeView
						key={`progress-${index}`}
						label="Progress Update"
						description={args.commitMessage}
						content={{ value: args.prDescription, lang: 'markdown' }}
					/>
				);
			} else if (name === 'bash') {
				return (
					<CodeView
						key={`bash-${index}`}
						label="Run Bash command"
						content={{ value: choice.delta.content, lang: 'markdown' }}
					/>
				);
			}

			return (
				<CodeView
					key={`unknown-${index}`}
					label={name ?? 'unknown'}
					content={{ value: choice.delta.content, lang: 'plaintext' }}
				/>
			);
		}
	});

	return <div className="session-log-container">{components}</div>;
};


// Custom component for rendering markdown content
interface MarkdownContentProps {
	content: string;
}

const MarkdownContent: React.FC<MarkdownContentProps> = ({ content }) => {
	const containerRef = React.useRef<HTMLDivElement>(null);
	const md = React.useMemo(() => {
		const mdInstance = new MarkdownIt();

		// Custom renderer for code blocks
		mdInstance.renderer.rules.fence = (tokens, idx) => {
			const token = tokens[idx];
			const code = token.content;
			const lang = token.info.trim() || 'plaintext';
			return `<div class="markdown-code-block" data-code="${encodeURIComponent(code)}" data-lang="${lang}"></div>`;
		};

		return mdInstance;
	}, []);

	React.useEffect(() => {
		if (!containerRef.current) return;

		// Render markdown
		containerRef.current.innerHTML = md.render(content);

		// Find all code blocks and render them using CodeView
		const codeBlocks = containerRef.current.querySelectorAll('.markdown-code-block');
		codeBlocks.forEach((block) => {
			const code = decodeURIComponent(block.getAttribute('data-code') || '');
			const lang = block.getAttribute('data-lang') || 'plaintext';

			const codeViewElement = document.createElement('div');
			block.replaceWith(codeViewElement);

			ReactDOM.render(
				<CodeView
					label="Code Block"
					content={{ value: code, lang }}
				/>,
				codeViewElement
			);
		});
	}, [content]);

	return <div className="markdown-content" ref={containerRef} />;
};

function getLanguageForResource(filePath: string): string | undefined {
	const langs = (monaco.languages as typeof monacoType.languages).getLanguages();
	for (const lang of langs) {
		if (lang.extensions && lang.extensions.some(ext => filePath.endsWith(ext))) {
			return lang.id;
		}
	}
	return undefined;
}


function toFileLabel(file: string): string {
	const parts = file.split('/');
	return parts.slice(5).join('/');
}
