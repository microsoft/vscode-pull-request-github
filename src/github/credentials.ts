/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Octokit } from '@octokit/rest';
import { ApolloClient, InMemoryCache } from 'apollo-boost';
import { setContext } from 'apollo-link-context';
import { createHttpLink } from 'apollo-link-http';
import fetch from 'cross-fetch';
import * as vscode from 'vscode';
import { AuthProvider } from '../common/authentication';
import Logger from '../common/logger';
import * as PersistentState from '../common/persistentState';
import { ITelemetry } from '../common/telemetry';
import { agent } from '../env/node/net';
import { IAccount } from './interface';
import { LoggingApolloClient, LoggingOctokit, RateLogger } from './loggingOctokit';
import defaultSchema from './queries.gql';
import { getEnterpriseUri, hasEnterpriseUri } from './utils';

const TRY_AGAIN = vscode.l10n.t('Try again?');
const CANCEL = vscode.l10n.t('Cancel');
const SIGNIN_COMMAND = vscode.l10n.t('Sign In');
const IGNORE_COMMAND = vscode.l10n.t('Don\'t Show Again');

const PROMPT_FOR_SIGN_IN_SCOPE = vscode.l10n.t('prompt for sign in');
const PROMPT_FOR_SIGN_IN_STORAGE_KEY = 'login';

// If the scopes are changed, make sure to notify all interested parties to make sure this won't cause problems.
const SCOPES_OLD = ['read:user', 'user:email', 'repo'];
export const SCOPES = ['read:user', 'user:email', 'repo', 'workflow'];

export interface GitHub {
	octokit: LoggingOctokit;
	graphql: LoggingApolloClient;
	currentUser?: Promise<IAccount>;
}

export class CredentialStore implements vscode.Disposable {
	private _githubAPI: GitHub | undefined;
	private _sessionId: string | undefined;
	private _githubEnterpriseAPI: GitHub | undefined;
	private _enterpriseSessionId: string | undefined;
	private _disposables: vscode.Disposable[];
	private _onDidInitialize: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public readonly onDidInitialize: vscode.Event<void> = this._onDidInitialize.event;

	private _onDidGetSession: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public readonly onDidGetSession = this._onDidGetSession.event;

	constructor(private readonly _telemetry: ITelemetry, private readonly _context: vscode.ExtensionContext) {
		this._disposables = [];
		this._disposables.push(
			vscode.authentication.onDidChangeSessions(async () => {
				const promises: Promise<any>[] = [];
				if (!this.isAuthenticated(AuthProvider.github)) {
					promises.push(this.initialize(AuthProvider.github));
				}

				if (!this.isAuthenticated(AuthProvider['github-enterprise']) && hasEnterpriseUri()) {
					promises.push(this.initialize(AuthProvider['github-enterprise']));
				}

				await Promise.all(promises);
				if (this.isAnyAuthenticated()) {
					this._onDidGetSession.fire();
				}
			}),
		);
	}

	private async initialize(authProviderId: AuthProvider, getAuthSessionOptions: vscode.AuthenticationGetSessionOptions = {}): Promise<void> {
		if (authProviderId === AuthProvider['github-enterprise']) {
			if (!hasEnterpriseUri()) {
				Logger.debug(`GitHub Enterprise provider selected without URI.`, 'Authentication');
				return;
			}
		}

		if (getAuthSessionOptions.createIfNone === undefined) {
			getAuthSessionOptions.createIfNone = false;
		}

		let session: vscode.AuthenticationSession | undefined = undefined;
		let isNew: boolean = false;
		try {
			const result = await this.getSession(authProviderId, getAuthSessionOptions);
			session = result.session;
			isNew = result.isNew;
		} catch (e) {
			if (getAuthSessionOptions.forceNewSession && (e.message === 'User did not consent to login.')) {
				// There are cases where a forced login may not be 100% needed, so just continue as usual if
				// the user didn't consent to the login prompt.
			} else {
				throw e;
			}
		}

		if (session) {
			if (authProviderId === AuthProvider.github) {
				this._sessionId = session.id;
			} else {
				this._enterpriseSessionId = session.id;
			}
			let github: GitHub | undefined;
			try {
				github = await this.createHub(session.accessToken, authProviderId);
			} catch (e) {
				if ((e.message === 'Bad credentials') && !getAuthSessionOptions.forceNewSession) {
					getAuthSessionOptions.forceNewSession = true;
					getAuthSessionOptions.silent = false;
					return this.initialize(authProviderId, getAuthSessionOptions);
				}
			}
			if (authProviderId === AuthProvider.github) {
				this._githubAPI = github;
			} else {
				this._githubEnterpriseAPI = github;
			}

			if (!(getAuthSessionOptions.createIfNone || getAuthSessionOptions.forceNewSession) || isNew) {
				this._onDidInitialize.fire();
			}
		} else {
			Logger.debug(`No GitHub${getGitHubSuffix(authProviderId)} token found.`, 'Authentication');
		}
	}

