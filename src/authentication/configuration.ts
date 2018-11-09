import * as vscode from 'vscode';

export interface IHostConfiguration {
	host: string;
	token: string | undefined;
}

export const HostHelper = class {
	public static getApiHost(host: IHostConfiguration | vscode.Uri): vscode.Uri {
		const hostUri: vscode.Uri = host instanceof vscode.Uri ? host : vscode.Uri.parse(host.host);
		if (hostUri.authority === 'github.com') {
			return vscode.Uri.parse('https://api.github.com');
		} else {
			return vscode.Uri.parse(`${hostUri.scheme}://${hostUri.authority}`);
		}
	}

	public static getApiPath(host: IHostConfiguration | vscode.Uri, path: string): string {
		const hostUri: vscode.Uri = host instanceof vscode.Uri ? host : vscode.Uri.parse(host.host);
		if (hostUri.authority === 'github.com') {
			return path;
		} else {
			return `/api/v3${path}`;
		}
	}
};
