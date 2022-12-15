/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GitFileChangeNode, RemoteFileChangeNode } from './treeNodes/fileChangeNode';

export class ReviewModel {
	private _localFileChanges: GitFileChangeNode[] | undefined;
	private _onDidChangeLocalFileChanges: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public onDidChangeLocalFileChanges: vscode.Event<void> = this._onDidChangeLocalFileChanges.event;

	private _obsoleteFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[] = [];

	constructor() { }

	get hasLocalFileChanges() {
		return !!this._localFileChanges;
	}

	get localFileChanges(): GitFileChangeNode[] {
		return this._localFileChanges ?? [];
	}

	set localFileChanges(localFileChanges: GitFileChangeNode[]) {
		this._localFileChanges = localFileChanges;
		this._onDidChangeLocalFileChanges.fire();
	}

	get obsoleteFileChanges(): (GitFileChangeNode | RemoteFileChangeNode)[] {
		return this._obsoleteFileChanges;
	}

	set obsoleteFileChanges(obsoleteFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[]) {
		this._obsoleteFileChanges = obsoleteFileChanges;
	}

	clear() {
		this.obsoleteFileChanges = [];
		this._localFileChanges = undefined;
	}
}