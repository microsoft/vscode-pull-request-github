/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Logger from '../common/logger';
import { ChatSessionWithPR } from './copilotApi';
import { CopilotRemoteAgentManager } from './copilotRemoteAgent';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { RepositoriesManager } from './repositoriesManager';

export interface IssueReference {
	readonly number: number;
	readonly nwo?: {
		readonly owner: string;
		readonly repo: string;
	}
}

export interface SessionData {
	id: string;
	title: string;
	status: string;
	dateCreated: string;
	isCurrentBranch?: boolean;
	isTemporary?: boolean;
	isLocal?: boolean;
	branchName?: string;
	repository?: string; // For global dashboard - which repo this session belongs to
	pullRequest?: {
		number: number;
		title: string;
		url: string;
	};
}

export class TaskManager {
	private static readonly ID = 'TaskManager';
	private _temporarySessions: Map<string, SessionData> = new Map();

	constructor(
		private readonly _repositoriesManager: RepositoriesManager,
		private readonly _copilotRemoteAgentManager: CopilotRemoteAgentManager
	) { }

	/**
	 * Gets all active sessions (both local and remote) including temporary ones
	 */
	public async getActiveSessions(targetRepos: string[]): Promise<SessionData[]> {
		try {
			// Get both remote copilot sessions and local task branches
			const [remoteSessions, localTasks] = await Promise.all([
				this.getRemoteSessions(targetRepos),
				this.getLocalTasks()
			]);

			// Combine and deduplicate
			const sessionMap = new Map<string, SessionData>();

			// Add remote sessions
			for (const session of remoteSessions) {
				sessionMap.set(session.id, session);
			}

			// Add local tasks
			for (const task of localTasks) {
				sessionMap.set(task.id, task);
			}

			// Add temporary sessions (they will appear at the top)
			for (const [id, tempSession] of this._temporarySessions) {
				sessionMap.set(id, tempSession);
			}

			// Sort sessions so temporary ones appear first, then by date
			const allSessions = Array.from(sessionMap.values());
			return allSessions.sort((a, b) => {
				// Temporary sessions first
				if (a.isTemporary && !b.isTemporary) return -1;
				if (!a.isTemporary && b.isTemporary) return 1;
				// Then current branch sessions
				if (a.isCurrentBranch && !b.isCurrentBranch) return -1;
				if (!a.isCurrentBranch && b.isCurrentBranch) return 1;
				// Then sort by date (newest first)
				return new Date(b.dateCreated).getTime() - new Date(a.dateCreated).getTime();
			});
		} catch (error) {
			Logger.error(`Failed to get active sessions: ${error}`, TaskManager.ID);
			return [];
		}
	}

	/**
	 * Gets all active sessions from all repositories (for global dashboard)
	 */
	public async getAllSessions(): Promise<SessionData[]> {
		try {
			// Get all repositories instead of filtering by target repos
			const allRepos: string[] = [];

			// Collect all repo identifiers from all folder managers
			for (const folderManager of this._repositoriesManager.folderManagers) {
				for (const githubRepository of folderManager.gitHubRepositories) {
					const repoId = `${githubRepository.remote.owner}/${githubRepository.remote.repositoryName}`;
					if (!allRepos.includes(repoId)) {
						allRepos.push(repoId);
					}
				}
			}

			// Get sessions from all repositories
			const [remoteSessions, localTasks] = await Promise.all([
				this.getRemoteSessions(allRepos),
				this.getLocalTasks()
			]);

			// Enhance remote sessions with repository information
			const enhancedRemoteSessions = remoteSessions.map(session => ({
				...session,
				repository: this.extractRepositoryFromSession(session)
			}));

			// Combine and deduplicate
			const sessionMap = new Map<string, SessionData>();

			// Add enhanced remote sessions
			for (const session of enhancedRemoteSessions) {
				sessionMap.set(session.id, session);
			}

			// Add local tasks
			for (const task of localTasks) {
				sessionMap.set(task.id, task);
			}

			// Add temporary sessions
			for (const [id, tempSession] of this._temporarySessions) {
				sessionMap.set(id, tempSession);
			}

			// Sort sessions so temporary ones appear first, then by date
			const allSessions = Array.from(sessionMap.values());
			return allSessions.sort((a, b) => {
				// Temporary sessions first
				if (a.isTemporary && !b.isTemporary) return -1;
				if (!a.isTemporary && b.isTemporary) return 1;
				// Then current branch sessions
				if (a.isCurrentBranch && !b.isCurrentBranch) return -1;
				if (!a.isCurrentBranch && b.isCurrentBranch) return 1;
				// Then sort by date (newest first)
				return new Date(b.dateCreated).getTime() - new Date(a.dateCreated).getTime();
			});
		} catch (error) {
			Logger.error(`Failed to get all sessions: ${error}`, TaskManager.ID);
			return [];
		}
	}

