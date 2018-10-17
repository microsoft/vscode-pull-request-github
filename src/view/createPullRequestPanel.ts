/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as path from 'path';
import * as vscode from 'vscode';
import { getNonce, titleAndBodyFrom } from '../common/utils';
import { IPullRequestManager } from '../github/interface';

import { Store, createStore, applyMiddleware, combineReducers } from 'redux';

import { CREATE, setRepository, SET_REPOSITORY, updateGitHubRemotes, UPDATE_GITHUB_REMOTES, PICK_LOCAL_BRANCH, setUpstream, SET_UPSTREAM, pickBranch, recvRemoteMetadata, RECV_REMOTE_METADATA, SET_TITLE, SET_BODY, setTitle, setBody, SET_BASE } from '~/shared/actions';
import { RefType, Repository } from '../typings/git';
import Logger from '../common/logger';
import { GitHubRepository } from '../github/githubRepository';
import { PullRequestsCreateParams } from '@octokit/rest';
import { byOwnerAndName } from '../github/pullRequestManager';

export class CreatePullRequestPanel {
	/**
	 * Track the currently panel. Only allow a single panel to exist at a time.
	 */
	public static current: CreatePullRequestPanel | undefined;

	private static readonly _viewType = 'CreatePullRequest';

	private readonly _panel: vscode.WebviewPanel;
	private _disposables: vscode.Disposable[] = [];

	private static _extensionPath: string | undefined;
	private static _manager: IPullRequestManager | undefined;
	private _store: Store;

	public static init(extensionPath: string, manager: IPullRequestManager) {
		this._extensionPath = extensionPath;
		this._manager = manager;
	}

	public static show() {
		const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

		// If we already have a panel, show it.
		// Otherwise, create a new panel.
		if (this.current) {
			return this.current._panel.reveal(column, true);
		}

		this.current = new CreatePullRequestPanel(column || vscode.ViewColumn.One);
	}

	private constructor(column: vscode.ViewColumn) {
		// Create and show a new webview panel
		this._panel = vscode.window.createWebviewPanel(
			CreatePullRequestPanel._viewType,
			'Create Pull Request', column, {
				// Enable javascript in the webview
				enableScripts: true,

				// And restric the webview to only loading content from our extension's `media` directory.
				localResourceRoots: [
					vscode.Uri.file(path.join(CreatePullRequestPanel._extensionPath, 'media'))
				]
			}
		);
		this._panel.webview.html = this.getHtml();

		// Listen for when the panel is disposed
		// This happens when the user closes the panel or when the panel is closed programatically
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		this.createStore();
	}

	public dispose() {
		CreatePullRequestPanel.current = undefined;

		// Clean up our resources
		this._panel.dispose();

		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}

	_sendState = () => {
		const state = this._store.getState();
		this._panel.webview.postMessage(state);
	}

	private createStore() {
		const { _manager } = CreatePullRequestPanel;
		const store = createStore(
			createPRReducer,
			applyMiddleware(
				createPRMiddleware(_manager),
				_store => next => action => {
					Logger.appendLine(`------ ${action.type} -----`);
					next(action);
					Logger.appendLine(JSON.stringify(store.getState(), null, 2));
					Logger.appendLine(`------ </${action.type}> -----`);
				}
			));
		this._store = store;
		const unsubscribe = store.subscribe(this._sendState);
		this._disposables.push({ dispose() { unsubscribe(); } });

		_manager.onDidChangeRepository(
			repo => store.dispatch(setRepository(repo)),
			null,
			this._disposables);
		store.dispatch(setRepository(_manager.repository));
		_manager.onDidUpdateGitHubRemotes(
			remotes => store.dispatch(updateGitHubRemotes(remotes)),
			null,
			this._disposables);
		_manager.updateRepositories();

		// Handle messages from the webview as actions
		this._panel.webview.onDidReceiveMessage(store.dispatch, store, this._disposables);
	}

	private getHtml() {
		const scriptPathOnDisk = vscode.Uri.file(path.join(CreatePullRequestPanel._extensionPath, 'media', 'create.js'));
		const scriptUri = scriptPathOnDisk.with({ scheme: 'vscode-resource' });
		const nonce = getNonce();

		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https:; script-src 'nonce-${nonce}'; style-src vscode-resource: 'unsafe-inline' http: https: data:;">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>Create Pull Request</title>
			</head>
			<body>
				<div id=main></div>
				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
	}
}

