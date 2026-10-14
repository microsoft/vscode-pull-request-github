/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GITHUB_ENTERPRISE, URI, URIS } from '../common/settingKeys';

export function parseEnterpriseUri(value: unknown): vscode.Uri {
	try {
		if (typeof value !== 'string' || !value) {
			throw new Error('Expected an instance URL');
		}
		const uri = vscode.Uri.parse(value, true);
		const url = new URL(uri.toString());
		const hostname = url.hostname.replace(/\.$/, '');
		const path = uri.path.replace(/\/+$/, '');
		if (!['http:', 'https:'].includes(url.protocol)
			|| !uri.authority || url.username || url.password || uri.query || uri.fragment
			|| ['github.com', 'www.github.com', 'api.github.com'].includes(hostname)
			|| path.includes('//') || path.split('/').some(part => part === '.' || part === '..')) {
			throw new Error('Expected a GitHub Enterprise instance URL');
		}
		return uri.with({ scheme: uri.scheme.toLowerCase(), authority: uri.authority.toLowerCase(), path });
	} catch {
		throw new Error(vscode.l10n.t('Invalid GitHub Enterprise instance URL. Use an HTTP or HTTPS instance URL, not a GitHub.com URL, without credentials, a query, a fragment, or relative path segments.'));
	}
}

export function getEnterpriseUris(): vscode.Uri[] {
	const configuration = vscode.workspace.getConfiguration(GITHUB_ENTERPRISE);
	const inspected = configuration.inspect<unknown>(URIS);
	const hasPluralValue = inspected && (inspected.globalValue !== undefined
		|| (vscode.workspace.isTrusted && (inspected.workspaceValue !== undefined || inspected.workspaceFolderValue !== undefined)));
	const legacy = configuration.get<unknown>(URI);
	const values = hasPluralValue ? configuration.get<unknown>(URIS) : legacy ? [legacy] : [];
	if (!Array.isArray(values)) {
		throw new Error(vscode.l10n.t('The {0} setting must be an array of GitHub Enterprise instance URLs.', `${GITHUB_ENTERPRISE}.${URIS}`));
	}
	const instances = values.map(parseEnterpriseUri);
	return [...new Map(instances.map(uri => [uri.toString(), uri])).values()];
}

export async function addEnterpriseUri(host: string): Promise<void> {
	const uri = parseEnterpriseUri(host);
	const instances = getEnterpriseUris();
	if (instances.some(instance => instance.toString() === uri.toString())) {
		return;
	}
	if (!vscode.workspace.isTrusted || (!vscode.workspace.workspaceFile && !vscode.workspace.workspaceFolders?.length)) {
		throw new Error(vscode.l10n.t('Open a trusted workspace to add a GitHub Enterprise instance, or configure {0} in your user settings.', `${GITHUB_ENTERPRISE}.${URIS}`));
	}
	const configuration = vscode.workspace.getConfiguration(GITHUB_ENTERPRISE);
	if (configuration.inspect<unknown>(URIS)?.workspaceFolderValue !== undefined) {
		throw new Error(vscode.l10n.t('A folder setting overrides {0}. Update that setting instead of adding a workspace setting.', `${GITHUB_ENTERPRISE}.${URIS}`));
	}
	await configuration.update(URIS, [...instances, uri].map(instance => instance.toString()), vscode.ConfigurationTarget.Workspace);
}

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
