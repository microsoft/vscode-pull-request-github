/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GitFileChangeNode, RemoteFileChangeNode } from './treeNodes/fileChangeNode';

export class ReviewModel {
	private _localFileChangesMap: Map<string, GitFileChangeNode> | undefined;
	private _localFileChanges: GitFileChangeNode[] | undefined;
	private _onDidChangeLocalFileChanges: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public onDidChangeLocalFileChanges: vscode.Event<void> = this._onDidChangeLocalFileChanges.event;

	private _obsoleteFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[] = [];

	constructor() { }

	get hasLocalFileChanges() {
		return this._localFileChanges && (this._localFileChanges.length > 0);
	}

	get localFileChanges(): GitFileChangeNode[] {
		return this._localFileChanges ?? [];
	}

	set localFileChanges(localFileChanges: GitFileChangeNode[]) {
		this._localFileChangesMap = undefined;
		this._localFileChanges = localFileChanges;
		this._onDidChangeLocalFileChanges.fire();
	}

	get obsoleteFileChanges(): (GitFileChangeNode | RemoteFileChangeNode)[] {
		return this._obsoleteFileChanges;
	}

	set obsoleteFileChanges(obsoleteFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[]) {
		this._obsoleteFileChanges = obsoleteFileChanges;
	}

	get localFileChangesMap(): Map<string, GitFileChangeNode> {
		if (!this._localFileChangesMap) {
			this._localFileChangesMap = new Map();
			this._localFileChanges?.forEach(change => {
				this._localFileChangesMap?.set(change.fileName, change);
			});
		}
		return this._localFileChangesMap;
	}

	clear() {
		this.obsoleteFileChanges = [];
		this._localFileChanges = undefined;
	}
}