import * as vscode from 'vscode';

export class AzdoManager {
	public async isAzdo(host: vscode.Uri): Promise<boolean> {
		if (host === null) {
			return false;
		}
		return true;
	}
}
