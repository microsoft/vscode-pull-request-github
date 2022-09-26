/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { commands } from './executeCommands';

export const PULL_REQUEST_OVERVIEW_VIEW_TYPE = 'PullRequestOverview';

export interface IRequestMessage<T> {
	req: string;
	command: string;
	args: T;
}

export interface IReplyMessage {
	seq?: string;
	err?: any;
	res?: any;
}

export function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

export class WebviewBase {
	protected _webview?: vscode.Webview;
	protected _disposables: vscode.Disposable[] = [];

	private _waitForReady: Promise<void>;
	private _onIsReady: vscode.EventEmitter<void> = new vscode.EventEmitter();

	protected readonly MESSAGE_UNHANDLED: string = 'message not handled';

	constructor() {
		this._waitForReady = new Promise(resolve => {
			const disposable = this._onIsReady.event(() => {
				disposable.dispose();
				resolve();
			});
		});
	}

	public initialize(): void {
		const disposable = this._webview?.onDidReceiveMessage(
			async message => {
				await this._onDidReceiveMessage(message);
			},
			null,
			this._disposables,
		);
		if (disposable) {
			this._disposables.push(disposable);
		}
	}

	protected async _onDidReceiveMessage(message: IRequestMessage<any>): Promise<any> {
		switch (message.command) {
			case 'ready':
				this._onIsReady.fire();
				return;
			default:
				return this.MESSAGE_UNHANDLED;
		}
	}

	protected async _postMessage(message: any) {
		// Without the following ready check, we can end up in a state where the message handler in the webview
		// isn't ready for any of the messages we post.
		await this._waitForReady;
		this._webview?.postMessage({
			res: message,
		});
	}

	protected async _replyMessage(originalMessage: IRequestMessage<any>, message: any) {
		const reply: IReplyMessage = {
			seq: originalMessage.req,
			res: message,
		};
		this._webview?.postMessage(reply);
	}

	protected async _throwError(originalMessage: IRequestMessage<any>, error: any) {
		const reply: IReplyMessage = {
			seq: originalMessage.req,
			err: error,
		};
		this._webview?.postMessage(reply);
	}

	public dispose() {
		this._disposables.forEach(d => d.dispose());
	}
}

export class WebviewViewBase extends WebviewBase {
	public readonly viewType: string;
	protected _view?: vscode.WebviewView;

	constructor(
		protected readonly _extensionUri: vscode.Uri) {
		super();
	}

	protected resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken) {
		this._view = webviewView;
		this._webview = webviewView.webview;
		super.initialize();
		webviewView.webview.options = {
			// Allow scripts in the webview
			enableScripts: true,

			localResourceRoots: [this._extensionUri],
		};
		this._disposables.push(this._view.onDidDispose(() => {
			this._webview = undefined;
			this._view = undefined;
		}));
	}

	public show() {
		if (this._view) {
			this._view.show();
		} else {
			commands.focusView(this.viewType);
		}
	}
}
