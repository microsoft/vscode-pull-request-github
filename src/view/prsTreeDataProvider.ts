/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AuthProvider } from '../common/authentication';
import { commands, contexts } from '../common/executeCommands';
import { Disposable } from '../common/lifecycle';
import Logger from '../common/logger';
import { FILE_LIST_LAYOUT, PR_SETTINGS_NAMESPACE, QUERIES, REMOTES } from '../common/settingKeys';
import { ITelemetry } from '../common/telemetry';
import { createPRNodeIdentifier } from '../common/uri';
import { EXTENSION_ID } from '../constants';
import { CopilotRemoteAgentManager } from '../github/copilotRemoteAgent';
import { CredentialStore } from '../github/credentials';
import { FolderRepositoryManager, ReposManagerState } from '../github/folderRepositoryManager';
import { PullRequestChangeEvent } from '../github/githubRepository';
import { PRType } from '../github/interface';
import { issueMarkdown } from '../github/markdownUtils';
import { NotificationProvider } from '../github/notifications';
import { PullRequestModel } from '../github/pullRequestModel';
import { PullRequestOverviewPanel } from '../github/pullRequestOverview';
import { RepositoriesManager } from '../github/repositoriesManager';
import { findDotComAndEnterpriseRemotes } from '../github/utils';
import { PRStatusDecorationProvider } from './prStatusDecorationProvider';
import { PrsTreeModel } from './prsTreeModel';
import { ReviewModel } from './reviewModel';
import { CategoryTreeNode, PRCategoryActionNode, PRCategoryActionType } from './treeNodes/categoryNode';
import { InMemFileChangeNode } from './treeNodes/fileChangeNode';
import { PRNode } from './treeNodes/pullRequestNode';
import { BaseTreeNode, TreeNode } from './treeNodes/treeNode';
import { TreeUtils } from './treeNodes/treeUtils';
import { WorkspaceFolderNode } from './treeNodes/workspaceFolderNode';

export class PullRequestsTreeDataProvider extends Disposable implements vscode.TreeDataProvider<TreeNode>, BaseTreeNode {
	private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode[] | TreeNode | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	get onDidChange(): vscode.Event<vscode.Uri> {
		return this._onDidChange.event;
	}
	private _children: WorkspaceFolderNode[] | CategoryTreeNode[];
	get children() {
		return this._children;
	}
	private readonly _view: vscode.TreeView<TreeNode>;
	private _initialized: boolean = false;
	public notificationProvider: NotificationProvider;
	public readonly prsTreeModel: PrsTreeModel;
	private _notificationClearTimeout: NodeJS.Timeout | undefined;

	get view(): vscode.TreeView<TreeNode> {
		return this._view;
	}

