/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export interface IHostConfiguration {
	host: string;
	token: string | undefined;
}

let USE_TEST_SERVER = false;

export const HostHelper = class {
	public static async getApiHost(host: IHostConfiguration | vscode.Uri): Promise<vscode.Uri> {
		const testEnv = process.env.GITHUB_TEST_SERVER;
		if (testEnv) {
			if (USE_TEST_SERVER) {
				return vscode.Uri.parse(testEnv);
			}

			const yes = vscode.l10n.t('Yes');
			const result = await vscode.window.showInformationMessage(
				vscode.l10n.t('The \'GITHUB_TEST_SERVER\' environment variable is set to \'{0}\'. Use this as the GitHub API endpoint?', testEnv),
				{ modal: true },
				yes,
			);
			if (result === yes) {
				USE_TEST_SERVER = true;
				return vscode.Uri.parse(testEnv);
			}
		}

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
