/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Schemes, toGitHubUri } from '../common/uri';

export interface Conflict {
	prHeadFilePath: string;
	contentsConflict: boolean;
	filePathConflict: boolean;
	modeConflict: boolean;
}

export interface ResolvedConflict {
	prHeadFilePath: string;
	resolvedContents?: string;
	// The other two fields can be added later. To begin with, we only support resolving the contents.
	// resolvedFilePath: string;
	// resolvedMode: string;
}

export class ConflictResolutionModel {
	private _startingConflicts: Map<string, Conflict> = new Map();
	private readonly _resolvedConflicts: Map<string, ResolvedConflict> = new Map();
	private readonly _onAddedResolution: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
	public readonly onAddedResolution: vscode.Event<void> = this._onAddedResolution.event;
	public readonly mergeScheme = `${Schemes.MergeOutput}-${new Date().getTime()}`;

	constructor(public readonly startingConflicts: Conflict[], public readonly repositoryName: string, public readonly prBaseOwner: string,
		public readonly latestPrBaseSha: string,
		public readonly prHeadOwner: string, public readonly prHeadBranchName: string,
		public readonly prBaseBranchName: string, public readonly prMergeBaseRef: string) {

		for (const conflict of startingConflicts) {
			this._startingConflicts.set(conflict.prHeadFilePath, conflict);
		}
	}

	isResolvable(): boolean {
		return Array.from(this._startingConflicts.values()).every(conflict => {
			return !conflict.filePathConflict && !conflict.modeConflict;
		});
	}

	addResolution(filePath: string, contents: string): void {
		this._resolvedConflicts.set(filePath, { prHeadFilePath: filePath, resolvedContents: contents });
		this._onAddedResolution.fire();
	}

	isResolved(filePath: string): boolean {
		if (!this._startingConflicts.has(filePath)) {
			throw new Error('Not a conflict file');
		}
		return this._resolvedConflicts.has(filePath);
	}

	get areAllConflictsResolved(): boolean {
		return this._resolvedConflicts.size === this._startingConflicts.size;
	}

	get resolvedConflicts(): Map<string, ResolvedConflict> {
		if (this._resolvedConflicts.size !== this._startingConflicts.size) {
			throw new Error('Not all conflicts have been resolved');
		}
		return this._resolvedConflicts;
	}

	public mergeOutputUri(conflict: Conflict) {
		return vscode.Uri.parse(`${this.mergeScheme}:/${conflict.prHeadFilePath}`);
	}

	public mergeBaseUri(conflict: { prHeadFilePath: string }): vscode.Uri {
		const fileUri = vscode.Uri.file(conflict.prHeadFilePath);
		return toGitHubUri(fileUri, Schemes.GithubPr, { fileName: conflict.prHeadFilePath, branch: this.prMergeBaseRef, owner: this.prBaseOwner });
	}

	public baseUri(conflict: Conflict): vscode.Uri {
		const fileUri = vscode.Uri.file(conflict.prHeadFilePath);
		return toGitHubUri(fileUri, Schemes.GithubPr, { fileName: conflict.prHeadFilePath, branch: this.latestPrBaseSha, owner: this.prBaseOwner });
	}

	public prHeadUri(conflict: Conflict): vscode.Uri {
		const fileUri = vscode.Uri.file(conflict.prHeadFilePath);
		return toGitHubUri(fileUri, Schemes.GithubPr, { fileName: conflict.prHeadFilePath, branch: this.prHeadBranchName, owner: this.prHeadOwner });
	}
}