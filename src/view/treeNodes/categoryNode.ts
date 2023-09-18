/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AuthenticationError } from '../../common/authentication';
import { PR_SETTINGS_NAMESPACE, QUERIES } from '../../common/settingKeys';
import { ITelemetry } from '../../common/telemetry';
import { formatError } from '../../common/utils';
import { FolderRepositoryManager, ItemsResponseResult } from '../../github/folderRepositoryManager';
import { PRType } from '../../github/interface';
import { NotificationProvider } from '../../github/notifications';
import { PullRequestModel } from '../../github/pullRequestModel';
import { PrsTreeModel } from '../prsTreeModel';
import { PRNode } from './pullRequestNode';
import { TreeNode, TreeNodeParent } from './treeNode';

export enum PRCategoryActionType {
	Empty,
	More,
	TryOtherRemotes,
	Login,
	LoginEnterprise,
	NoRemotes,
	NoMatchingRemotes,
	ConfigureRemotes,
}

interface QueryInspect {
	key: string;
	defaultValue?: { label: string; query: string }[];
	globalValue?: { label: string; query: string }[];
	workspaceValue?: { label: string; query: string }[];
	workspaceFolderValue?: { label: string; query: string }[];
	defaultLanguageValue?: { label: string; query: string }[];
	globalLanguageValue?: { label: string; query: string }[];
	workspaceLanguageValue?: { label: string; query: string }[];
	workspaceFolderLanguageValue?: { label: string; query: string }[];
	languageIds?: string[]
}

export class PRCategoryActionNode extends TreeNode implements vscode.TreeItem {
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public iconPath?: { light: string | vscode.Uri; dark: string | vscode.Uri };
	public type: PRCategoryActionType;
	public command?: vscode.Command;

	constructor(parent: TreeNodeParent, type: PRCategoryActionType, node?: CategoryTreeNode) {
		super();
		this.parent = parent;
		this.type = type;
		this.collapsibleState = vscode.TreeItemCollapsibleState.None;
		switch (type) {
			case PRCategoryActionType.Empty:
				this.label = vscode.l10n.t('0 pull requests in this category');
				break;
			case PRCategoryActionType.More:
				this.label = vscode.l10n.t('Load more');
				this.command = {
					title: vscode.l10n.t('Load more'),
					command: 'pr.loadMore',
					arguments: [node],
				};
				break;
			case PRCategoryActionType.TryOtherRemotes:
				this.label = vscode.l10n.t('Continue fetching from other remotes');
				this.command = {
					title: vscode.l10n.t('Load more'),
					command: 'pr.loadMore',
					arguments: [node],
				};
				break;
			case PRCategoryActionType.Login:
				this.label = vscode.l10n.t('Sign in');
				this.command = {
					title: vscode.l10n.t('Sign in'),
					command: 'pr.signinAndRefreshList',
					arguments: [],
				};
				break;
			case PRCategoryActionType.LoginEnterprise:
				this.label = vscode.l10n.t('Sign in with GitHub Enterprise...');
				this.command = {
					title: 'Sign in',
					command: 'pr.signinAndRefreshList',
					arguments: [],
				};
				break;
			case PRCategoryActionType.NoRemotes:
				this.label = vscode.l10n.t('No GitHub repositories found.');
				break;
			case PRCategoryActionType.NoMatchingRemotes:
				this.label = vscode.l10n.t('No remotes match the current setting.');
				break;
			case PRCategoryActionType.ConfigureRemotes:
				this.label = vscode.l10n.t('Configure remotes...');
				this.command = {
					title: vscode.l10n.t('Configure remotes'),
					command: 'pr.configureRemotes',
					arguments: [],
				};
				break;
			default:
				break;
		}
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}
}

interface PageInformation {
	pullRequestPage: number;
	hasMorePages: boolean;
}

export class CategoryTreeNode extends TreeNode implements vscode.TreeItem {
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public prs: PullRequestModel[];
	public fetchNextPage: boolean = false;
	public repositoryPageInformation: Map<string, PageInformation> = new Map<string, PageInformation>();
	public contextValue: string;
	public readonly id: string = '';

