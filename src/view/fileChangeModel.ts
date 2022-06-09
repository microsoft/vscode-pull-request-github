/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ViewedState } from '../common/comment';
import { DiffHunk, parsePatch } from '../common/diffHunk';
import { GitChangeType, InMemFileChange, SimpleFileChange, SlimFileChange } from '../common/file';
import Logger from '../common/logger';
import { resolvePath, toPRUri, toReviewUri } from '../common/uri';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { IResolvedPullRequestModel, PullRequestModel } from '../github/pullRequestModel';

export abstract class FileChangeModel {
	protected _filePath: vscode.Uri;
	get filePath(): vscode.Uri {
		return this._filePath;
	}

	protected _parentFilePath: vscode.Uri;
	get parentFilePath(): vscode.Uri {
		return this._parentFilePath;
	}

	get status(): GitChangeType {
		return this.change.status;
	}

	get fileName(): string {
		return this.change.fileName;
	}

	get blobUrl(): string | undefined {
		return this.change.blobUrl;
	}

	private _viewed: ViewedState;
	get viewed(): ViewedState {
		return this._viewed;
	}

	updateViewed(viewed: ViewedState) {
		if (this._viewed === viewed) {
			return;
		}

		this._viewed = viewed;
	}

	async diffHunks(): Promise<DiffHunk[]> {
		let diffHunks: DiffHunk[] = [];

		if (this.status !== GitChangeType.RENAME) {
			try {
				const commit = this.sha ?? this.pullRequest.head!.sha;
				const patch = await this.folderRepoManager.repository.diffBetween(this.pullRequest.base.sha, commit, this.fileName);
				diffHunks = parsePatch(patch);
			} catch (e) {
				Logger.appendLine(`Failed to parse patch for outdated comments: ${e}`);
			}
		}
		return diffHunks;
	}

	constructor(public readonly pullRequest: PullRequestModel,
		protected readonly folderRepoManager: FolderRepositoryManager,
		public readonly change: SimpleFileChange,
		public readonly sha?: string) {	}
}

export class GitFileChangeModel extends FileChangeModel {
	constructor(
		folderRepositoryManager: FolderRepositoryManager,
		pullRequest: PullRequestModel,
		change: SimpleFileChange,
		filePath: vscode.Uri,
		parentFilePath: vscode.Uri,
		sha?: string
	) {
		super(pullRequest, folderRepositoryManager, change, sha);
		this._filePath = filePath;
		this._parentFilePath = parentFilePath;
	}
}

export class InMemFileChangeModel extends FileChangeModel {
	get previousFileName(): string | undefined {
		return this.change.previousFileName;
	}

	async isPartial(): Promise<boolean> {
		let originalFileExist = false;

		switch (this.change.status) {
			case GitChangeType.DELETE:
			case GitChangeType.MODIFY:
				try {
					await this.folderRepoManager.repository.getObjectDetails(this.change.baseCommit, this.change.fileName);
					originalFileExist = true;
				} catch (err) {
					/* noop */
				}
				break;
			case GitChangeType.RENAME:
				try {
					await this.folderRepoManager.repository.getObjectDetails(this.change.baseCommit, this.change.previousFileName!);
					originalFileExist = true;
				} catch (err) {
					/* noop */
				}
				break;
		}
		return !originalFileExist && (this.change.status !== GitChangeType.ADD);
	}

	get patch(): string {
		return this.change.patch;
	}

	async diffHunks(): Promise<DiffHunk[]> {
		return this.change.diffHunks;
	}

	constructor(folderRepositoryManager: FolderRepositoryManager,
		pullRequest: PullRequestModel & IResolvedPullRequestModel,
		public readonly change: InMemFileChange,
		isCurrentPR: boolean,
		mergeBase: string) {
		super(pullRequest, folderRepositoryManager, change);
		const headCommit = pullRequest.head!.sha;
		const parentFileName = change.status === GitChangeType.RENAME ? change.previousFileName! : change.fileName;
		const filePath = vscode.Uri.file(resolvePath(folderRepositoryManager.repository.rootUri, change.fileName));
		const parentPath = vscode.Uri.file(resolvePath(folderRepositoryManager.repository.rootUri, parentFileName));
		this._filePath = isCurrentPR ? ((change.status === GitChangeType.DELETE)
			? toReviewUri(filePath, undefined, undefined, '', false, { base: false }, folderRepositoryManager.repository.rootUri)
			: filePath)
			: toPRUri(
				filePath,
				pullRequest,
				change.baseCommit,
				headCommit,
				change.fileName,
				false,
				change.status,
			);
		this._parentFilePath = isCurrentPR ? (toReviewUri(
			parentPath,
			change.status === GitChangeType.RENAME ? change.previousFileName : change.fileName,
			undefined,
			change.status === GitChangeType.ADD ? '' : mergeBase,
			false,
			{ base: true },
			folderRepositoryManager.repository.rootUri,
		)) : toPRUri(
			parentPath,
			pullRequest,
			change.baseCommit,
			headCommit,
			change.fileName,
			true,
			change.status,
		);
	}
}

export class RemoteFileChangeModel extends FileChangeModel {
	public fileChangeResourceUri: vscode.Uri;
	public childrenDisposables: vscode.Disposable[] = [];

	get previousFileName(): string | undefined {
		return this.change.previousFileName;
	}

	get blobUrl(): string {
		return this.change.blobUrl;
	}

	constructor(
		folderRepositoryManager: FolderRepositoryManager,
		public readonly change: SlimFileChange,
		pullRequest: PullRequestModel,
	) {
		super(pullRequest, folderRepositoryManager, change);
		const headCommit = pullRequest.head!.sha;
		const parentFileName = change.status === GitChangeType.RENAME ? change.previousFileName! : change.fileName;
		this._filePath = toPRUri(
			vscode.Uri.file(
				resolvePath(folderRepositoryManager.repository.rootUri, change.fileName),
			),
			pullRequest,
			change.baseCommit,
			headCommit,
			change.fileName,
			false,
			change.status,
		);
		this._parentFilePath = toPRUri(
			vscode.Uri.file(
				resolvePath(folderRepositoryManager.repository.rootUri, parentFileName),
			),
			pullRequest,
			change.baseCommit,
			headCommit,
			change.fileName,
			true,
			change.status,
		);
	}
}