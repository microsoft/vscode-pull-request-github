/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ViewedState } from '../../common/comment';
import Logger, { PR_TREE } from '../../common/logger';
import { FILE_LIST_LAYOUT, HIDE_VIEWED_FILES, PR_SETTINGS_NAMESPACE, SHOW_ONLY_OWNED_FILES } from '../../common/settingKeys';
import { compareIgnoreCase } from '../../common/utils';
import { PullRequestModel } from '../../github/pullRequestModel';
import { ReviewModel } from '../reviewModel';
import { DirectoryTreeNode } from './directoryTreeNode';
import { GitFileChangeNode } from './fileChangeNode';
import { LabelOnlyNode, TreeNode, TreeNodeParent } from './treeNode';

export class FilesCategoryNode extends TreeNode implements vscode.TreeItem {
	public override readonly label: string = vscode.l10n.t('Files');
	public collapsibleState: vscode.TreeItemCollapsibleState;
	private directories: TreeNode[] = [];

	constructor(
		parent: TreeNodeParent,
		private _reviewModel: ReviewModel,
		private _pullRequestModel: PullRequestModel
	) {
		super(parent);
		this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
		this.childrenDisposables = [];
		this.childrenDisposables.push(this._reviewModel.onDidChangeLocalFileChanges(() => {
			Logger.appendLine(`Local files have changed, refreshing Files node`, PR_TREE);
			this.refresh(this);
		}));
		this.childrenDisposables.push(_pullRequestModel.onDidChangeReviewThreads(() => {
			Logger.appendLine(`Review threads have changed, refreshing Files node`, PR_TREE);
			this.refresh(this);
		}));
		this.childrenDisposables.push(_pullRequestModel.onDidChange(e => {
			if (e.comments) {
				Logger.appendLine(`Comments have changed, refreshing Files node`, PR_TREE);
				this.refresh(this);
			}
		}));
		this.childrenDisposables.push(_pullRequestModel.onDidChangeFileViewedState(() => {
			Logger.appendLine(`File viewed state has changed, refreshing Files node`, PR_TREE);
			this.refresh(this);
		}));
		this.childrenDisposables.push(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(`${PR_SETTINGS_NAMESPACE}.${HIDE_VIEWED_FILES}`)
				|| e.affectsConfiguration(`${PR_SETTINGS_NAMESPACE}.${SHOW_ONLY_OWNED_FILES}`)) {
				Logger.appendLine(`File filter setting has changed, refreshing Files node`, PR_TREE);
				this.refresh(this);
			}
		}));
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	private async filterByCodeowners(files: GitFileChangeNode[]): Promise<GitFileChangeNode[]> {
		const { getOwnersForPath, isOwnedByUser } = await import('../../common/codeowners');
		const ghRepo = this._pullRequestModel.githubRepository;
		const baseRef = this._pullRequestModel.base.sha;
		const [entries, user, teamSlugs] = await Promise.all([
			ghRepo.getCodeownersEntries(baseRef),
			ghRepo.getAuthenticatedUser(),
			ghRepo.getAuthenticatedUserTeamSlugs(),
		]);

		if (entries.length === 0) {
			Logger.appendLine('No CODEOWNERS file found, showing all files', PR_TREE);
			return files;
		}

		return files.filter(f => {
			const owners = getOwnersForPath(entries, f.fileName);
			return owners.length > 0 && isOwnedByUser(owners, user.login, teamSlugs);
		});
	}

	override async getChildren(): Promise<TreeNode[]> {
		super.getChildren(false);

		Logger.appendLine(`Getting children for Files node`, PR_TREE);
		if (!this._reviewModel.hasLocalFileChanges) {
			return new Promise<TreeNode[]>(resolve => {
				const promiseResolver = this._reviewModel.onDidChangeLocalFileChanges(() => {
					resolve([]);
					promiseResolver.dispose();
				});
			});
		}

		if (this._reviewModel.localFileChanges.length === 0) {
			return [new LabelOnlyNode(this, vscode.l10n.t('No changed files'))];
		}

		let nodes: TreeNode[];
		const config = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE);
		const layout = config.get<string>(FILE_LIST_LAYOUT);
		const hideViewedFiles = config.get<boolean>(HIDE_VIEWED_FILES, false);
		const showOnlyOwnedFiles = config.get<boolean>(SHOW_ONLY_OWNED_FILES, false);

		let filesToShow = hideViewedFiles
			? this._reviewModel.localFileChanges.filter(f => f.changeModel.viewed !== ViewedState.VIEWED)
			: [...this._reviewModel.localFileChanges];

		if (filesToShow.length === 0 && hideViewedFiles) {
			return [new LabelOnlyNode(this, vscode.l10n.t('All files viewed'))];
		}

		if (showOnlyOwnedFiles) {
			filesToShow = await this.filterByCodeowners(filesToShow);
			if (filesToShow.length === 0) {
				return [new LabelOnlyNode(this, vscode.l10n.t('No files owned by you'))];
			}
		}

		const dirNode = new DirectoryTreeNode(this, '');
		filesToShow.forEach(f => dirNode.addFile(f));
		dirNode.finalize();
		if (dirNode.label === '') {
			this.directories = dirNode._children;
		} else {
			this.directories = [dirNode];
		}

		if (layout === 'tree') {
			nodes = this.directories;
		} else {
			const fileNodes = [...filesToShow];
			fileNodes.sort((a, b) => compareIgnoreCase(a.fileChangeResourceUri.toString(), b.fileChangeResourceUri.toString()));
			fileNodes.forEach(fileNode => {
				fileNode.parent = this;
			});
			nodes = fileNodes;
		}
		Logger.appendLine(`Got all children for Files node`, PR_TREE);
		this._children = nodes;
		return nodes;
	}
}
