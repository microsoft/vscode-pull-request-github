/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface AzureRemote {
	organizationUrl: string;
	project: string;
	repository: string;
}

/** Server collection URLs must be explicitly trusted before credentials can be sent to them. */
export function parseAzureRemote(value: string, serverCollections: readonly string[] = []): AzureRemote | undefined {
	const ssh = /^(?:git@ssh\.dev\.azure\.com:|ssh:\/\/git@ssh\.dev\.azure\.com\/|[^@/]+@vs-ssh\.visualstudio\.com:|ssh:\/\/[^@/]+@vs-ssh\.visualstudio\.com\/)v3\/(?<organization>[^/]+)\/(?<project>[^/]+)\/(?<repository>[^/]+)\/?$/i.exec(value);
	if (ssh?.groups) {
		return {
			organizationUrl: `https://dev.azure.com/${encodeURIComponent(decodeURIComponent(ssh.groups.organization))}`,
			project: decodeURIComponent(ssh.groups.project),
			repository: decodeURIComponent(ssh.groups.repository),
		};
	}
	if (/^ssh:\/\//i.test(value) || /^[^@/]+@[^:/]+:/.test(value)) {
		const scp = /^[^@/]+@(?<host>[^:/]+):(?<path>.+)$/.exec(value);
		const url = scp?.groups ? new URL(`ssh://${scp.groups.host}/${scp.groups.path.replace(/^\//, '')}`) : new URL(value);
		const collections = serverCollections.map(server => new URL(server))
			.filter(server => server.protocol === 'https:' && server.hostname.toLowerCase() === url.hostname.toLowerCase()
				&& url.pathname.startsWith(`${server.pathname.replace(/\/$/, '')}/`))
			.sort((left, right) => right.pathname.length - left.pathname.length);
		const collection = collections[0];
		if (collection) {
			return parseAzureRemote(`${collection.origin}${url.pathname}`, serverCollections);
		}
		return undefined;
	}
	if (!/^https:\/\//i.test(value)) {
		return undefined;
	}
	const url = new URL(value);
	const parts = url.pathname.split('/').filter(Boolean);
	const gitIndex = parts.lastIndexOf('_git');
	if (gitIndex < 1 || gitIndex !== parts.length - 2) {
		return undefined;
	}
	let organizationUrl: string;
	if (url.hostname.toLowerCase() === 'dev.azure.com' && gitIndex === 2) {
		organizationUrl = `${url.origin}/${parts[0]}`;
	} else if (/^[^.]+\.visualstudio\.com$/i.test(url.hostname) && (gitIndex === 1 || (gitIndex === 2 && parts[0].toLowerCase() === 'defaultcollection'))) {
		organizationUrl = `https://dev.azure.com/${encodeURIComponent(url.hostname.split('.')[0])}`;
	} else {
		const collection = `${url.origin}/${parts.slice(0, gitIndex - 1).join('/')}`.replace(/\/$/, '');
		if (!serverCollections.some(server => server.replace(/\/$/, '').toLowerCase() === collection.toLowerCase())) {
			return undefined;
		}
		organizationUrl = collection;
	}
	return { organizationUrl, project: decodeURIComponent(parts[gitIndex - 1]), repository: decodeURIComponent(parts[gitIndex + 1]) };
}

export function azureRepositoryUrl(remote: AzureRemote): string {
	return `${remote.organizationUrl}/${encodeURIComponent(remote.project)}/_git/${encodeURIComponent(remote.repository)}`;
}