	private async doCreate(options: vscode.AuthenticationGetSessionOptions) {
		await this.initialize(AuthProvider.github, options);
		if (hasEnterpriseUri()) {
			await this.initialize(AuthProvider['github-enterprise'], options);
		}
	}

	public async create(options: vscode.AuthenticationGetSessionOptions = {}) {
		return this.doCreate(options);
	}

	public async recreate(reason?: string) {
		return this.doCreate({ forceNewSession: reason ? { detail: reason } : true });
	}

	public async reset() {
		this._githubAPI = undefined;
		this._githubEnterpriseAPI = undefined;
		return this.create();
	}

	public isAnyAuthenticated() {
		return this.isAuthenticated(AuthProvider.github) || this.isAuthenticated(AuthProvider['github-enterprise']);
	}

	public isAuthenticated(authProviderId: AuthProvider): boolean {
		if (authProviderId === AuthProvider.github) {
			return !!this._githubAPI;
		}
		return !!this._githubEnterpriseAPI;
	}

	public getHub(authProviderId: AuthProvider): GitHub | undefined {
		if (authProviderId === AuthProvider.github) {
			return this._githubAPI;
		}
		return this._githubEnterpriseAPI;
	}

	public async getHubOrLogin(authProviderId: AuthProvider): Promise<GitHub | undefined> {
		if (authProviderId === AuthProvider.github) {
			return this._githubAPI ?? (await this.login(authProviderId));
		}
		return this._githubEnterpriseAPI ?? (await this.login(authProviderId));
	}

	public async showSignInNotification(authProviderId: AuthProvider): Promise<GitHub | undefined> {
		if (PersistentState.fetch(PROMPT_FOR_SIGN_IN_SCOPE, PROMPT_FOR_SIGN_IN_STORAGE_KEY) === false) {
			return;
		}

		const result = await vscode.window.showInformationMessage(
			vscode.l10n.t('In order to use the Pull Requests functionality, you must sign in to GitHub{0}', getGitHubSuffix(authProviderId)),
			SIGNIN_COMMAND,
			IGNORE_COMMAND,
		);

		if (result === SIGNIN_COMMAND) {
			return await this.login(authProviderId);
		} else {
			// user cancelled sign in, remember that and don't ask again
			PersistentState.store(PROMPT_FOR_SIGN_IN_SCOPE, PROMPT_FOR_SIGN_IN_STORAGE_KEY, false);

			/* __GDPR__
				"auth.cancel" : {}
			*/
			this._telemetry.sendTelemetryEvent('auth.cancel');
		}
	}

	public async login(authProviderId: AuthProvider): Promise<GitHub | undefined> {
		/* __GDPR__
			"auth.start" : {}
		*/
		this._telemetry.sendTelemetryEvent('auth.start');

		const errorPrefix = vscode.l10n.t('Error signing in to GitHub{0}', getGitHubSuffix(authProviderId));
		let retry: boolean = true;
		let octokit: GitHub | undefined = undefined;
		const sessionOptions: vscode.AuthenticationGetSessionOptions = { createIfNone: true };

		while (retry) {
			try {
				await this.initialize(authProviderId, sessionOptions);
			} catch (e) {
				Logger.error(`${errorPrefix}: ${e}`);
				if (e instanceof Error && e.stack) {
					Logger.error(e.stack);
				}
			}
			octokit = this.getHub(authProviderId);
			if (octokit) {
				retry = false;
			} else {
				retry = (await vscode.window.showErrorMessage(errorPrefix, TRY_AGAIN, CANCEL)) === TRY_AGAIN;
				if (retry) {
					sessionOptions.forceNewSession = true;
				}
			}
		}

		if (octokit) {
			/* __GDPR__
				"auth.success" : {}
			*/
			this._telemetry.sendTelemetryEvent('auth.success');
		} else {
			/* __GDPR__
				"auth.fail" : {}
			*/
			this._telemetry.sendTelemetryEvent('auth.fail');
		}

		return octokit;
	}

	public async showSamlMessageAndAuth() {
		return this.recreate(vscode.l10n.t('GitHub Pull Requests and Issues requires that you provide SAML access to your organization when you sign in.'));
	}

	public async isCurrentUser(username: string): Promise<boolean> {
		return (await this._githubAPI?.currentUser)?.login === username || (await this._githubEnterpriseAPI?.currentUser)?.login == username;
	}

