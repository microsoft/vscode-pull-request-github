import * as vscode from 'vscode';

export class AzdoManager {
	// TODO WTF Does this do?
	private _servers: Map<string, boolean> = new Map()
		.set('dev.azure.com', true)
		.set('ssh.dev.azure.com', true)
		.set('vs-ssh.visualstudio.com', true);

	public async isAzdo(host: vscode.Uri): Promise<boolean> {
		if (host === null) {
			return false;
		}

		for (const [key, value] of this._servers) {
			if (key.includes(host.authority)) {
				return value;
			}
		}

		return host.authority.includes('.visualstudio.com');
	}
}
