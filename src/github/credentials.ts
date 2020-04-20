/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Octokit = require('@octokit/rest');
import { ApolloClient, InMemoryCache, NormalizedCacheObject } from 'apollo-boost';
import { setContext } from 'apollo-link-context';
import * as vscode from 'vscode';
import { agent } from '../common/net';
import { Remote } from '../common/remote';
import Logger from '../common/logger';
import * as PersistentState from '../common/persistentState';
import { createHttpLink } from 'apollo-link-http';
import fetch from 'node-fetch';
import { ITelemetry } from '../common/telemetry';

const TRY_AGAIN = 'Try again?';
const SIGNIN_COMMAND = 'Sign in';
const IGNORE_COMMAND = 'Don\'t show again';

const PROMPT_FOR_SIGN_IN_SCOPE = 'prompt for sign in';

const AUTH_PROVIDER_ID = 'github';
const SCOPES = ['read:user', 'user:email', 'repo', 'write:discussion'];

export interface AnnotatedOctokit extends Octokit {
	currentUser?: Octokit.PullsGetResponseUser;
}

export interface GitHub {
	octokit: AnnotatedOctokit;
	graphql: ApolloClient<NormalizedCacheObject> | null;
}

export class CredentialStore {
	private _octokits: Map<string, GitHub | undefined>;

	constructor(private readonly _telemetry: ITelemetry) {
		this._octokits = new Map<string, GitHub>();
	}

	public reset() {
		this._octokits = new Map<string, GitHub>();
	}

	public async hasOctokit(remote: Remote): Promise<boolean> {
		// the remote url might be http[s]/git/ssh but we always go through https for the api
		// so use a normalized http[s] url regardless of the original protocol
		const normalizedUri = remote.gitProtocol.normalizeUri()!;
		const host = `${normalizedUri.scheme}://${normalizedUri.authority}`;

		if (this._octokits.has(host)) {
			return true;
		}

		const existingSessions = await vscode.authentication.getSessions(AUTH_PROVIDER_ID, SCOPES);

		if (existingSessions.length) {
			const token = await existingSessions[0].getAccessToken();
			const octokit = await this.createHub(token);
			this._octokits.set(host, octokit);
			await this.setCurrentUser(octokit.octokit);
		} else {
			Logger.debug(`No token found for host ${host}.`, 'Authentication');
		}

		return this._octokits.has(host);
	}

	public getHub(remote: Remote): GitHub | undefined {
		const normalizedUri = remote.gitProtocol.normalizeUri()!;
		const host = `${normalizedUri.scheme}://${normalizedUri.authority}`;
		return this._octokits.get(host);
	}

	public getOctokit(remote: Remote): AnnotatedOctokit | undefined {
		const hub = this.getHub(remote);
		return hub && hub.octokit;
	}

	public getGraphQL(remote: Remote) {
		const hub = this.getHub(remote);
		return hub && hub.graphql;
	}

	public async loginWithConfirmation(remote: Remote): Promise<GitHub | undefined> {
		const normalizedUri = remote.gitProtocol.normalizeUri()!;
		const storageKey = `${normalizedUri.scheme}://${normalizedUri.authority}`;

		if (PersistentState.fetch(PROMPT_FOR_SIGN_IN_SCOPE, storageKey) === false) {
			return;
		}

		const result = await vscode.window.showInformationMessage(
			`In order to use the Pull Requests functionality, you must sign in to ${normalizedUri.authority}`,
			SIGNIN_COMMAND, IGNORE_COMMAND);

		if (result === SIGNIN_COMMAND) {
			return await this.login(remote);
		} else {
			this._octokits.set(storageKey, undefined);
			// user cancelled sign in, remember that and don't ask again
			PersistentState.store(PROMPT_FOR_SIGN_IN_SCOPE, storageKey, false);

			/* __GDPR__
				"auth.cancel" : {}
			*/
			this._telemetry.sendTelemetryEvent('auth.cancel');
		}
	}

	private async getSessionOrLogin(): Promise<string> {
		const authenticationSessions = await vscode.authentication.getSessions(AUTH_PROVIDER_ID, SCOPES);
		if (authenticationSessions.length) {
			return await authenticationSessions[0].getAccessToken();
		} else {
			const session = await vscode.authentication.login(AUTH_PROVIDER_ID, SCOPES);
			return session.getAccessToken();
		}
	}

	public async login(remote: Remote): Promise<GitHub | undefined> {

		/* __GDPR__
			"auth.start" : {}
		*/
		this._telemetry.sendTelemetryEvent('auth.start');

		// the remote url might be http[s]/git/ssh but we always go through https for the api
		// so use a normalized http[s] url regardless of the original protocol
		const { scheme, authority } = remote.gitProtocol.normalizeUri()!;
		const host = `${scheme}://${authority}`;

		let retry: boolean = true;
		let octokit: GitHub | undefined = undefined;

		while (retry) {
			try {
				const token = await this.getSessionOrLogin();
				octokit = await this.createHub(token);
			} catch (e) {
				Logger.appendLine(`Error signing in to ${authority}: ${e}`);
				if (e instanceof Error && e.stack) {
					Logger.appendLine(e.stack);
				}
			}

			if (octokit) {
				retry = false;
			} else {
				retry = (await vscode.window.showErrorMessage(`Error signing in to ${authority}`, TRY_AGAIN)) === TRY_AGAIN;
			}
		}

		if (octokit) {
			this._octokits.set(host, octokit);
			await this.setCurrentUser(octokit.octokit);

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

	public isCurrentUser(username: string, remote: Remote): boolean {
		const octokit = this.getOctokit(remote);
		return !!octokit && !!octokit.currentUser && octokit.currentUser.login === username;
	}

	private async setCurrentUser(octokit: AnnotatedOctokit): Promise<void> {
		const user = await octokit.users.getAuthenticated({});
		octokit.currentUser = user.data;
	}

	public getCurrentUser(remote: Remote): Octokit.PullsGetResponseUser {
		const octokit = this.getOctokit(remote);
		// TODO remove cast
		return octokit && (octokit as any).currentUser;
	}

	private async createHub(token: string): Promise<GitHub> {
		const octokit = new Octokit({
			request: { agent },
			userAgent: 'GitHub VSCode Pull Requests',
			// `shadow-cat-preview` is required for Draft PR API access -- https://developer.github.com/v3/previews/#draft-pull-requests
			previews: ['shadow-cat-preview'],
			auth() {
				return `token ${token || ''}`;
			}
		});

		const graphql = new ApolloClient({
			link: link('https://api.github.com', token || ''),
			cache: new InMemoryCache,
			defaultOptions: {
				query: {
					fetchPolicy: 'no-cache'
				}
			}
		});

		return {
			octokit,
			graphql
		};
	}
}

const link = (url: string, token: string) =>
	setContext((_, { headers }) => (({
		headers: {
			...headers,
			authorization: token ? `Bearer ${token}` : '',
			Accept: 'application/vnd.github.shadow-cat-preview+json'
		}
	}))).concat(createHttpLink({
		uri: `${url}/graphql`,
		// https://github.com/apollographql/apollo-link/issues/513
		fetch: fetch as any
	}));