import * as vscode from 'vscode';
import { ITelemetry } from '../common/telemetry';
import { Azdo, CredentialStore } from './credentials';
import Logger from '../common/logger';
import { IUserEntitlementApi, getEntitlementApi, User } from './entitlementApi';

export class AzdoUserManager implements vscode.Disposable {

	static ID = 'UserManager';
	private _toDispose: vscode.Disposable[] = [];
	private _hub: Azdo | undefined;
	private _entitlementApi?: IUserEntitlementApi;
	private _identityCache: User[];

	constructor(private readonly _credentialStore: CredentialStore, private readonly _telemetry: ITelemetry) {
		this._identityCache = [];
	}

	async ensure(): Promise<AzdoUserManager> {

		if (!this._credentialStore.isAuthenticated()) {
			await this._credentialStore.initialize();
		}
		this._hub = this._credentialStore.getHub();
		this._entitlementApi = await getEntitlementApi(this._hub?.connection!);

		return this;
	}

	async searchIdentities(filter: string): Promise<User[]> {
		try {
			this._telemetry.sendTelemetryEvent('user.search');
			Logger.debug(`Searching for Identities filter: ${filter} - started.`, AzdoUserManager.ID);
			const users = this._identityCache.filter(i => i.user.displayName.includes(filter) || i.user.mailAddress.includes(filter));
			if (users.length > 0) {
				Logger.debug(`Searching for Identities filter: ${filter} - cache hit.`, AzdoUserManager.ID);
				return users;
			}

			const searchResult = await this._entitlementApi?.searchUserEntitlement(`name eq '${filter}'`);
			const members = searchResult?.members ?? [];

			this._identityCache = [...this._identityCache, ...members.filter(m => !this._identityCache.some(i => i.id === m.id))];
			Logger.debug(`Searching for Identities filter: ${filter} - finished.`, AzdoUserManager.ID);

			return members;
		} catch (error) {
			Logger.appendLine(`Searching for Identities filter: ${filter} - failed. Error: ${error.message}`, AzdoUserManager.ID);
			return [];
		}
	}

	dispose() {
		this._toDispose.forEach(d => d.dispose());
	}

}