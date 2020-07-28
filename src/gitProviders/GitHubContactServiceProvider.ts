import * as vscode from 'vscode';
import { PullRequestManager } from '../github/pullRequestManager';
import { IAccount } from '../github/interface';

/**
 * The liveshare contact service contract
 */
interface ContactServiceProvider {
	requestAsync(
		type: string,
		parameters: Object,
		cancellationToken?: vscode.CancellationToken)
		: Promise<Object>;

	readonly onNotified: vscode.Event<NotifyContactServiceEventArgs>;
}

interface NotifyContactServiceEventArgs {
	type: string;
	body?: any | undefined;
}

/**
 * The liveshare public contact contract
 */
interface Contact {
	id: string;
	displayName?: string | undefined;
	email?: string | undefined;
}

/**
 * A contact service provider for liveshare that would suggest contacts based on the pull request manager
 */
export class GitHubContactServiceProvider implements ContactServiceProvider {
	private readonly onNotifiedEmitter = new vscode.EventEmitter<NotifyContactServiceEventArgs>();

	public onNotified: vscode.Event<NotifyContactServiceEventArgs> = this.onNotifiedEmitter.event;

	constructor(private readonly pullRequestManager: PullRequestManager) {
		pullRequestManager.folderManagers.forEach(folderManager => {
			folderManager.onDidChangeAssignableUsers(e => {
				this.notifySuggestedAccounts(e);
			});
		});
	}

	public async requestAsync(
		type: string,
		_parameters: Object,
		_cancellationToken?: vscode.CancellationToken)
		: Promise<Object> {
		let result = null;

		switch (type) {
			case 'initialize':
				result = {
					description: 'Pullrequest',
					capabilities: {
						supportsDispose: false,
						supportsInviteLink: false,
						supportsPresence: false,
						supportsContactPresenceRequest: false,
						supportsPublishPresence: false
					}
				};

				// if we get initialized and users are available on the pr manager
				const allAssignableUsers: Map<string, IAccount> = new Map();
				for (const pullRequestManager of this.pullRequestManager.folderManagers) {
					const batch = pullRequestManager.getAllAssignableUsers();
					if (!batch) {
						continue;
					}
					for (const user of batch) {
						if (!allAssignableUsers.has(user.login)) {
							allAssignableUsers.set(user.login, user);
						}
					}
				}
				if (allAssignableUsers.size > 0) {
					this.notifySuggestedAccounts(Array.from(allAssignableUsers.values()));
				}

				break;
			default:
				throw new Error(`type:${type} not supported`);
		}

		return result;
	}

	private async notifySuggestedAccounts(accounts: IAccount[]) {
		const currentLoginUser = await this.getCurrentUserLogin();
		if (currentLoginUser) {
			// Note: only suggest if the current user is part of the aggregated mentionable users
			if (accounts.findIndex(u => u.login === currentLoginUser) !== -1) {
				this.notifySuggestedUsers(accounts
					.filter(u => u.email)
					.map(u => {
						return {
							id: u.login,
							displayName: u.name ? u.name : u.login,
							email: u.email
						};
					}), true);
			}
		}
	}

	private async getCurrentUserLogin(): Promise<string | undefined> {
		if (this.pullRequestManager.folderManagers.length === 0) {
			return undefined;
		}
		const origin = await this.pullRequestManager.folderManagers[0]?.getOrigin();
		if (origin) {
			const currentUser = origin.hub.currentUser;
			if (currentUser) {
				return currentUser.login;
			}
		}
	}

	private notify(type: string, body: any) {
		this.onNotifiedEmitter.fire({
			type,
			body
		});
	}

	private notifySuggestedUsers(contacts: Contact[], exclusive?: boolean) {
		this.notify('suggestedUsers', {
			contacts,
			exclusive
		});
	}
}