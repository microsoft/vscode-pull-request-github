import * as azdev from 'azure-devops-node-api';
import { IRequestHandler } from 'azure-devops-node-api/interfaces/common/VsoBaseInterfaces';
import { Identity } from 'azure-devops-node-api/interfaces/IdentitiesInterfaces';
import * as vscode from 'vscode';
import Logger from '../common/logger';
import { ITelemetry } from '../common/telemetry';
import { SETTINGS_NAMESPACE } from '../constants';

const CREDENTIALS_COMPONENT_ID = 'azdo_component';
const PROJECT_SETTINGS = 'projectName';
const ORGURL_SETTINGS = 'orgUrl';
const TRY_AGAIN = vscode.l10n.t('Try again?');
const CANCEL = vscode.l10n.t('Cancel');
const ERROR = vscode.l10n.t('Error signing in to Azure DevOps');

export class Azdo {
	private _authHandler: IRequestHandler;
	public connection: azdev.WebApi;
	public authenticatedUser: Identity | undefined;

	constructor(public orgUrl: string, public projectName: string, token: string) {
		this._authHandler = azdev.getBearerHandler(token, true);
		// this._authHandler = azdev.getPersonalAccessTokenHandler(token, true);
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
	private _sessionId: string | undefined;
	private _sessionOptions: vscode.AuthenticationGetSessionOptions = { createIfNone: true };

	constructor(private readonly _telemetry: ITelemetry, private readonly _secretStore: vscode.SecretStorage) {
		this._disposables = [];
		this._disposables.push(
			vscode.authentication.onDidChangeSessions(async () => {
				if (!this.isAuthenticated()) {
					return await this.initialize();
				}
			}),
		);
	}

	public async initialize(): Promise<void> {
		this._azdoAPI = await this.login();
	}

	public async reset() {
		this._sessionOptions.forceNewSession = true;
		this._sessionOptions.createIfNone = false;
		this._sessionOptions.clearSessionPreference = true;
		await this.initialize();
	}

	public isAuthenticated(): boolean {
		return !!this._azdoAPI;
	}

	public getHub(): Azdo | undefined {
		return this._azdoAPI;
	}

	public async logout(): Promise<void> {
		this._azdoAPI = undefined;
		this._sessionOptions.forceNewSession = true;
		this._sessionOptions.createIfNone = false;
		this._sessionOptions.clearSessionPreference = true;
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

		let retry: boolean = true;

		while (retry) {
			try
			{
				const session = await this.getSession(this._sessionOptions);
				if (!session) {
					Logger.appendLine('Auth> Unable to get session', CredentialStore.ID);
					this._telemetry.sendTelemetryEvent('auth.failed');
					return undefined;
				}
				this._sessionId = session.id;
				const token = await this.getToken(session);

				if (!token) {
					Logger.appendLine('Auth> Unable to get token', CredentialStore.ID);
					this._telemetry.sendTelemetryEvent('auth.failed');
					return undefined;
				}

				const azdo = new Azdo(this._orgUrl, projectName, token);
				azdo.authenticatedUser = (await azdo.connection.connect()).authenticatedUser;

				Logger.debug(`Auth> Successful: Logged userid: ${azdo?.authenticatedUser?.id}`, CredentialStore.ID);
				this._telemetry.sendTelemetryEvent('auth.success');
				this._sessionOptions.forceNewSession = false;
				this._sessionOptions.createIfNone = true;
				this._sessionOptions.clearSessionPreference = false;

				return azdo;
			} catch (e) {
				Logger.appendLine(`Auth> Failed: ${e.message}`, CredentialStore.ID);
				this._telemetry.sendTelemetryEvent('auth.failed');
				if (e instanceof Error && e.stack) {
					Logger.appendLine(e.stack);
				}
				if (e.message === 'User canceled authentication') {
					return undefined;
				}
			}

			retry = (await vscode.window.showErrorMessage(ERROR, TRY_AGAIN, CANCEL)) === TRY_AGAIN;
			if (retry) {
				this._sessionOptions.forceNewSession = true;
				this._sessionOptions.createIfNone = false;
				this._sessionOptions.clearSessionPreference = true;
			}
		}
	}

	private async getSession(sessionOptions: vscode.AuthenticationGetSessionOptions): Promise<vscode.AuthenticationSession> {
		return await vscode.authentication.getSession(
			// Specifies the Microsoft Auth Provider
			'microsoft',
			// This GUID is the Azure DevOps GUID and you basically ask for a token that can be used to interact with AzDO. This is publicly documented all over
			['499b84ac-1321-427f-aa17-267ca6975798/.default', 'offline_access'],
			sessionOptions
		);
	}


	private async getToken(session: vscode.AuthenticationSession): Promise<string | undefined> {
		return session?.accessToken;
	}

	public getAuthenticatedUser(): Identity | undefined {
		return this._azdoAPI?.authenticatedUser;
	}

	dispose() {
		this._disposables.forEach(disposable => disposable.dispose());
	}
}