	constructor(private readonly _telemetry: ITelemetry, private readonly _context: vscode.ExtensionContext, private readonly _reposManager: RepositoriesManager, private readonly _copilotManager: CopilotRemoteAgentManager) {
		super();
		this.prsTreeModel = this._register(new PrsTreeModel(this._telemetry, this._reposManager, _context));
		this._register(this.prsTreeModel.onDidChangeData(e => {
			if (e instanceof FolderRepositoryManager) {
				this.refreshRepo(e);
			} else if (Array.isArray(e)) {
				this.refreshPullRequests(e);
			} else {
				this.refreshAllQueryResults(true);
			}
		}));
		this._register(new PRStatusDecorationProvider(this.prsTreeModel, this._copilotManager));
		this._register(vscode.commands.registerCommand('pr.refreshList', _ => {
			this.refreshAllQueryResults(true);
		}));

		this._register(vscode.commands.registerCommand('pr.loadMore', (node: CategoryTreeNode) => {
			node.fetchNextPage = true;
			this.refresh(node);
		}));

		this._view = this._register(vscode.window.createTreeView('pr:github', {
			treeDataProvider: this,
			showCollapseAll: true,
		}));

		this._register(this._view.onDidChangeVisibility(e => {
			if (e.visible) {
				// Sync with currently active PR when view becomes visible
				const currentPR = PullRequestOverviewPanel.getCurrentPullRequest();
				if (currentPR) {
					this.syncWithActivePullRequest(currentPR);
				}
			}
		}));

		this._register({
			dispose: () => {
				if (this._notificationClearTimeout) {
					clearTimeout(this._notificationClearTimeout);
					this._notificationClearTimeout = undefined;
				}
			}
		});

		this._register(this._copilotManager.onDidChangeStates(() => {
			this.refreshAllQueryResults();
		}));

		this._register(this._copilotManager.onDidChangeNotifications(() => {
			if (this._copilotManager.notificationsCount > 0) {
				this._view.badge = {
					tooltip: this._copilotManager.notificationsCount === 1 ? vscode.l10n.t('Coding agent has 1 pull request to view') : vscode.l10n.t('Coding agent has {0} pull requests to view', this._copilotManager.notificationsCount),
					value: this._copilotManager.notificationsCount
				};
			} else {
				this._view.badge = undefined;
			}
		}));

		this._register(this._copilotManager.onDidCreatePullRequest(() => this.refreshAllQueryResults(true)));

		// Listen for PR overview panel changes to sync the tree view
		this._register(PullRequestOverviewPanel.onVisible(pullRequest => {
			// Only sync if view is already visible (don't open the view)
			if (this._view.visible) {
				this.syncWithActivePullRequest(pullRequest);
			}
		}));

		this._children = [];

		this._register(vscode.commands.registerCommand('pr.configurePRViewlet', async () => {
			const configuration = await vscode.window.showQuickPick([
				'Configure Remotes...',
				'Configure Queries...',
				'Configure All Pull Request Settings...'
			]);

			switch (configuration) {
				case 'Configure Queries...':
					return vscode.commands.executeCommand(
						'workbench.action.openSettings',
						`@ext:${EXTENSION_ID} pull request queries`,
					);
				case 'Configure Remotes...':
					return vscode.commands.executeCommand(
						'workbench.action.openSettings',
						`@ext:${EXTENSION_ID} remotes`,
					);
				case 'Configure All Pull Request Settings...':
					return vscode.commands.executeCommand(
						'workbench.action.openSettings',
						`@ext:${EXTENSION_ID} pull request`,
					);
				default:
					return;
			}
		}));

		this._register(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(`${PR_SETTINGS_NAMESPACE}.${FILE_LIST_LAYOUT}`)) {
				this.refreshAll();
			}
		}));

		this._register(this._view.onDidChangeCheckboxState(e => TreeUtils.processCheckboxUpdates(e, [])));

		this._register(this._view.onDidExpandElement(expanded => {
			this.prsTreeModel.updateExpandedQueries(expanded.element, true);
		}));
		this._register(this._view.onDidCollapseElement(collapsed => {
			this.prsTreeModel.updateExpandedQueries(collapsed.element, false);
		}));
	}

	public async expandPullRequest(pullRequest: PullRequestModel) {
		if (this._children.length === 0) {
			await this.getChildren();
		}
		for (const child of this._children) {
			if (child instanceof WorkspaceFolderNode) {
				if (await child.expandPullRequest(pullRequest)) {
					return;
				}
			} else if (child.type === PRType.All) {
				if (await child.expandPullRequest(pullRequest)) {
					return;
				}
			}
		}
	}

	async reveal(element: TreeNode, options?: { select?: boolean, focus?: boolean, expand?: boolean }): Promise<void> {
		return this._view.reveal(element, options);
	}

	/**
	 * Sync the tree view with the currently active PR overview
	 */
	private async _syncWithActivePullRequest(pullRequest: PullRequestModel): Promise<void> {
		const alreadySelected = this._view.selection.find(child => child instanceof PRNode && (child.pullRequestModel.number === pullRequest.number) && (child.pullRequestModel.remote.owner === pullRequest.remote.owner) && (child.pullRequestModel.remote.repositoryName === pullRequest.remote.repositoryName));
		if (alreadySelected) {
			return;
		}
		try {
			// Find the PR node in the tree and reveal it
			const prNode = await this.findPRNode(pullRequest);
			if (prNode) {
				await this.reveal(prNode, { select: true, focus: false, expand: false });
			}
		} catch (error) {
			// Silently ignore errors to avoid disrupting the user experience
			Logger.warn(`Failed to sync tree view with active PR: ${error}`);
		}
	}

	/**
	 * Find a PR node in the tree structure
	 */
	private async _findPRNode(pullRequest: PullRequestModel): Promise<PRNode | undefined> {
		if (this._children.length === 0) {
			await this.getChildren();
		}

		for (const child of this._children) {
			if (child instanceof WorkspaceFolderNode) {
				const found = await this.findPRNodeInWorkspaceFolder(child, pullRequest);
				if (found) return found;
			} else if (child instanceof CategoryTreeNode) {
				const found = await this.findPRNodeInCategory(child, pullRequest);
				if (found) return found;
			}
		}
		return undefined;
	}

	/**
	 * Search for PR node within a workspace folder node
	 */
	private async _findPRNodeInWorkspaceFolder(workspaceNode: WorkspaceFolderNode, pullRequest: PullRequestModel): Promise<PRNode | undefined> {
		const children = await workspaceNode.getChildren(false);
		for (const child of children) {
			if (child instanceof CategoryTreeNode) {
				const found = await this.findPRNodeInCategory(child, pullRequest);
				if (found) return found;
			}
		}
		return undefined;
	}

	/**
	 * Search for PR node within a category node
	 */
	private async _findPRNodeInCategory(categoryNode: CategoryTreeNode, pullRequest: PullRequestModel): Promise<PRNode | undefined> {
		if (categoryNode.collapsibleState !== vscode.TreeItemCollapsibleState.Expanded) {
			return;
		}
		const children = await categoryNode.getChildren(false);
		for (const child of children) {
			if (child instanceof PRNode && (child.pullRequestModel.number === pullRequest.number) && (child.pullRequestModel.remote.owner === pullRequest.remote.owner) && (child.pullRequestModel.remote.repositoryName === pullRequest.remote.repositoryName)) {
				return child;
			}
		}
		return undefined;
	}

	initialize(reviewModels: ReviewModel[], credentialStore: CredentialStore) {
		if (this._initialized) {
			throw new Error('Tree has already been initialized!');
		}

		this._initialized = true;
		this._register(
			this._reposManager.onDidChangeState(() => {
				this.refreshAll();
			}),
		);

		for (const model of reviewModels) {
			this._register(model.onDidChangeLocalFileChanges(_ => { this.refreshAllQueryResults(); }));
		}

		this.notificationProvider = this._register(new NotificationProvider(this, credentialStore, this._reposManager));

		this.initializeCategories();
		this.refreshAll();
	}

	private async _initializeCategories() {
		this._register(vscode.workspace.onDidChangeConfiguration(async e => {
			if (e.affectsConfiguration(`${PR_SETTINGS_NAMESPACE}.${QUERIES}`)) {
				this.refreshAll();
			}
		}));
	}

	refreshAll(reset?: boolean) {
		this.tryReset(!!reset);
		this._onDidChangeTreeData.fire();
	}

	private _tryReset(reset: boolean) {
		if (reset) {
			this.prsTreeModel.clearCache(true);
		}
	}

	private _refreshAllQueryResults(reset?: boolean) {
		this.tryReset(!!reset);

		if (!this._children || this._children.length === 0) {
			this._onDidChangeTreeData.fire();
			return;
		}

		if (this._children[0] instanceof WorkspaceFolderNode) {
			(this._children as WorkspaceFolderNode[]).forEach(folderNode => this.refreshQueryResultsForFolder(folderNode));
			return;
		}
		this.refreshQueryResultsForFolder();
	}

	private _refreshQueryResultsForFolder(manager?: WorkspaceFolderNode, reset?: boolean) {
		if (!manager && this._children[0] instanceof WorkspaceFolderNode) {
			// Not permitted. There're multiple folder nodes, therefore must specify which one to refresh
			throw new Error('Must specify a folder node to refresh when there are multiple folder nodes');
		}

		if (!this._children || this._children.length === 0) {
			this._onDidChangeTreeData.fire();
			return;
		}
		const queries = manager?.children ?? this._children;
		this.tryReset(!!reset);

		this._onDidChangeTreeData.fire([...queries]);
	}

	refresh(node: TreeNode, reset?: boolean): void {
		this.tryReset(!!reset);
		return this._onDidChangeTreeData.fire(node);
	}

	private _refreshRepo(manager: FolderRepositoryManager): void {
		if ((this._children.length === 0) || (this._children[0] instanceof CategoryTreeNode && this._children[0].folderRepoManager === manager)) {
			return this.refreshQueryResultsForFolder(undefined, true);
		}
		if (this._children[0] instanceof WorkspaceFolderNode) {
			const children: WorkspaceFolderNode[] = this._children as WorkspaceFolderNode[];
			const node = children.find(node => node.folderManager === manager);
			if (node) {
				this.refreshQueryResultsForFolder(node);
				return;
			}
		}
	}

	private _refreshPullRequests(pullRequests: PullRequestChangeEvent[]): void {
		if (!this._children?.length || !pullRequests?.length) {
			return;
		}
		const prNodesToRefresh: TreeNode[] = [];
		const prsWithStateChange = new Set();
		const prNumbers = new Set();

		for (const prChange of pullRequests) {
			prNumbers.add(prChange.model.number);
			if (prChange.event.state) {
				prsWithStateChange.add(prChange.model.number);
			}
		}

		const hasPRNode = (node: TreeNode) => {
			const prNodes = node.children ?? [];
			for (const prNode of prNodes) {
				if (prNode instanceof PRNode && prsWithStateChange.has(prNode.pullRequestModel.number)) {
					return true;
				}
			}
			return false;
		};

		const categoriesToRefresh: Set<CategoryTreeNode> = new Set();
		// First find the categories to refresh, since if we refresh a category we don't need to specifically refresh its children
		for (const child of this._children) {
			if (child instanceof WorkspaceFolderNode) {
				const categories = child.children ?? [];
				for (const category of categories) {
					if (category instanceof CategoryTreeNode && !categoriesToRefresh.has(category) && hasPRNode(category)) {
						categoriesToRefresh.add(category);
					}
				}
			} else if (child instanceof CategoryTreeNode && !categoriesToRefresh.has(child) && hasPRNode(child)) {
				categoriesToRefresh.add(child);
			}
		}

		// Yes, multiple PRs can exist in different repos with the same number, but at worst we'll refresh all the duplicate numbers, which shouldn't be many.
		const collectPRNodes = (node: TreeNode) => {
			const prNodes = node.children ?? [];
			for (const prNode of prNodes) {
				if (prNode instanceof PRNode && prNumbers.has(prNode.pullRequestModel.number)) {
					prNodesToRefresh.push(prNode);
				}
			}
		};

		for (const child of this._children) {
			if (child instanceof WorkspaceFolderNode) {
				const categories = child.children ?? [];
				for (const category of categories) {
					if (category instanceof CategoryTreeNode && !categoriesToRefresh.has(category)) {
						collectPRNodes(category);
					}
				}
			} else if (child instanceof CategoryTreeNode && !categoriesToRefresh.has(child)) {
				collectPRNodes(child);
			}
		}
		if (prNodesToRefresh.length || categoriesToRefresh.size > 0) {
			this._onDidChangeTreeData.fire([...Array.from(categoriesToRefresh), ...prNodesToRefresh]);
		}
	}

	getTreeItem(element: TreeNode): vscode.TreeItem | Promise<vscode.TreeItem> {
		return element.getTreeItem();
	}

	async resolveTreeItem(item: vscode.TreeItem, element: TreeNode): Promise<vscode.TreeItem> {
		if (element instanceof InMemFileChangeNode) {
			await element.resolve();
			item = element.getTreeItem();
		} else if (element instanceof PRNode) {
			item.tooltip = await issueMarkdown(element.pullRequestModel, this._context, this._reposManager, undefined, this.prsTreeModel.cachedPRStatus(createPRNodeIdentifier(element.pullRequestModel))?.status);
		}
		return item;
	}

	private async _needsRemotes() {
		if (this._reposManager?.state === ReposManagerState.NeedsAuthentication) {
			return [];
		}

		const remotesSetting = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<string[]>(REMOTES);
		let actions: PRCategoryActionNode[];
		if (remotesSetting) {
			actions = [
				new PRCategoryActionNode(this, PRCategoryActionType.NoMatchingRemotes),
				new PRCategoryActionNode(this, PRCategoryActionType.ConfigureRemotes),

			];
		} else {
			actions = [new PRCategoryActionNode(this, PRCategoryActionType.NoRemotes)];
		}

		const { enterpriseRemotes } = this._reposManager ? await findDotComAndEnterpriseRemotes(this._reposManager?.folderManagers) : { enterpriseRemotes: [] };
		if ((enterpriseRemotes.length > 0) && !this._reposManager?.credentialStore.isAuthenticated(AuthProvider.githubEnterprise)) {
			actions.push(new PRCategoryActionNode(this, PRCategoryActionType.LoginEnterprise));
		}

		return actions;
	}

	async cachedChildren(element?: WorkspaceFolderNode | CategoryTreeNode): Promise<TreeNode[]> {
		if (!element) {
			return this._children;
		}
		return element.cachedChildren();
	}

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		if (!this._reposManager?.folderManagers.length) {
			return [];
		}

		if (this._reposManager.state === ReposManagerState.Initializing) {
			commands.setContext(contexts.LOADING_PRS_TREE, true);
			return [];
		}

		const remotes = await Promise.all(this._reposManager.folderManagers.map(manager => manager.getGitHubRemotes()));
		if ((this._reposManager.folderManagers.filter((_manager, index) => remotes[index].length > 0).length === 0)) {
			return this.needsRemotes();
		}

		const gitHubFolderManagers = this._reposManager.folderManagers.filter(manager => manager.gitHubRepositories.length > 0);
		if (!element) {
			if (this._children && this._children.length) {
				this._children.forEach(dispose => dispose.dispose());
			}

			let result: WorkspaceFolderNode[] | CategoryTreeNode[];
			if (gitHubFolderManagers.length === 1) {
				result = await WorkspaceFolderNode.getCategoryTreeNodes(
					gitHubFolderManagers[0],
					this._telemetry,
					this,
					this.notificationProvider,
					this._context,
					this.prsTreeModel,
					this._copilotManager,
				);
			} else {
				result = gitHubFolderManagers.map(
					folderManager =>
						new WorkspaceFolderNode(
							this,
							folderManager.repository.rootUri,
							folderManager,
							this._telemetry,
							this.notificationProvider,
							this._context,
							this.prsTreeModel,
							this._copilotManager
						),
				);
			}

			this._children = result;
			return result;
		}

		if (
			gitHubFolderManagers.filter(manager => manager.repository.state.remotes.length > 0).length === 0
		) {
			return Promise.resolve([new PRCategoryActionNode(this, PRCategoryActionType.Empty)]);
		}

		return element.getChildren();
	}

	async getParent(element: TreeNode) {
		return element.getParent();
	}
}