	constructor(
		public parent: TreeNodeParent,
		private _folderRepoManager: FolderRepositoryManager,
		private _telemetry: ITelemetry,
		private _type: PRType,
		private _notificationProvider: NotificationProvider,
		expandedQueries: Set<string>,
		private _prsTreeModel: PrsTreeModel,
		_categoryLabel?: string,
		private _categoryQuery?: string,
	) {
		super();

		this.prs = [];

		switch (_type) {
			case PRType.All:
				this.label = vscode.l10n.t('All Open');
				break;
			case PRType.Query:
				this.label = _categoryLabel!;
				break;
			case PRType.LocalPullRequest:
				this.label = vscode.l10n.t('Local Pull Request Branches');
				break;
			default:
				this.label = '';
				break;
		}

		this.id = parent instanceof TreeNode ? `${parent.id ?? parent.label}/${this.label}` : this.label;

		if ((expandedQueries.size === 0) && (_type === PRType.All)) {
			this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
		} else {
			this.collapsibleState =
				expandedQueries.has(this.id)
					? vscode.TreeItemCollapsibleState.Expanded
					: vscode.TreeItemCollapsibleState.Collapsed;
		}

		if (this._categoryQuery) {
			this.contextValue = 'query';
		}
	}

	private async addNewQuery(config: vscode.WorkspaceConfiguration, inspect: QueryInspect | undefined, startingValue: string) {
		const inputBox = vscode.window.createInputBox();
		inputBox.title = vscode.l10n.t('Enter the title of the new query');
		inputBox.placeholder = vscode.l10n.t('Title');
		inputBox.step = 1;
		inputBox.totalSteps = 2;
		inputBox.show();
		let title: string | undefined;
		inputBox.onDidAccept(async () => {
			inputBox.validationMessage = '';
			if (inputBox.step === 1) {
				if (!inputBox.value) {
					inputBox.validationMessage = vscode.l10n.t('Title is required');
					return;
				}

				title = inputBox.value;
				inputBox.value = startingValue;
				inputBox.title = vscode.l10n.t('Enter the GitHub search query');
				inputBox.step++;
			} else {
				if (!inputBox.value) {
					inputBox.validationMessage = vscode.l10n.t('Query is required');
					return;
				}
				inputBox.busy = true;
				if (inputBox.value && title) {
					if (inspect?.workspaceValue) {
						inspect.workspaceValue.push({ label: title, query: inputBox.value });
						await config.update(QUERIES, inspect.workspaceValue, vscode.ConfigurationTarget.Workspace);
					} else {
						const value = config.get<{ label: string; query: string }[]>(QUERIES);
						value?.push({ label: title, query: inputBox.value });
						await config.update(QUERIES, value, vscode.ConfigurationTarget.Global);
					}
				}
				inputBox.dispose();
			}
		});
		inputBox.onDidHide(() => inputBox.dispose());
	}

	private updateQuery(queries: { label: string; query: string }[], queryToUpdate: { label: string; query: string }) {
		for (const query of queries) {
			if (query.label === queryToUpdate.label) {
				query.query = queryToUpdate.query;
				return;
			}
		}
	}

