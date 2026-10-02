/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PRStatusDecorationProvider } from './prStatusDecorationProvider';
import { PrsTreeModel } from './prsTreeModel';
import { ReviewModel } from './reviewModel';
import { StackCandidate } from '../../common/views';
import { getEnterpriseUris } from '../authentication/configuration';
import { AuthProvider } from '../common/authentication';
import { commands, contexts } from '../common/executeCommands';
import { Disposable } from '../common/lifecycle';
import Logger from '../common/logger';
import { Remote } from '../common/remote';
import { FILE_LIST_LAYOUT, GITHUB_ENTERPRISE, PR_SETTINGS_NAMESPACE, QUERIES, REMOTES, URI, URIS } from '../common/settingKeys';
import { ITelemetry } from '../common/telemetry';
import { createPRNodeIdentifier } from '../common/uri';
import { formatError } from '../common/utils';
import { EXTENSION_ID } from '../constants';
import { FolderRepositoryManager, ReposManagerState } from '../github/folderRepositoryManager';
import { PullRequestChangeEvent } from '../github/githubRepository';
import { PRType } from '../github/interface';
import { escapeMarkdownText, issueMarkdown } from '../github/markdownUtils';
import { PullRequestModel } from '../github/pullRequestModel';
import { PullRequestOverviewPanel } from '../github/pullRequestOverview';
import { addPullRequestsToStack, orderStackablePullRequests } from '../github/pullRequestStack';
import { RepositoriesManager } from '../github/repositoriesManager';
import { CategoryTreeNode, PRCategoryActionNode, PRCategoryActionType } from './treeNodes/categoryNode';
import { InMemFileChangeNode } from './treeNodes/fileChangeNode';
import { PRNode } from './treeNodes/pullRequestNode';
import { BaseTreeNode, TreeNode } from './treeNodes/treeNode';
import { TreeUtils } from './treeNodes/treeUtils';
import { WorkspaceFolderNode } from './treeNodes/workspaceFolderNode';
import { NotificationsManager } from '../notifications/notificationsManager';

export function getEnterpriseAuthenticationMessage(remotes: readonly Remote[], instances: readonly vscode.Uri[], selectedInstance: vscode.Uri | undefined): string | undefined {
	const unavailable = remotes.filter(remote => remote.isEnterprise && (!selectedInstance || !remote.matchesServerUri(selectedInstance)));
	const configured = unavailable.filter(remote => instances.some(instance => remote.matchesServerUri(instance)));
	const unconfigured = unavailable.filter(remote => !instances.some(instance => remote.matchesServerUri(instance)));
	const instanceLabel = (uri: vscode.Uri) => `${uri.authority}${uri.path.replace(/\/+$/, '')}`;
	const hosts = (remotes: readonly Remote[]) => [...new Set(remotes.map(remote => instanceLabel(vscode.Uri.parse(remote.normalizedHost))))].join(', ');
	const messages: string[] = [];
	if (configured.length) {
		messages.push(selectedInstance
			? vscode.l10n.t('Using {0} for GitHub Enterprise.\n\nSelect an account for {1} to view its repositories.', instanceLabel(selectedInstance), hosts(configured))
			: vscode.l10n.t('Select a GitHub Enterprise account to view repositories on {0}.', hosts(configured)));
	}
	if (unconfigured.length) {
		messages.push(vscode.l10n.t('Add {0} to your GitHub Enterprise instances in Settings.', hosts(unconfigured)));
	}
	return messages.length ? messages.join('\n\n') : undefined;
}