	private extractRepositoryFromSession(session: SessionData): string | undefined {
		// Try to extract repository name from session title or other metadata
		// This is a simple heuristic - in a real implementation, this might be stored with the session
		const titleMatch = session.title.match(/(\w+\/\w+)/);
		return titleMatch ? titleMatch[1] : undefined;
	}

	private async findPullRequestForBranch(branchName: string): Promise<{ number: number; title: string; url: string } | undefined> {
		try {
			for (const folderManager of this._repositoriesManager.folderManagers) {
				if (folderManager.gitHubRepositories.length === 0) {
					continue;
				}

				// Try each GitHub repository in this folder manager
				for (const githubRepository of folderManager.gitHubRepositories) {
					try {
						// Use the getPullRequestForBranch method to find PRs for this branch
						const pullRequest = await githubRepository.getPullRequestForBranch(branchName, githubRepository.remote.owner);

						if (pullRequest) {
							Logger.debug(`Found PR #${pullRequest.number} for branch ${branchName}`, TaskManager.ID);
							return {
								number: pullRequest.number,
								title: pullRequest.title,
								url: pullRequest.html_url
							};
						}
					} catch (error) {
						Logger.debug(`Failed to find PR for branch ${branchName} in ${githubRepository.remote.owner}/${githubRepository.remote.repositoryName}: ${error}`, TaskManager.ID);
						// Continue to next repository
					}
				}
			}

			Logger.debug(`No PR found for branch ${branchName}`, TaskManager.ID);
			return undefined;
		} catch (error) {
			Logger.debug(`Failed to find PR for branch ${branchName}: ${error}`, TaskManager.ID);
			return undefined;
		}
	}

