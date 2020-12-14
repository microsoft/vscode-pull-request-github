import * as azdev from 'azure-devops-node-api';
import { IRequestHandler } from 'azure-devops-node-api/interfaces/common/VsoBaseInterfaces';
import * as vscode from 'vscode';
import Logger from '../common/logger';
import { ITelemetry } from '../common/telemetry';

const CREDENTIALS_COMPONENT_ID = 'azdo_component';
const SETTINGS_NAMESPACE = 'azdoPullRequests';
const PROJECT_SETTINGS = 'projectName';
const ORGURL_SETTINGS = 'orgUrl';

export class Azdo {
	private _authHandler: IRequestHandler;
	public connection: azdev.WebApi;
	constructor(public orgUrl: string, public projectName: string, token: string) {
		this._authHandler = azdev.getPersonalAccessTokenHandler(token);
		this.connection = new azdev.WebApi(orgUrl, this._authHandler);
	}
}

export class CredentialStore implements vscode.Disposable {
	private _azdoAPI: Azdo | undefined;
	private _sessionId: string | undefined;
	private _disposables: vscode.Disposable[];
	private _onDidInitialize: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public readonly onDidInitialize: vscode.Event<void> = this._onDidInitialize.event;

	constructor(private readonly _telemetry: ITelemetry) {
		this._disposables = [];
		this._disposables.push(vscode.authentication.onDidChangeSessions(() => {
			if (!this.isAuthenticated()) {
				return this.initialize();
			}
		}));
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

		Logger.debug(`Manual personal access token option chosen.`, CREDENTIALS_COMPONENT_ID);
		const token = await vscode.window.showInputBox({ value: '', prompt: 'Please provide PAT', placeHolder: "", password: true });
		if (token) {
			this._telemetry.sendTelemetryEvent('auth.manual');
		}
		return token;
	}

	public async logout(): Promise<void> {
		if (this._sessionId) {
			vscode.authentication.logout('github', this._sessionId);
		}
	}

	public async login(): Promise<Azdo | undefined> {

		/* __GDPR__
			"auth.start" : {}
		*/
		this._telemetry.sendTelemetryEvent('auth.start');

		const projectName = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<string | undefined>(PROJECT_SETTINGS);
		if (!projectName) {
			Logger.appendLine('Project name is not provided');
			this._telemetry.sendTelemetryEvent('auth.failed');
			return undefined;
		}

		const orgUrl = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<string | undefined>(ORGURL_SETTINGS);
		if (!orgUrl) {
			Logger.appendLine('orgUrl is not provided');
			this._telemetry.sendTelemetryEvent('auth.failed');
			return undefined;
		}


		const token = await this.requestPersonalAccessToken();

		if (!token) {
			Logger.appendLine('PAT token is not provided');
			this._telemetry.sendTelemetryEvent('auth.failed');
			return undefined;
		}

		const azdo = new Azdo(orgUrl, projectName, token);

		this._telemetry.sendTelemetryEvent('auth.success');

		return azdo;
	}

	dispose() {
		this._disposables.forEach(disposable => disposable.dispose());
	}
}