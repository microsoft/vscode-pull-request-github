/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineFixture, defineFixtureGroup, defineFixtureVariants, SingleFixtureExport } from '@vscode/component-explorer';
import { applyTheme, getTheme, parseCatalog, Theme } from '@vscode/webview-themes';
import catalogData from '@vscode/webview-themes/catalog.json';
import dayjs from 'dayjs';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { z } from 'zod';
import { createPullRequest, fixtureNow } from './data';
import themeStyles from './theme.css?inline';
import extensionManifest from '../../package.json';
import { MergeQueueState } from '../../src/github/interface';
import { PullRequest } from '../../src/github/views';
import activityBarStyles from '../activityBarView/index.css?inline';
import commonStyles from '../common/common.css?inline';
import PullRequestContext, { PRContext } from '../common/context';
import { ViewportWidthContext } from '../common/hooks';
import { createWebviewHost, ReplyMessage, RequestMessage, WebviewTransport } from '../common/host';
import { TimestampFormat, TimestampFormatContext } from '../components/timestamp';
import createStyles from '../createPullRequestViewNew/index.css?inline';
import overviewStyles from '../editorWebview/index.css?inline';

export { defineFixtureGroup };

export enum FixtureTheme {
	Dark = 'dark',
	Light = 'light',
}

const themeCatalog = parseCatalog(catalogData);
const themeSchema = z.enum([FixtureTheme.Dark, FixtureTheme.Light, ...themeCatalog.themes.map(theme => theme.id)]);

function resolveTheme(id: string): Theme {
	return getTheme(themeCatalog, id === FixtureTheme.Dark ? 'Dark Modern' : id === FixtureTheme.Light ? 'Light Modern' : id);
}

function isDarkTheme(theme: Theme): boolean {
	return theme.kind === 'vscode-dark' || theme.kind === 'vscode-high-contrast';
}

function applyExtensionColors(root: HTMLElement, theme: Theme): void {
	const kind = theme.kind === 'vscode-high-contrast-light' ? 'highContrastLight'
		: theme.kind === 'vscode-high-contrast' ? 'highContrast'
			: theme.kind === 'vscode-dark' ? 'dark' : 'light';
	for (const color of extensionManifest.contributes.colors) {
		const value = color.defaults[kind];
		root.style.setProperty(`--vscode-${color.id.replace('.', '-')}`,
			value.startsWith('#') ? value : `var(--vscode-${value.replace('.', '-')})`);
	}
}

export function defineThemeVariants(createFixture: (defaultTheme: FixtureTheme) => SingleFixtureExport) {
	return defineFixtureVariants({
		Dark: createFixture(FixtureTheme.Dark),
		Light: createFixture(FixtureTheme.Light),
	});
}

export type FixtureCommandHandler = (request: RequestMessage, pr: PullRequest) => unknown | Promise<unknown>;

interface PullRequestFixtureOptions {
	readonly width: number;
	readonly height?: number;
	readonly viewportHeight?: number;
	readonly defaultTheme?: FixtureTheme;
	readonly view?: 'overview' | 'component' | 'activityBar' | 'create';
	readonly createPullRequest: () => PullRequest;
	readonly render: (pr: PullRequest) => React.ReactElement;
	readonly handleCommand?: FixtureCommandHandler;
	readonly prepare?: (container: HTMLElement) => void | Promise<void>;
}

const timestampFormat: TimestampFormat = {
	relative: date => dayjs(date).from(dayjs(fixtureNow)),
	title: date => new Date(date).toISOString(),
};

const viewStyles = {
	overview: overviewStyles,
	component: overviewStyles,
	activityBar: activityBarStyles,
	create: createStyles,
};

interface ComponentFixtureOptions extends Omit<PullRequestFixtureOptions, 'width' | 'height' | 'createPullRequest'> {
	readonly width?: number;
	readonly height?: number;
	readonly createPullRequest?: () => PullRequest;
}

export function defineComponentFixture(options: ComponentFixtureOptions) {
	return definePullRequestFixture({
		width: 720,
		view: 'component',
		...options,
		createPullRequest: options.createPullRequest ?? createPullRequest,
	});
}