	private async openSettings(config: vscode.WorkspaceConfiguration, inspect: QueryInspect | undefined) {
		let command: string;
		if (inspect?.workspaceValue) {
			command = 'workbench.action.openWorkspaceSettingsFile';
		} else {
			const value = config.get<{ label: string; query: string }[]>(QUERIES);
			if (inspect?.defaultValue && JSON.stringify(inspect?.defaultValue) === JSON.stringify(value)) {
				await config.update(QUERIES, inspect.defaultValue, vscode.ConfigurationTarget.Global);
			}
			command = 'workbench.action.openSettingsJson';
		}
		await vscode.commands.executeCommand(command);
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			const text = editor.document.getText();
			const search = text.search(this.label!);
			if (search >= 0) {
				const position = editor.document.positionAt(search);
				editor.revealRange(new vscode.Range(position, position));
				editor.selection = new vscode.Selection(position, position);
			}
		}
	}

	async editQuery() {
		const config = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE);
		const inspect = config.inspect<{ label: string; query: string }[]>(QUERIES);

		const inputBox = vscode.window.createQuickPick();
		inputBox.title = vscode.l10n.t('Edit Pull Request Query "{0}"', this.label ?? '');
		inputBox.value = this._categoryQuery ?? '';
		inputBox.items = [{ iconPath: new vscode.ThemeIcon('pencil'), label: vscode.l10n.t('Save edits'), alwaysShow: true }, { iconPath: new vscode.ThemeIcon('add'), label: vscode.l10n.t('Add new query'), alwaysShow: true }, { iconPath: new vscode.ThemeIcon('settings'), label: vscode.l10n.t('Edit in settings.json'), alwaysShow: true }];
		inputBox.activeItems = [];
		inputBox.selectedItems = [];
		inputBox.onDidAccept(async () => {
			inputBox.busy = true;
			if (inputBox.selectedItems[0] === inputBox.items[0]) {
				const newQuery = inputBox.value;
				if (newQuery !== this._categoryQuery && this.label) {
					if (inspect?.workspaceValue) {
						this.updateQuery(inspect.workspaceValue, { label: this.label, query: newQuery });
						await config.update(QUERIES, inspect.workspaceValue, vscode.ConfigurationTarget.Workspace);
					} else {
						const value = config.get<{ label: string; query: string }[]>(QUERIES) ?? inspect!.defaultValue!;
						this.updateQuery(value, { label: this.label, query: newQuery });
						await config.update(QUERIES, value, vscode.ConfigurationTarget.Global);
					}
				}
			} else if (inputBox.selectedItems[0] === inputBox.items[1]) {
				this.addNewQuery(config, inspect, inputBox.value);
			} else if (inputBox.selectedItems[0] === inputBox.items[2]) {
				this.openSettings(config, inspect);
			}
			inputBox.dispose();
		});
		inputBox.onDidHide(() => inputBox.dispose());
		inputBox.show();
	}

	async getChildren(): Promise<TreeNode[]> {
		super.getChildren();

		let hasMorePages = false;
		let hasUnsearchedRepositories = false;
		let needLogin = false;
		if (this._type === PRType.LocalPullRequest) {
			try {
				this.prs = await this._prsTreeModel.getLocalPullRequests(this._folderRepoManager);
			} catch (e) {
				vscode.window.showErrorMessage(vscode.l10n.t('Fetching local pull requests failed: {0}', formatError(e)));
				needLogin = e instanceof AuthenticationError;
			}
		} else {
			try {
				let response: ItemsResponseResult<PullRequestModel>;
				switch (this._type) {
					case PRType.All:
						response = await this._prsTreeModel.getAllPullRequests(this._folderRepoManager, this.fetchNextPage);
						break;
					case PRType.Query:
						response = await this._prsTreeModel.getPullRequestsForQuery(this._folderRepoManager, this.fetchNextPage, this._categoryQuery!);
						break;
				}
				if (!this.fetchNextPage) {
					this.prs = response.items;
				} else {
					this.prs = this.prs.concat(response.items);
				}
				hasMorePages = response.hasMorePages;
				hasUnsearchedRepositories = response.hasUnsearchedRepositories;
			} catch (e) {
				vscode.window.showErrorMessage(vscode.l10n.t('Fetching pull requests failed: {0}', formatError(e)));
				needLogin = e instanceof AuthenticationError;
			} finally {
				this.fetchNextPage = false;
			}
		}

		if (this.prs && this.prs.length) {
			const nodes: TreeNode[] = this.prs.map(
				prItem => new PRNode(this, this._folderRepoManager, prItem, this._type === PRType.LocalPullRequest, this._notificationProvider),
			);
			if (hasMorePages) {
				nodes.push(new PRCategoryActionNode(this, PRCategoryActionType.More, this));
			} else if (hasUnsearchedRepositories) {
				nodes.push(new PRCategoryActionNode(this, PRCategoryActionType.TryOtherRemotes, this));
			}

			this.children = nodes;
			return nodes;
		} else {
			const category = needLogin ? PRCategoryActionType.Login : PRCategoryActionType.Empty;
			const result = [new PRCategoryActionNode(this, category)];

			this.children = result;
			return result;
		}
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}
}
