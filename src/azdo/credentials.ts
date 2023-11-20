import * as azdev from 'azure-devops-node-api';
import { IRequestHandler } from 'azure-devops-node-api/interfaces/common/VsoBaseInterfaces';
import { Identity } from 'azure-devops-node-api/interfaces/IdentitiesInterfaces';
import * as vscode from 'vscode';
import { AuthenticationOptions, AuthenticationScopes } from '../authentication/configuration';
import Logger from '../common/logger';
import { ITelemetry } from '../common/telemetry';
import { SETTINGS_NAMESPACE } from '../constants';

const CREDENTIALS_COMPONENT_ID = 'azdo_component';
const PROJECT_SETTINGS = 'projectName';
const ORGURL_SETTINGS = 'orgUrl';

export class Azdo {
	private _authHandler: IRequestHandler;
	public connection: azdev.WebApi;
	public authenticatedUser: Identity | undefined;

	constructor(public orgUrl: string, public projectName: string, token: string) {
		this._authHandler = azdev.getPersonalAccessTokenHandler(token, true);
		this.connection = this.getNewWebApiClient(this.orgUrl);
	}

	public getNewWebApiClient(orgUrl: string): azdev.WebApi {
		return new azdev.WebApi(orgUrl, this._authHandler);
	}
}

export class CredentialStore implements vscode.Disposable {
	static ID = 'AzdoRepository';
	private _azdoAPI: Azdo | undefined;
	private _orgUrl: string | undefined;
	private _disposables: vscode.Disposable[];
	private _onDidInitialize: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public readonly onDidInitialize: vscode.Event<void> = this._onDidInitialize.event;

	private static PAT_TOKEN_KEY = 'azdoRepo.pat.';

	constructor(private readonly _telemetry: ITelemetry, private readonly _secretStore: vscode.SecretStorage) {
		this._disposables = [];
		// this._disposables.push(vscode.authentication.onDidChangeSessions(() => {
		// 	if (!this.isAuthenticated()) {
		// 		return this.initialize();
		// 	}
		// }));

		this._disposables.push(
			_secretStore.onDidChange(e => {
				const tokenKey = this.getTokenKey();
				if (e.key === tokenKey && !this.isAuthenticated()) {
					return this.initialize();
				}
			}),
		);
	}

	public async initialize(): Promise<void> {
		this._azdoAPI = await this.login();
	}

	public async reset() {
		this._azdoAPI = undefined;
		await this.initialize();
	}

	public isAuthenticated(): boolean {
		return !!this._azdoAPI;
	}

	public getHub(): Azdo | undefined {
		return this._azdoAPI;
	}

	private async requestPersonalAccessToken(): Promise<string | undefined> {
		// Based on https://github.com/microsoft/azure-repos-vscode/blob/6bc90f0853086623486d0e527e9fe5a577370e9b/src/team-extension.ts#L74

		const session = await vscode.authentication.getSession('microsoft', AuthenticationScopes, AuthenticationOptions);
		const token = session.accessToken;

		vscode.window.showInformationMessage('Successfully authorized extension in DevOps');

		if (token) {
			this._telemetry.sendTelemetryEvent('auth.manual');
		}
		return token;
	}

	public async logout(): Promise<void> {
		// if (this._sessionId) {
		// 	vscode.authentication.logout('github', this._sessionId);
		// }

		await this._secretStore.delete(this.getTokenKey(this._orgUrl ?? ''));
		this._azdoAPI = undefined;
	}

	public getTokenKey(orgUrl?: string): string {
		let url = this._orgUrl ?? '';
		if (!!orgUrl) {
			url = orgUrl;
		}
		return CredentialStore.PAT_TOKEN_KEY.concat(url);
	}

	public async login(): Promise<Azdo | undefined> {
		/* __GDPR__
			"auth.start" : {}
		*/
		this._telemetry.sendTelemetryEvent('auth.start');

		const projectName = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<string | undefined>(PROJECT_SETTINGS);
		if (!projectName) {
			Logger.appendLine('Project name is not provided', CredentialStore.ID);
			this._telemetry.sendTelemetryEvent('auth.failed');
			return undefined;
		}
		Logger.appendLine(`projectName is ${projectName}`, CredentialStore.ID);

		this._orgUrl = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<string | undefined>(ORGURL_SETTINGS);
		if (!this._orgUrl) {
			Logger.appendLine('orgUrl is not provided', CredentialStore.ID);
			this._telemetry.sendTelemetryEvent('auth.failed');
			return undefined;
		}
		Logger.appendLine(`orgUrl is ${this._orgUrl}`, CredentialStore.ID);

		const tokenKey = this.getTokenKey(this._orgUrl);
		const token = await this.getToken(tokenKey);

		if (!token) {
			Logger.appendLine('PAT token is not provided');
			this._telemetry.sendTelemetryEvent('auth.failed');
			return undefined;
		}

		try {
			const azdo = new Azdo(this._orgUrl, projectName, token);
			azdo.authenticatedUser = (await azdo.connection.connect()).authenticatedUser;

			Logger.debug(`Auth> Successful: Logged userid: ${azdo?.authenticatedUser?.id}`, CredentialStore.ID);
			this._telemetry.sendTelemetryEvent('auth.success');

			return azdo;
		} catch (e) {
			await this._secretStore.delete(tokenKey);
			vscode.window.showErrorMessage('Unable to authenticate. Signout and try again.');
			return undefined;
		}
	}

	private async getToken(tokenKey: string): Promise<string | undefined> {
		let token = await this._secretStore.get(tokenKey);
		if (!token) {
			token = await this.requestPersonalAccessToken();
			if (!!token) {
				this._secretStore.store(tokenKey, token);
			}
		}
		return token;
	}

	public getAuthenticatedUser(): Identity | undefined {
		return this._azdoAPI?.authenticatedUser;
	}

	dispose() {
		this._disposables.forEach(disposable => disposable.dispose());
	}
}