	/**
	 * Gets local task branches (branches starting with "task/")
	 */
	public async getLocalTasks(): Promise<SessionData[]> {
		try {
			const localTasks: SessionData[] = [];

			// Check each folder manager for task branches
			for (const folderManager of this._repositoriesManager.folderManagers) {
				if (folderManager.gitHubRepositories.length === 0) {
					continue;
				}

				try {
					if (folderManager.repository.getRefs) {
						const refs = await folderManager.repository.getRefs({ pattern: 'refs/heads/' });

						// Filter for task branches
						const taskBranches = refs.filter(ref =>
							ref.name &&
							ref.name.startsWith('task/')
						);

						for (const branch of taskBranches) {
							if (!branch.name) continue;

							// Get branch details
							const currentBranchName = folderManager.repository.state.HEAD?.name;
							const isCurrentBranch = currentBranchName === branch.name;

							// Get commit info for date
							let dateCreated = new Date().toISOString();
							try {
								// For now, use current date - we can enhance this later if needed
								// const commit = await folderManager.repository.getBranch(branch.name);
								// if (commit?.commit?.author?.date) {
								// 	dateCreated = commit.commit.author.date.toISOString();
								// }
							} catch {
								// Use current date if we can't get commit info
							}

							// Create a readable title from branch name
							const taskName = branch.name
								.replace(/^task\//, '')
								.replace(/-/g, ' ')
								.replace(/\b\w/g, l => l.toUpperCase());

							// Check for associated pull request
							let pullRequest: { number: number; title: string; url: string } | undefined = undefined;
							try {
								pullRequest = await this.findPullRequestForBranch(branch.name);
							} catch (error) {
								Logger.debug(`Failed to find PR for branch ${branch.name}: ${error}`, TaskManager.ID);
							}

							localTasks.push({
								id: `local-${branch.name}`,
								title: taskName,
								status: '', // No status badge for local tasks
								dateCreated,
								isCurrentBranch,
								isLocal: true,
								branchName: branch.name,
								pullRequest
							});
						}
					}
				} catch (error) {
					Logger.debug(`Failed to get refs for folder manager: ${error}`, TaskManager.ID);
				}
			}

			return localTasks;
		} catch (error) {
			Logger.error(`Failed to get local tasks: ${error}`, TaskManager.ID);
			return [];
		}
	}

	/**
	 * Gets remote copilot sessions
	 */
	public async getRemoteSessions(targetRepos: string[]): Promise<SessionData[]> {
		try {
			// Create a cancellation token for the request
			const source = new vscode.CancellationTokenSource();
			const token = source.token;

			const sessions = await this._copilotRemoteAgentManager.provideChatSessions(token);
			let filteredSessions = sessions;

			// Filter sessions by repositories if specified
			if (targetRepos.length > 0) {
				filteredSessions = sessions.filter(session => {
					// If session has a pull request, check if it belongs to one of the target repos
					if (session.pullRequest?.html_url) {
						const urlMatch = session.pullRequest.html_url.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/\d+/);
						if (urlMatch) {
							const [, owner, repo] = urlMatch;
							const repoIdentifier = `${owner}/${repo}`;
							return targetRepos.some(targetRepo =>
								targetRepo.toLowerCase() === repoIdentifier.toLowerCase()
							);
						}
					}
					// If no pull request or URL doesn't match pattern, include it
					// (this covers sessions that might not be tied to a specific repo)
					return targetRepos.length === 0;
				});
			}

			// Convert to SessionData format
			const remoteSessions: SessionData[] = [];
			for (const session of filteredSessions) {
				const sessionData = this.convertSessionToData(session);
				remoteSessions.push(sessionData);
			}

			return remoteSessions;
		} catch (error) {
			Logger.error(`Failed to get remote sessions: ${error}`, TaskManager.ID);
			return [];
		}
	}

	/**
	 * Switches to a local task branch
	 */
	public async switchToLocalTask(branchName: string): Promise<void> {
		if (!branchName) {
			return;
		}

		try {
			// Find the folder manager that has this branch
			const folderManager = this._repositoriesManager.folderManagers.find(fm =>
				fm.gitHubRepositories.length > 0
			);

			if (!folderManager) {
				vscode.window.showErrorMessage('No GitHub repository found in the current workspace.');
				return;
			}

			// Switch to the branch
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: `Switching to branch: ${branchName}`,
				cancellable: false
			}, async () => {
				await folderManager.repository.checkout(branchName);
			});