export function clickFixtureElement(selector: string): (container: HTMLElement) => Promise<void> {
	return async container => {
		await new Promise<void>(resolve => container.ownerDocument.defaultView!.setTimeout(resolve, 0));
		const element = container.querySelector<HTMLElement>(selector);
		if (!element) {
			throw new Error(`Fixture element not found: ${selector}`);
		}
		element.click();
		await new Promise<void>(resolve => container.ownerDocument.defaultView!.setTimeout(resolve, 0));
	};
}

export function definePullRequestFixture(options: PullRequestFixtureOptions) {
	const styles = [commonStyles, viewStyles[options.view ?? 'overview'], themeStyles]
		.join('\n')
		.replace(/(^|[\s,>+~])(?:html|body)(?=[\s.{:#>+~])/gm, '$1.fixture-root')
		.replace(/#app\b/g, '.fixture-root')
		.replace(/@media\s*(\(max-width:\s*\d+px\))/g, '@container fixture $1');
	const defaultTheme = options.defaultTheme ?? FixtureTheme.Dark;
	return defineFixture({
		isolation: 'none',
		background: defaultTheme,
		inputSchema: z.object({
			theme: themeSchema.default(defaultTheme),
		}),
		inputControls: {
			theme: { placement: 'both', label: 'Theme' },
		},
		displayMode: { type: 'component' },
		labels: ['.screenshot'],
		render: (container, renderContext) => {
			const viewport = container.ownerDocument.createElement('div');
			viewport.style.width = `${options.width}px`;
			viewport.style.containerType = 'inline-size';
			viewport.style.containerName = 'fixture';
			viewport.style.contain = 'layout paint';
			const stylesheet = container.ownerDocument.createElement('style');
			stylesheet.textContent = `@scope {
				${styles}
			}`;
			viewport.appendChild(stylesheet);
			container.appendChild(viewport);
			let theme = resolveTheme(themeSchema.parse(renderContext.input.theme));
			const pr = { ...options.createPullRequest(), isDarkTheme: isDarkTheme(theme) };
			const transport = new FixtureTransport(pr, options.handleCommand);
			const host = createWebviewHost(transport);
			const context = new PRContext(host);
			const root = container.ownerDocument.createElement('div');
			root.className = `fixture-root fixture-view-${options.view ?? 'overview'}`;
			const themeController = applyTheme(root, theme);
			applyExtensionColors(root, theme);
			root.style.width = `${options.width}px`;
			if (options.height !== undefined) {
				root.style.minHeight = `${options.height}px`;
			}
			if (options.viewportHeight !== undefined) {
				root.style.height = `${options.viewportHeight}px`;
				root.style.overflow = 'auto';
			}
			if (options.view && options.view !== 'overview') {
				root.style.display = 'flow-root';
			}
			viewport.appendChild(root);
			let disposed = false;
			let themeWatcher: { dispose(): void } | undefined;
			const dispose = () => {
				if (disposed) {
					return;
				}
				disposed = true;
				renderContext.signal.removeEventListener('abort', dispose);
				themeWatcher?.dispose();
				ReactDOM.unmountComponentAtNode(root);
				context.dispose();
				host.dispose();
				transport.dispose();
				themeController.dispose();
				viewport.remove();
			};
			const render = () => {
				if (!disposed) {
					ReactDOM.render(
						<PullRequestContext.Provider value={context}>
							<ViewportWidthContext.Provider value={options.width}>
								<TimestampFormatContext.Provider value={timestampFormat}>
									{options.render(context.pr!)}
								</TimestampFormatContext.Provider>
							</ViewportWidthContext.Provider>
						</PullRequestContext.Provider>,
						root,
					);
				}
			};
			context.onchange = render;
			renderContext.signal.addEventListener('abort', dispose, { once: true });
			try {
				if (renderContext.signal.aborted) {
					dispose();
					return { dispose };
				}
				render();
				themeWatcher = renderContext.watchInput('theme', value => {
					const nextTheme = resolveTheme(themeSchema.parse(value));
					if (!disposed && theme !== nextTheme) {
						theme = nextTheme;
						themeController.setTheme(theme);
						applyExtensionColors(root, theme);
						context.updatePR({ isDarkTheme: isDarkTheme(theme) });
					}
				});
				const ready = options.prepare ? Promise.resolve(options.prepare(root)) : undefined;
				return { dispose, ready };
			} catch (error) {
				dispose();
				throw error;
			}
		},
	});
}

class FixtureTransport implements WebviewTransport {
	private _state: unknown;
	private readonly _listeners = new Set<(message: ReplyMessage) => void>();
	private _disposed = false;

	constructor(private readonly _pr: PullRequest, private readonly _handler?: FixtureCommandHandler) {
		this._state = _pr;
	}

	getState<T>(): T | undefined {
		return this._state as T | undefined;
	}

	setState<T>(state: T): void {
		this._state = state;
	}

	onMessage(listener: (message: ReplyMessage) => void): () => void {
		this._listeners.add(listener);
		return () => this._listeners.delete(listener);
	}

	postMessage(request: RequestMessage): void {
		Promise.resolve().then(() => this._handler ? this._handler(request, this._pr) : defaultCommand(request, this._pr))
			.then(res => this._respond({ seq: request.req, res }), error => this._respond({
				seq: request.req, err: error instanceof Error ? error.message : String(error),
			}));
	}

	dispose(): void {
		this._disposed = true;
		this._listeners.clear();
		this._state = undefined;
	}

	private _respond(response: ReplyMessage): void {
		if (!this._disposed) {
			this._listeners.forEach(listener => listener(response));
		}
	}
}

export function defaultCommand(request: RequestMessage, pr: PullRequest): unknown {
	switch (request.command) {
		case 'pr.checkMergeability':
			return { mergeability: pr.mergeable };
		case 'pr.update-stack':
			return { updatedPullRequests: pr.stack?.pullRequests.map(entry => entry.number) ?? [] };
		case 'pr.unstack-all':
			return { cancelled: false, remainingPullRequests: [] };
		case 'pr.merge-stack':
			return { status: 'pending' };
		case 'pr.readyForReview':
			return { isDraft: false, mergeable: pr.mergeable, allowAutoMerge: pr.allowAutoMerge };
		case 'pr.update-automerge': {
			const args = request.args;
			if (!args || typeof args !== 'object') {
				throw new Error('Fixture auto-merge command requires options');
			}
			const options = args as Record<string, unknown>;
			const autoMerge = options.autoMerge !== undefined ? options.autoMerge : !!pr.autoMerge;
			const autoMergeMethod = options.autoMergeMethod !== undefined ? options.autoMergeMethod : pr.autoMergeMethod ?? pr.defaultMergeMethod;
			if (typeof autoMerge !== 'boolean' || (autoMergeMethod !== 'merge' && autoMergeMethod !== 'squash' && autoMergeMethod !== 'rebase')) {
				throw new Error('Invalid fixture auto-merge options');
			}
			return autoMerge ? { autoMerge, autoMergeMethod } : { autoMerge: false };
		}
		case 'pr.update-branch':
			return { events: pr.events, mergeable: pr.mergeable, canUpdateBranch: false };
		case 'pr.dequeue':
			return true;
		case 'pr.enqueue':
			return {
				mergeQueueEntry: pr.mergeQueueEntry ? { ...pr.mergeQueueEntry } : {
					position: 1,
					state: MergeQueueState.AwaitingChecks,
					url: `https://github.com/${pr.owner}/${pr.repo}/queue/${encodeURIComponent(pr.base)}`,
				},
			};
		case 'pr.re-request-review':
			return {
				reviewers: pr.reviewers.map(review => review.reviewer.id === request.args ? { ...review, state: 'REQUESTED' } : { ...review }),
			};
		case 'pr.openOnGitHub':
		case 'pr.view-check-logs':
		case 'pr.copy-prlink':
		case 'pr.openCommitChanges':
		case 'pr.open-session-log':
		case 'pr.gotoChangesSinceReview':
			return undefined;
		default:
			throw new Error(`No fixture response configured for ${request.command}`);
	}
}