function enterpriseSettingsMessage(text: string | undefined, actions: { github: boolean; githubEnterprise: boolean; configure: boolean }): vscode.MarkdownString | undefined {
	if (!text) {
		return undefined;
	}
	const message = new vscode.MarkdownString(escapeMarkdownText(text));
	message.isTrusted = { enabledCommands: ['pr.signinNoEnterprise', 'pr.selectEnterpriseAccount', 'workbench.action.openSettings'] };
	if (actions.githubEnterprise) {
		message.appendMarkdown(`\n\n[${vscode.l10n.t('Select Account')}](command:pr.selectEnterpriseAccount)`);
	}
	if (actions.github) {
		message.appendMarkdown(`\n[${vscode.l10n.t('Sign in with GitHub.com')}](command:pr.signinNoEnterprise)`);
	}
	if (actions.configure) {
		const settingsQuery = encodeURIComponent(JSON.stringify([`${GITHUB_ENTERPRISE}.${URIS}`]));
		message.appendMarkdown(`\n[${vscode.l10n.t('Configure GitHub Enterprise')}](command:workbench.action.openSettings?${settingsQuery})`);
	}
	return message;
}

export function getAddToStackConfirmation(ordered: readonly PullRequestModel[], candidate: StackCandidate): { message: string; detail: string; action: string } {
	const existing = candidate.stackNumber !== undefined;
	const additions = ordered.slice(1);
	const message = existing
		? additions.length === 1
			? vscode.l10n.t('Add 1 pull request to an existing stack?')
			: vscode.l10n.t('Add {0} pull requests to an existing stack?', additions.length)
		: vscode.l10n.t('Create a stack with {0} pull requests?', ordered.length);
	const detail = existing
		? vscode.l10n.t('Adding {0}\nto #{1}', [additions.map(pr => `#${pr.number} ${pr.title}`).join('\n'), `${ordered[0].number} ${ordered[0].title}`])
		: ordered.map(pr => `#${pr.number} ${pr.title}`).join('\n');
	return { message, detail, action: existing ? vscode.l10n.t('Add to Stack') : vscode.l10n.t('Create Stack') };
}

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
	private readonly _loginView: vscode.TreeView<TreeNode>;
	private _initialized: boolean = false;
	private _notificationsProvider?: NotificationsManager;
	private _notificationClearTimeout: NodeJS.Timeout | undefined;

	get view(): vscode.TreeView<TreeNode> {
		return this._view;
	}

	constructor(public readonly prsTreeModel: PrsTreeModel, private readonly _telemetry: ITelemetry, private readonly _context: vscode.ExtensionContext, private readonly _reposManager: RepositoriesManager) {
		super();
		this._register(this.prsTreeModel.onDidChangeData(e => {
			if (e instanceof FolderRepositoryManager) {
				this.refreshRepo(e);
			} else if (Array.isArray(e)) {
				this.refreshPullRequests(e);
			} else {
				this.refreshAllQueryResults(true);
			}
		}));
		this._register(vscode.commands.registerCommand('pr.refreshList', _ => {
			this.prsTreeModel.forceClearCache();
			this.refreshAllQueryResults(true);
		}));

		this._register(vscode.commands.registerCommand('pr.loadMore', (node: CategoryTreeNode) => {
			node.fetchNextPage = true;
			this.refresh(node);
		}));

		this._view = this._register(vscode.window.createTreeView('pr:github', {
			treeDataProvider: this,
			showCollapseAll: true,
			canSelectMany: true,
			manageCheckboxStateManually: true
		}));
		this._loginView = this._register(vscode.window.createTreeView('github:login', {
			treeDataProvider: {
				onDidChangeTreeData: this.onDidChangeTreeData,
				getTreeItem: element => element.getTreeItem(),
				getChildren: () => {
					this.updateEnterpriseAuthenticationMessage();
					return [];
				},
			},
		}));

		void commands.setContext(contexts.CAN_ADD_TO_STACK, false);
		this._register(this._view.onDidChangeSelection(e => {
			const selectedPRs = e.selection.filter((node): node is PRNode => node instanceof PRNode);
			const stackable = selectedPRs.length === e.selection.length
				&& !!orderStackablePullRequests(selectedPRs.map(node => node.pullRequestModel));
			void commands.setContext(contexts.CAN_ADD_TO_STACK, stackable);
		}));
		this._register({ dispose: () => { void commands.setContext(contexts.CAN_ADD_TO_STACK, false); } });
		this._register(vscode.commands.registerCommand('pr.addToStack',
			(clicked: PRNode, selected: TreeNode[]) => this.addSelectedPullRequestsToStack(clicked, selected)));

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

		this._register(this.prsTreeModel.onDidChangeCopilotStates(() => {
			this.refreshAllQueryResults();
		}));

		this._register(this.prsTreeModel.onDidChangeCopilotNotifications(() => {
			this.updateBadge();
		}));
		this.updateBadge();

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
			if (e.affectsConfiguration(`${PR_SETTINGS_NAMESPACE}.${FILE_LIST_LAYOUT}`)
				|| e.affectsConfiguration(`${GITHUB_ENTERPRISE}.${URIS}`)
				|| e.affectsConfiguration(`${GITHUB_ENTERPRISE}.${URI}`)) {
				this.refreshAll();
			}
		}));
		this._register(vscode.workspace.onDidGrantWorkspaceTrust(() => this.refreshAll()));

		this._register(this._view.onDidChangeCheckboxState(e => TreeUtils.processCheckboxUpdates(e, [])));

		this._register(this._view.onDidExpandElement(expanded => {
			this.prsTreeModel.updateExpandedQueries(expanded.element, true);
		}));
		this._register(this._view.onDidCollapseElement(collapsed => {
			this.prsTreeModel.updateExpandedQueries(collapsed.element, false);
		}));
	}

	private async addSelectedPullRequestsToStack(clicked: PRNode, selected: TreeNode[] | undefined): Promise<void> {
		const selection = selected ?? this._view.selection;
		if (!(clicked instanceof PRNode) || !Array.isArray(selection) || selection.length < 2
			|| !selection.includes(clicked) || !selection.every(node => node instanceof PRNode)) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Select at least two pull requests in the Pull Requests view to add them to a stack.'));
			return;
		}
		const ordered = orderStackablePullRequests(selection.map(node => (node as PRNode).pullRequestModel));
		if (!ordered) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Selected pull requests must be open and have matching head and base branches in the same repository.'));
			return;
		}
		try {
			const bottom = ordered[0];
			const candidate = await bottom.githubRepository.getStackCandidate(bottom.head!.ref);
			if (!candidate || candidate.parentPullRequestNumber !== bottom.number) {
				throw new Error(`Pull request #${bottom.number} is no longer eligible to start or extend a stack.`);
			}
			const confirmation = getAddToStackConfirmation(ordered, candidate);
			const approved = await vscode.window.showInformationMessage(
				confirmation.message, { modal: true, detail: confirmation.detail }, confirmation.action,
			);
			if (approved !== confirmation.action) {
				return;
			}
			await addPullRequestsToStack(ordered, candidate);
			this.refreshAll(true);
			void vscode.window.showInformationMessage(vscode.l10n.t('Pull requests added to the stack.'));
		} catch (error) {
			Logger.error(`Failed to add pull requests to stack: ${formatError(error)}`, PullRequestsTreeDataProvider.name);
			void vscode.window.showErrorMessage(vscode.l10n.t('Unable to add pull requests to stack: {0}', formatError(error)));
		}
	}

	private filterNotificationsToKnown(notifications: PullRequestModel[]): PullRequestModel[] {
		return notifications.filter(notification => {
			if (!this.prsTreeModel.hasPullRequest(notification)) {
				return false;
			}
			return !this.prsTreeModel.hasCopilotNotification(notification.remote.owner, notification.remote.repositoryName, notification.number);
		});
	}

	private updateBadge() {
		const isPRNotificationsOn = this._notificationsProvider?.isPRNotificationsOn();

		const prNotificationsCount = isPRNotificationsOn ? this.filterNotificationsToKnown(this._notificationsProvider!.prNotifications).length : 0;
		const copilotCount = this.prsTreeModel.copilotNotificationsCount;
		const totalCount = prNotificationsCount + copilotCount;

		if (totalCount === 0) {
			this._view.badge = undefined;
			return;
		}

		if (prNotificationsCount > 0 && copilotCount > 0) {
			if (copilotCount === 1) {
				if (prNotificationsCount === 1) {
					this._view.badge = {
						tooltip: vscode.l10n.t('Coding agent has 1 pull request to view, plus 1 other pull request notification'),
						value: totalCount
					};
				} else {
					this._view.badge = {
						tooltip: vscode.l10n.t(`Coding agent has 1 pull request to view, plus {0} other pull request notifications`, prNotificationsCount),
						value: totalCount
					};
				}
			} else {
				if (prNotificationsCount === 1) {
					this._view.badge = {
						tooltip: vscode.l10n.t('Coding agent has {0} pull requests to view, plus 1 other pull request notification', copilotCount),
						value: totalCount
					};
				} else {
					this._view.badge = {
						tooltip: vscode.l10n.t(`Coding agent has {0} pull requests to view, plus {1} other pull request notifications`, copilotCount, prNotificationsCount),
						value: totalCount
					};
				}
			}
		} else if (copilotCount > 0) {
			if (copilotCount === 1) {
				this._view.badge = {
					tooltip: vscode.l10n.t(`Coding agent has 1 pull request to view`),
					value: totalCount
				};
			} else {
				this._view.badge = {
					tooltip: vscode.l10n.t(`Coding agent has {0} pull requests to view`, copilotCount),
					value: totalCount
				};
			}
		} else if (prNotificationsCount > 0) {
			if (prNotificationsCount === 1) {
				this._view.badge = {
					tooltip: vscode.l10n.t(`1 pull request notification`),
					value: totalCount
				};
			} else {
				this._view.badge = {
					tooltip: vscode.l10n.t(`{0} pull request notifications`, prNotificationsCount),
					value: totalCount
				};
			}
		}
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
	private async syncWithActivePullRequest(pullRequest: PullRequestModel): Promise<void> {
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
	private async findPRNode(pullRequest: PullRequestModel): Promise<PRNode | undefined> {
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
	private async findPRNodeInWorkspaceFolder(workspaceNode: WorkspaceFolderNode, pullRequest: PullRequestModel): Promise<PRNode | undefined> {
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
	private async findPRNodeInCategory(categoryNode: CategoryTreeNode, pullRequest: PullRequestModel): Promise<PRNode | undefined> {
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

	initialize(reviewModels: ReviewModel[], notificationsManager: NotificationsManager) {
		if (this._initialized) {
			throw new Error('Tree has already been initialized!');
		}

		this._initialized = true;
		this._register(this._reposManager.onDidChangeState(() => {
			this.refreshAll();
		}));
		this._register(this._reposManager.onDidLoadAnyRepositories(() => {
			this.refreshAll();
		}));

		for (const model of reviewModels) {
			this._register(model.onDidChangeLocalFileChanges(_ => { this.refreshAllQueryResults(); }));
		}

		this._notificationsProvider = notificationsManager;
		this._register(this._notificationsProvider.onDidChangeNotifications(() => {
			this.updateBadge();
		}));
		this._register(new PRStatusDecorationProvider(this.prsTreeModel, this._notificationsProvider));

		this.initializeCategories();
		this.refreshAll();
	}

	private async initializeCategories() {
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

	clear() {
		this.prsTreeModel.forceClearCache(true);
		this._children.forEach(child => child.dispose());
		this._children = [];
		this._onDidChangeTreeData.fire();
	}

	private tryReset(reset: boolean) {
		if (reset) {
			this.prsTreeModel.clearCache(true);
		}
	}

	private refreshAllQueryResults(reset?: boolean) {
		this.tryReset(!!reset);

		if (!this._children || this._children.length === 0) {
			this._onDidChangeTreeData.fire();
			return;
		}

		if (this._children[0] instanceof WorkspaceFolderNode) {
			const currentManagers = new Set(this._reposManager.folderManagers);
			const before = this._children.length;
			const validChildren = (this._children as WorkspaceFolderNode[]).filter(folderNode => {
				if (currentManagers.has(folderNode.folderManager)) {
					return true;
				}
				folderNode.dispose();
				return false;
			});
			if (validChildren.length !== before) {
				this._children = validChildren;
				this._onDidChangeTreeData.fire();
				return;
			}
			validChildren.forEach(folderNode => this.refreshQueryResultsForFolder(folderNode));
			return;
		}
		this.refreshQueryResultsForFolder();
	}

	private refreshQueryResultsForFolder(manager?: WorkspaceFolderNode, reset?: boolean) {
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

	private refreshRepo(manager: FolderRepositoryManager): void {
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

	private refreshPullRequests(pullRequests: PullRequestChangeEvent[]): void {
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

	private needsRemotes(remotes: readonly Remote[]) {
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

		if (remotes.some(remote => remote.isEnterprise) && !this._reposManager?.credentialStore.isAuthenticated(AuthProvider.githubEnterprise)) {
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

	private updateEnterpriseAuthenticationMessage(remotes: readonly Remote[] = this._reposManager.activeGitHubRemotes): void {
		const selected = this._reposManager.credentialStore.getHub(AuthProvider.githubEnterprise)?.serverUri;
		const showPublicSignIn = remotes.some(remote => remote.authProviderId === AuthProvider.github)
			&& !this._reposManager.credentialStore.isAuthenticated(AuthProvider.github);
		let message: vscode.MarkdownString | undefined;
		try {
			const instances = getEnterpriseUris();
			const text = getEnterpriseAuthenticationMessage(remotes, instances, selected);
			const unavailable = remotes.filter(remote => remote.isEnterprise && (!selected || !remote.matchesServerUri(selected)));
			const selectAccount = unavailable.some(remote => instances.some(uri => remote.matchesServerUri(uri)));
			const configure = unavailable.some(remote => !instances.some(uri => remote.matchesServerUri(uri)));
			message = enterpriseSettingsMessage(text, { github: showPublicSignIn, githubEnterprise: selectAccount, configure });
		} catch (error) {
			Logger.error(`GitHub Enterprise configuration is unavailable: ${formatError(error)}`, 'PullRequestsTree');
			message = enterpriseSettingsMessage(vscode.l10n.t('Check your GitHub Enterprise instances in Settings.\n\n{0}', formatError(error)), { github: showPublicSignIn, githubEnterprise: false, configure: true });
		}
		(this._view as vscode.TreeView2<TreeNode>).message = message;
		(this._loginView as vscode.TreeView2<TreeNode>).message = message;
	}

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		if (!this._reposManager?.folderManagers.length) {
			this._view.message = undefined;
			this._loginView.message = undefined;
			return [];
		}

		if (this._reposManager.state === ReposManagerState.Initializing) {
			commands.setContext(contexts.LOADING_PRS_TREE, true);
			return [];
		}

		const remotes = this._reposManager.activeGitHubRemotes;
		if (!element) {
			this.updateEnterpriseAuthenticationMessage(remotes);
		}

		const gitHubFolderManagers = this._reposManager.folderManagers.filter(manager =>
			manager.gitHubRepositories.some(repository => repository.authMatchesServer));
		if (gitHubFolderManagers.length === 0) {
			return this.needsRemotes(remotes);
		}
		if (!element) {
			this._children.forEach(child => child.dispose());

			let result: WorkspaceFolderNode[] | CategoryTreeNode[];
			if (gitHubFolderManagers.length === 1) {
				result = await WorkspaceFolderNode.getCategoryTreeNodes(
					gitHubFolderManagers[0],
					this._telemetry,
					this,
					this._notificationsProvider!,
					this._context,
					this.prsTreeModel,
				);
			} else {
				result = gitHubFolderManagers.map(
					folderManager =>
						new WorkspaceFolderNode(
							this,
							folderManager.repository.rootUri,
							folderManager,
							this._telemetry,
							this._notificationsProvider!,
							this._context,
							this.prsTreeModel
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