			// Show success message
			vscode.window.showInformationMessage(`Switched to local task: ${branchName}`);

		} catch (error) {
			Logger.error(`Failed to switch to local task: ${error}`, TaskManager.ID);
			vscode.window.showErrorMessage(`Failed to switch to branch: ${error}`);
		}
	}

	/**
	 * Creates a temporary session that shows in the dashboard with a loading state
	 */
	public createTemporarySession(query: string, type: 'local' | 'remote'): string {
		const tempId = `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
		const tempSession: SessionData = {
			id: tempId,
			title: type === 'local' ? `Creating local task: ${query.substring(0, 50)}...` : `Creating remote task: ${query.substring(0, 50)}...`,
			status: 'Creating',
			dateCreated: new Date().toISOString(),
			isTemporary: true
		};

		this._temporarySessions.set(tempId, tempSession);

		return tempId;
	}

	/**
	 * Removes a temporary session from the dashboard
	 */
	public removeTemporarySession(tempId: string): void {
		this._temporarySessions.delete(tempId);
	}

	/**
	 * Sets up local workflow: creates branch and opens chat with agent mode
	 */
	public async setupNewLocalWorkflow(query: string): Promise<void> {
		try {
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: 'Setting up local workflow',
				cancellable: false
			}, async (progress) => {
				progress.report({ message: 'Initializing...', increment: 10 });

				// Get the first available folder manager with a repository
				const folderManager = this._repositoriesManager.folderManagers.find(fm =>
					fm.gitHubRepositories.length > 0
				);

				if (!folderManager) {
					vscode.window.showErrorMessage('No GitHub repository found in the current workspace.');
					return;
				}

				// Generate a logical branch name from the query
				progress.report({ message: 'Generating branch name...', increment: 30 });
				const branchName = await this.generateBranchName(query);

				// Create the branch
				progress.report({ message: `Creating branch: ${branchName}`, increment: 60 });
				await folderManager.repository.createBranch(branchName, true);

				// Create a fresh chat session and open with ask mode
				progress.report({ message: 'Opening chat session...', increment: 90 });
				await vscode.commands.executeCommand('workbench.action.chat.newChat');

				await new Promise<void>(resolve => setTimeout(resolve, 500));

				await vscode.commands.executeCommand('workbench.action.chat.open', {
					query,
					mode: 'agent'
				});

				progress.report({ message: 'Local workflow ready!', increment: 100 });
			});

			// Show success message
			vscode.window.showInformationMessage('Local workflow setup complete! Ready to work on your task.');

		} catch (error) {
			Logger.error(`Failed to setup local workflow: ${error}`, TaskManager.ID);
			vscode.window.showErrorMessage(`Failed to setup local workflow: ${error}`);
		}
	}

	/**
	 * Handles local task for a specific issue - creates branch and opens chat
	 */
	public async handleLocalTaskForIssue(issueNumber: number, issueRef: IssueReference): Promise<void> {
		// Create branch name: task/issue-{number}
		const branchName = `task/issue-${issueNumber}`;

		// Find the appropriate folder manager for this issue
		let folderManager: FolderRepositoryManager | undefined;
		let finalOwner: string;
		let finalRepo: string;

		if (issueRef.nwo) {
			// Full repository reference (owner/repo#123)
			finalOwner = issueRef.nwo.owner;
			finalRepo = issueRef.nwo.repo;

			for (const manager of this._repositoriesManager.folderManagers) {
				try {
					const issueModel = await manager.resolveIssue(issueRef.nwo.owner, issueRef.nwo.repo, issueNumber);
					if (issueModel) {
						folderManager = manager;
						break;
					}
				} catch (error) {
					// Continue looking in other repos
					continue;
				}
			}
		} else {
			// Simple reference (#123) - use current repository
			folderManager = this._repositoriesManager.folderManagers[0];
			if (folderManager && folderManager.gitHubRepositories.length > 0) {
				const repo = folderManager.gitHubRepositories[0];
				finalOwner = repo.remote.owner;
				finalRepo = repo.remote.repositoryName;
			} else {
				vscode.window.showErrorMessage('No repository context found for issue reference.');
				return;
			}
		}

		if (!folderManager) {
			vscode.window.showErrorMessage('Repository not found in local workspace.');
			return;
		}

		// Check if branch already exists
		let branchExists = false;
		try {
			if (folderManager.repository.getRefs) {
				const refs = await folderManager.repository.getRefs({
					contains: undefined,
					count: undefined,
					pattern: undefined,
					sort: undefined
				});
				const existingBranches = new Set(
					refs
						.filter(ref => ref.type === 1 && ref.name) // RefType.Head = 1
						.map(ref => ref.name!)
				);
				branchExists = existingBranches.has(branchName);
			}
		} catch (error) {
			Logger.debug(`Could not fetch branch refs: ${error}`, TaskManager.ID);
		}

		if (branchExists) {
			// Ask user if they want to switch to existing branch
			const switchToBranch = vscode.l10n.t('Switch to Branch');
			const createNewBranch = vscode.l10n.t('Create New Branch');
			const cancel = vscode.l10n.t('Cancel');

			const choice = await vscode.window.showInformationMessage(
				vscode.l10n.t('Branch "{0}" already exists. What would you like to do?', branchName),
				{ modal: true },
				switchToBranch,
				createNewBranch,
				cancel
			);

			if (choice === switchToBranch) {
				await folderManager.repository.checkout(branchName);
				vscode.window.showInformationMessage(vscode.l10n.t('Switched to existing branch: {0}', branchName));
			} else if (choice === createNewBranch) {
				// Generate a unique branch name
				const timestamp = Date.now();
				const uniqueBranchName = `task/issue-${issueNumber}-${timestamp}`;
				await folderManager.repository.createBranch(uniqueBranchName, true);
				vscode.window.showInformationMessage(vscode.l10n.t('Created new branch: {0}', uniqueBranchName));
			} else {
				return; // User cancelled
			}
		} else {
			// Create new branch
			await folderManager.repository.createBranch(branchName, true);
			vscode.window.showInformationMessage(vscode.l10n.t('Created and switched to branch: {0}', branchName));
		}

		// Format the issue URL for the prompt
		const githubUrl = `https://github.com/${finalOwner}/${finalRepo}/issues/${issueNumber}`;
		const formattedPrompt = `Fix ${githubUrl}`;

		// Open agent chat with formatted prompt
		await vscode.commands.executeCommand('workbench.action.chat.open', { query: formattedPrompt });
	}

	/**
	 * Creates a remote background session using the copilot remote agent
	 */
	public async createRemoteBackgroundSession(query: string): Promise<void> {
		try {
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: 'Creating remote coding agent session',
				cancellable: false
			}, async (progress) => {
				progress.report({ message: 'Preparing task...', increment: 20 });

				// Extract the query without @copilot mention
				const cleanQuery = query.replace(/@copilot\s*/, '').trim();

				// Use the copilot remote agent manager to create a new session
				progress.report({ message: 'Creating session with coding agent...', increment: 60 });
				const sessionResult = await this._copilotRemoteAgentManager.provideNewChatSessionItem({
					request: {
						prompt: cleanQuery,
						references: [],
						participant: 'copilot-swe-agent'
					} as any, // Type assertion as we're using this internal API
					prompt: cleanQuery,
					history: [],
					metadata: { source: 'dashboard' }
				}, new vscode.CancellationTokenSource().token);

				// Show confirmation that the task has been created
				if (sessionResult && sessionResult.id) {
					progress.report({ message: 'Session created successfully!', increment: 90 });

					const sessionTitle = sessionResult.label || `Session ${sessionResult.id}`;
					const viewAction = 'View Session';
					const result = await vscode.window.showInformationMessage(
						`Created new coding agent task: ${sessionTitle}`,
						viewAction
					);

					if (result === viewAction) {
						// Open the session if user chooses to view it
						await vscode.window.showChatSession('copilot-swe-agent', sessionResult.id, {});
					}

					progress.report({ message: 'Remote session ready!', increment: 100 });
				} else {
					vscode.window.showErrorMessage('Failed to create coding agent session.');
				}
			});

		} catch (error) {
			Logger.error(`Failed to create remote background session: ${error}`, TaskManager.ID);
			vscode.window.showErrorMessage(`Failed to create coding agent session: ${error}`);
		}
	}

	/**
	 * Determines if a query represents a coding task vs a general question using VS Code's Language Model API
	 */
	public async isCodingTask(query: string): Promise<boolean> {
		try {
			// Try to get a language model for classification
			const models = await vscode.lm.selectChatModels({
				vendor: 'copilot',
				family: 'gpt-4o'
			});

			if (!models || models.length === 0) {
				// Fallback to keyword-based classification if no LM available
				return this.isCodingTaskFallback(query);
			}

			const model = models[0];

			// Create a focused prompt for binary classification
			const classificationPrompt = `You are a classifier that determines whether a user query represents a coding/development task or a general question.

Examples of CODING TASKS:
- "Implement user authentication"
- "Fix the bug in the login function"
- "Add a search feature to the app"
- "Refactor the database connection code"
- "Create unit tests for the API"
- "Debug the memory leak issue"
- "Update the CSS styling"
- "Build a REST endpoint"

Examples of GENERAL QUESTIONS:
- "How does authentication work?"
- "What is a REST API?"
- "Explain the difference between async and sync"
- "What are the benefits of unit testing?"
- "How do I learn React?"
- "What is the best IDE for Python?"

Respond with exactly one word: "CODING" if the query is about implementing, building, fixing, creating, or working on code. "GENERAL" if it's asking for information, explanations, or learning resources.

Query: "${query}"

Classification:`;

			const messages = [vscode.LanguageModelChatMessage.User(classificationPrompt)];

			const response = await model.sendRequest(messages, {
				justification: 'Classifying user query type for workflow routing'
			});

			let result = '';
			for await (const chunk of response.text) {
				result += chunk;
			}

			// Parse the response - look for "CODING" or "GENERAL"
			const cleanResult = result.trim().toUpperCase();
			return cleanResult.includes('CODING');

		} catch (error) {
			Logger.error(`Failed to classify query using LM API: ${error}`, TaskManager.ID);
			// Fallback to keyword-based classification
			return this.isCodingTaskFallback(query);
		}
	}

	/**
	 * Shows a quick pick to let user choose between local and remote work
	 */
	public async showWorkModeQuickPick(): Promise<'local' | 'remote' | undefined> {
		const quickPick = vscode.window.createQuickPick();
		quickPick.title = 'Choose how to work on this task';
		quickPick.placeholder = 'Select whether to work locally or remotely';
		quickPick.items = [
			{
				label: '$(device-desktop) Work locally',
				detail: 'Create a new branch and work in your local environment',
				alwaysShow: true
			},
			{
				label: '$(cloud) Work remotely',
				detail: 'Use GitHub Copilot remote agent to work in the cloud',
				alwaysShow: true
			}
		];

		return new Promise<'local' | 'remote' | undefined>((resolve) => {
			quickPick.onDidAccept(() => {
				const selectedItem = quickPick.selectedItems[0];
				quickPick.hide();
				if (selectedItem) {
					if (selectedItem.label.includes('locally')) {
						resolve('local');
					} else if (selectedItem.label.includes('remotely')) {
						resolve('remote');
					}
				}
				resolve(undefined);
			});

			quickPick.onDidHide(() => {
				quickPick.dispose();
				resolve(undefined);
			});

			quickPick.show();
		});
	}

	/**
	 * Generates a logical branch name from a query using LM API with uniqueness checking
	 */
	public async generateBranchName(query: string): Promise<string> {
		try {
			// Try to get a language model for branch name generation
			const models = await vscode.lm.selectChatModels({
				vendor: 'copilot',
				family: 'gpt-4o'
			});

			let baseName: string;

			if (models && models.length > 0) {
				const model = models[0];

				// Create a focused prompt for branch name generation
				const namePrompt = `Generate a concise, descriptive git branch name for this task. The name should be:
- 3-6 words maximum
- Use kebab-case (lowercase with hyphens)
- Be descriptive but brief
- Follow conventional branch naming patterns
- No special characters except hyphens
- Always start with "task/" prefix

Examples:
- "implement user authentication" → "task/user-authentication"
- "fix login bug" → "task/login-bug"
- "add search functionality" → "task/search-functionality"
- "refactor database code" → "task/database-code"
- "update styling" → "task/styling"

Task: "${query}"

Branch name:`;

				const messages = [vscode.LanguageModelChatMessage.User(namePrompt)];

				const response = await model.sendRequest(messages, {
					justification: 'Generating descriptive branch name for development task'
				});

				let result = '';
				for await (const chunk of response.text) {
					result += chunk;
				}

				// Clean up the LM response
				baseName = result.trim()
					.replace(/^["']|["']$/g, '') // Remove quotes
					.replace(/[^\w\s/-]/g, '') // Remove special characters except hyphens and slashes
					.replace(/\s+/g, '-') // Replace spaces with hyphens
					.replace(/-+/g, '-') // Replace multiple hyphens with single hyphen
					.replace(/^-|-$/g, '') // Remove leading/trailing hyphens
					.toLowerCase();

				// Ensure it starts with task/ prefix
				if (!baseName.startsWith('task/')) {
					// Remove any existing prefix (feature/, fix/, etc.) and replace with task/
					baseName = baseName.replace(/^(feature|fix|refactor|update|bugfix|enhancement)\//, '');
					baseName = `task/${baseName}`;
				}

				// Ensure it has a reasonable length
				if (baseName.length > 50) {
					baseName = baseName.substring(0, 50).replace(/-[^-]*$/, ''); // Cut at word boundary
				}
			} else {
				// Fallback to simple name generation if LM is unavailable
				baseName = this.generateFallbackBranchName(query);
			}

			// Ensure uniqueness by checking existing branches
			return await this.ensureUniqueBranchName(baseName);

		} catch (error) {
			Logger.error(`Failed to generate branch name using LM: ${error}`, TaskManager.ID);
			// Fallback to simple name generation
			const fallbackName = this.generateFallbackBranchName(query);
			return await this.ensureUniqueBranchName(fallbackName);
		}
	}

	/**
	 * Checks if a session is associated with the current branch
	 */
	public isSessionAssociatedWithCurrentBranch(session: ChatSessionWithPR): boolean {
		if (!session.pullRequest) {
			return false;
		}

		// Parse the PR URL to get owner and repo
		const urlMatch = session.pullRequest.html_url.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
		if (!urlMatch) {
			return false;
		}

		const [, owner, repo] = urlMatch;
		const prNumber = session.pullRequest.number;

		// Check if any folder manager has this PR checked out on current branch
		for (const folderManager of this._repositoriesManager.folderManagers) {
			// Check if this folder manager manages the target repo
			if (this.folderManagerMatchesRepo(folderManager, owner, repo)) {
				// Check if the current branch corresponds to this PR
				const currentBranchName = folderManager.repository.state.HEAD?.name;
				if (currentBranchName) {
					// Try to find the PR model for this session
					try {
						// Use the active PR if it matches
						if (folderManager.activePullRequest?.number === prNumber) {
							return true;
						}
						// Also check if the branch name suggests it's a PR branch
						// Common patterns: pr-123, pull/123, etc.
						const prBranchPatterns = [
							new RegExp(`pr-${prNumber}$`, 'i'),
							new RegExp(`pull/${prNumber}$`, 'i'),
							new RegExp(`pr/${prNumber}$`, 'i')
						];
						for (const pattern of prBranchPatterns) {
							if (pattern.test(currentBranchName)) {
								return true;
							}
						}
					} catch (error) {
						// Ignore errors in checking PR association
					}
				}
			}
		}

		return false;
	}

	// Private helper methods

	private convertSessionToData(session: ChatSessionWithPR): SessionData {
		const isCurrentBranch = this.isSessionAssociatedWithCurrentBranch(session);

		// Map ChatSessionStatus enum to meaningful status strings
		let status = '';
		if (session.status !== undefined) {
			switch (session.status) {
				case 0: // Failed
					status = 'Failed';
					break;
				case 1: // Completed
					status = 'Completed';
					break;
				case 2: // InProgress
					status = 'In Progress';
					break;
				default:
					status = 'Unknown';
			}
		}

		return {
			id: session.id,
			title: session.label,
			status,
			dateCreated: session.timing?.startTime ? new Date(session.timing.startTime).toISOString() : '',
			isCurrentBranch,
			pullRequest: session.pullRequest ? {
				number: session.pullRequest.number,
				title: session.pullRequest.title,
				url: session.pullRequest.html_url
			} : undefined
		};
	}

	private isCodingTaskFallback(query: string): boolean {
		const codingKeywords = [
			'implement', 'create', 'add', 'build', 'develop', 'code', 'write',
			'fix', 'debug', 'resolve', 'solve', 'repair',
			'refactor', 'optimize', 'improve', 'enhance', 'update',
			'feature', 'function', 'method', 'class', 'component',
			'api', 'endpoint', 'service', 'module', 'library',
			'test', 'testing', 'unit test', 'integration test',
			'bug', 'issue', 'error', 'exception', 'crash'
		];

		const lowercaseQuery = query.toLowerCase();
		return codingKeywords.some(keyword => lowercaseQuery.includes(keyword));
	}

	private generateFallbackBranchName(query: string): string {
		// Clean up the query to create a branch-friendly name
		const cleaned = query
			.toLowerCase()
			.replace(/[^\w\s-]/g, '') // Remove special characters except hyphens
			.replace(/\s+/g, '-') // Replace spaces with hyphens
			.replace(/-+/g, '-') // Replace multiple hyphens with single hyphen
			.replace(/^-|-$/g, ''); // Remove leading/trailing hyphens

		// Truncate to reasonable length
		const truncated = cleaned.length > 40 ? cleaned.substring(0, 40) : cleaned;

		return `task/${truncated}`;
	}

	private async ensureUniqueBranchName(baseName: string): Promise<string> {
		try {
			// Get the first available folder manager with a repository
			const folderManager = this._repositoriesManager.folderManagers.find(fm =>
				fm.gitHubRepositories.length > 0
			);

			if (!folderManager) {
				// If no repository available, just add timestamp for uniqueness
				const timestamp = Date.now().toString().slice(-6);
				return `${baseName}-${timestamp}`;
			}

			// Get existing branch names
			let existingBranches = new Set<string>();
			try {
				if (folderManager.repository.getRefs) {
					const refs = await folderManager.repository.getRefs({
						contains: undefined,
						count: undefined,
						pattern: undefined,
						sort: undefined
					});
					existingBranches = new Set(
						refs
							.filter(ref => ref.type === 1 && ref.name) // RefType.Head and has name
							.map(ref => ref.name!)
					);
				}
			} catch (error) {
				Logger.debug(`Could not fetch branch refs: ${error}`, TaskManager.ID);
				// Continue with empty set - will use timestamp for uniqueness
			}

			// Check if base name is unique
			if (!existingBranches.has(baseName)) {
				return baseName;
			}

			// If not unique, try adding numeric suffixes
			for (let i = 2; i <= 99; i++) {
				const candidateName = `${baseName}-${i}`;
				if (!existingBranches.has(candidateName)) {
					return candidateName;
				}
			}

			// If still not unique after 99 attempts, add timestamp
			const timestamp = Date.now().toString().slice(-6);
			return `${baseName}-${timestamp}`;

		} catch (error) {
			Logger.error(`Failed to check branch uniqueness: ${error}`, TaskManager.ID);
			// Fallback to timestamp-based uniqueness
			const timestamp = Date.now().toString().slice(-6);
			return `${baseName}-${timestamp}`;
		}
	}

	private folderManagerMatchesRepo(folderManager: FolderRepositoryManager, owner: string, repo: string): boolean {
		// Check if the folder manager manages a repository that matches the owner/repo
		for (const repository of folderManager.gitHubRepositories) {
			if (repository.remote.owner.toLowerCase() === owner.toLowerCase() &&
				repository.remote.repositoryName.toLowerCase() === repo.toLowerCase()) {
				return true;
			}
		}
		return false;
	}
}