	public getCurrentUser(authProviderId: AuthProvider): Promise<IAccount> {
		const github = this.getHub(authProviderId);
		const octokit = github?.octokit;
		return (octokit && github?.currentUser)!;
	}

	private setCurrentUser(github: GitHub): void {
		github.currentUser = new Promise(resolve => {
			github.graphql.query({ query: (defaultSchema as any).Viewer }).then(result => {
				resolve(result.data.viewer);
			});
		});
	}

	private async getSession(authProviderId: AuthProvider, getAuthSessionOptions: vscode.AuthenticationGetSessionOptions): Promise<{ session: vscode.AuthenticationSession | undefined, isNew: boolean }> {
		let session: vscode.AuthenticationSession | undefined = await vscode.authentication.getSession(authProviderId, SCOPES, { silent: true });
		if (session) {
			return { session, isNew: false };
		}

		if (getAuthSessionOptions.createIfNone) {
			const silent = getAuthSessionOptions.silent;
			getAuthSessionOptions.createIfNone = false;
			getAuthSessionOptions.silent = true;
			session = await vscode.authentication.getSession(authProviderId, SCOPES_OLD, getAuthSessionOptions);
			if (!session) {
				getAuthSessionOptions.createIfNone = true;
				getAuthSessionOptions.silent = silent;
				session = await vscode.authentication.getSession(authProviderId, SCOPES, getAuthSessionOptions);
			}
		} else {
			session = await vscode.authentication.getSession(authProviderId, SCOPES_OLD, getAuthSessionOptions);
		}

		return { session, isNew: !!session };
	}

	private async getSessionOrLogin(authProviderId: AuthProvider): Promise<string> {
		const session = (await this.getSession(authProviderId, { createIfNone: true })).session!;
		if (authProviderId === AuthProvider.github) {
			this._sessionId = session.id;
		} else {
			this._enterpriseSessionId = session.id;
		}
		return session.accessToken;
	}

	private async createHub(token: string, authProviderId: AuthProvider): Promise<GitHub> {
		let baseUrl = 'https://api.github.com';
		let enterpriseServerUri: vscode.Uri | undefined;
		if (authProviderId === AuthProvider['github-enterprise']) {
			enterpriseServerUri = getEnterpriseUri();
		}

		if (enterpriseServerUri) {
			baseUrl = `${enterpriseServerUri.scheme}://${enterpriseServerUri.authority}/api/v3`;
		}

		let fetchCore: ((url: string, options: { headers?: Record<string, string> }) => any) | undefined;
		if (vscode.env.uiKind === vscode.UIKind.Web) {
			fetchCore = (url: string, options: { headers?: Record<string, string> }) => {
				if (options.headers !== undefined) {
					const { 'user-agent': userAgent, ...headers } = options.headers;
					if (userAgent) {
						options.headers = headers;
					}
				}
				return fetch(url, options);
			};
		}

		const octokit = new Octokit({
			request: { agent, fetch: fetchCore },
			userAgent: 'GitHub VSCode Pull Requests',
			// `shadow-cat-preview` is required for Draft PR API access -- https://developer.github.com/v3/previews/#draft-pull-requests
			previews: ['shadow-cat-preview', 'merge-info-preview'],
			auth: `${token || ''}`,
			baseUrl: baseUrl,
		});

		if (enterpriseServerUri) {
			baseUrl = `${enterpriseServerUri.scheme}://${enterpriseServerUri.authority}/api`;
		}

		const graphql = new ApolloClient({
			link: link(baseUrl, token || ''),
			cache: new InMemoryCache(),
			defaultOptions: {
				query: {
					fetchPolicy: 'no-cache',
				},
			},
		});

		const rateLogger = new RateLogger(this._context);
		const github: GitHub = {
			octokit: new LoggingOctokit(octokit, rateLogger),
			graphql: new LoggingApolloClient(graphql, rateLogger),
		};
		this.setCurrentUser(github);
		return github;
	}

	dispose() {
		this._disposables.forEach(disposable => disposable.dispose());
	}
}

const link = (url: string, token: string) =>
	setContext((_, { headers }) => ({
		headers: {
			...headers,
			authorization: token ? `Bearer ${token}` : '',
			Accept: 'application/vnd.github.merge-info-preview'
		},
	})).concat(
		createHttpLink({
			uri: `${url}/graphql`,
			// https://github.com/apollographql/apollo-link/issues/513
			fetch: fetch as any,
		}),
	);

function getGitHubSuffix(authProviderId: AuthProvider) {
	return authProviderId === AuthProvider.github ? '' : ' Enterprise';
}