const createPRMiddleware = (manager: IPullRequestManager) => store => next => {
	manager.getHeadCommitMessage()
		.then(titleAndBodyFrom)
		.then(({title, body}) => {
			next(setTitle(title));
			next(setBody(body));
		})
		.catch(error => {
			Logger.appendLine(error.message);
		});

	return async action => {
		const result = next(action);
		switch (action.type) {
		case CREATE:
			const {willPush, willCreatePR} = store.getState();
			if (!willPush || !willCreatePR) { break; }
			const {data: rsp} = await manager.createPullRequest(willPush.localBranch, willCreatePR.params);
			Logger.appendLine(JSON.stringify(rsp, null, 2));
			vscode.commands.executeCommand('pr.refreshList');
			const pr = await manager.findRepo(byOwnerAndName(
				rsp.base.repo.owner.login,
				rsp.base.repo.name))
				.getPullRequest(+rsp.number);
			vscode.commands.executeCommand('pr.openDescription', pr);
			break;
		case SET_REPOSITORY:
			const repo = action.repository as Repository;
			store.dispatch(pickBranch(repo.state.HEAD.name));
			break;
		case PICK_LOCAL_BRANCH:
			try {
				store.dispatch(setUpstream(await manager.getUpstream(action.branch)));
			} catch (noUpstream) {
				ensureUpstream(store);
			}
			break;
		case UPDATE_GITHUB_REMOTES:
			ensureUpstream(store);
			break;
		case SET_UPSTREAM:
			const md = await manager.getMetadata(action.upstream.remote);
			store.dispatch(recvRemoteMetadata(action.upstream.remote, md));
			break;
		}
		return result;
	};
};

const ensureUpstream = store => {
	const {
		selectedLocalBranch: {name: branch},
		gitHubRemotes: remotes
	}
		= store.getState().spec;
	if (!branch) { return; }
	if (!remotes || !Object.keys(remotes).length) { return; }
	if (remotes.origin) {
		store.dispatch(setUpstream({
			branch,
			remote: 'origin'
		}));
		return;
	}
	store.dispatch(setUpstream({
		branch,
		remote: Object.keys(remotes)[0],
	}));
};

const localBranches = (state=[], {type, repository}) =>
	type === SET_REPOSITORY
		? repository.state.refs
			.filter(r => r.type === RefType.Head && r.name)
			.map(r => r.name)
		: state;

const gitHubRemotes = (state={}, {type, remotes, remote, metadata}) =>
	type === SET_REPOSITORY
		? {}
		:
	type === UPDATE_GITHUB_REMOTES
		? (remotes as GitHubRepository[])
			.reduce((all, {remote: {remoteName, repositoryName, owner, host}}) =>
				Object.assign(all, {
					[remoteName]: {
						name: repositoryName,
						owner, host,
					}
				}), {})
		:
	type === RECV_REMOTE_METADATA
		? {...state, [remote]: {...state[remote], metadata}}
		:
		state;

const selectedLocalBranch = (state: any={}, {type, branch, upstream}) =>
	type === SET_REPOSITORY
		? {}
		:
	type === PICK_LOCAL_BRANCH
		? {name: branch, upstream: null}
		:
	type === SET_UPSTREAM
		? {...state, upstream}
		: state;

const titleReducer = (state='', {type, title}) =>
	type === SET_TITLE
		? title
		: state;

const bodyReducer = (state='', {type, body}) =>
	type === SET_BODY
		? body
		: state;

const parentIsBase = (state=false, {type, isParent}) =>
	type === SET_BASE
		? isParent
		: state;

const specification = combineReducers({
	title: titleReducer,
	body: bodyReducer,
	gitHubRemotes,
	localBranches,
	selectedLocalBranch,
	parentIsBase,
});

const errors = ({title: t, body: b, gitHubRemotes: ghRemotes, selectedLocalBranch: branch}) =>
	!t
		? { title: 'Enter a title' }
		:
	!b
		? { body: 'Enter a body' }
		:
	!branch || !branch.name
		? { selectedLocalBranch: 'Select a branch' }
		:
	!branch.upstream || !branch.upstream.remote
		? { selectedLocalBranch: 'Select a remote' }
		:
	!ghRemotes
		? { selectedLocalBranch: 'Fetching data...' }
		:
	!ghRemotes[branch.upstream.remote]
		? { selectedLocalBranch: 'Select a GitHub repository' }
		:
	!ghRemotes[branch.upstream.remote].metadata
		? { selectedLocalBranch: 'Waiting for repository metadata' }
		: null;

const generatePush = ({selectedLocalBranch: {name, upstream: {remote, branch}}}) => ({
	localBranch: name,
	remote,
	remoteBranch: branch
});

const generatePR = ({
	title, body,
	gitHubRemotes: remotes,
	selectedLocalBranch: branch,
	parentIsBase: isParent
}): {user: any, remote: string, params: PullRequestsCreateParams} => {
	const origin = remotes[branch.upstream.remote].metadata;
	const upstream = (isParent && origin.parent) ? origin.parent : origin;
	const base = upstream.default_branch as string;
	const head: string = upstream === origin
		? branch.name
		: `${origin.owner.login}:${branch.name}`;
	const repo: string = upstream.name;
	const owner: string = upstream.owner.login;
	return {
		user: origin.currentUser,
		remote: branch.upstream.remote,
		params: {title, body, base, head, repo, owner},
	};
};

const createPRReducer = (state: any={}, action) => {
	const spec = specification(state.spec, action);
	const derivedErrors = errors(spec);
	const willCreatePR = !derivedErrors && generatePR(spec);
	return {
		spec,
		errors: derivedErrors,
		willPush: !derivedErrors && generatePush(spec),
		willCreatePR,
	};
};