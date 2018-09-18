/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Logger from './logger';

export enum ProtocolType {
	Local,
	HTTP,
	SSH,
	GIT,
	OTHER
}

const sshProtocolRegex = /^([^@:]+@)?([^:]+):(.+)$/;

export class Protocol {
	public type: ProtocolType = ProtocolType.OTHER;
	public host: string = '';

	public owner: string = '';

	public repositoryName: string = '';

	public get nameWithOwner(): string {
		return this.owner ? `${this.owner}/${this.repositoryName}` : this.repositoryName;
	}

	public readonly url: vscode.Uri;
	constructor(
		uriString: string
	) {
		if (uriString.indexOf('://') === -1) {
			if (sshProtocolRegex.test(uriString)) {
				this.parseSshProtocol(uriString);
				return;
			}
		}

		try {
			this.url = vscode.Uri.parse(uriString);
			this.type = this.getType(this.url.scheme);

			if (this.type === ProtocolType.SSH) {
				const urlWithoutScheme = this.url.authority + this.url.path;
				if (sshProtocolRegex.test(urlWithoutScheme)) {
					this.parseSshProtocol(urlWithoutScheme);
					return;
				}
			}

			this.host = this.getHostName(this.url.authority);
			if (this.host) {
				this.repositoryName = this.getRepositoryName(this.url.path);
				this.owner = this.getOwnerName(this.url.path);
			}
		} catch (e) {
			Logger.appendLine(`Failed to parse '${uriString}'`);
			vscode.window.showWarningMessage(`Unable to parse remote '${uriString}'. Please check that it is correctly formatted.`);
		}
	}

	private getType(scheme: string): ProtocolType {
		switch (scheme) {
			case 'file':
				return ProtocolType.Local;
			case 'http':
			case 'https':
				return ProtocolType.HTTP;
			case 'git':
				return ProtocolType.GIT;
			case 'ssh':
				return ProtocolType.SSH;
			default:
				return ProtocolType.OTHER;
		}
	}

	private parseSshProtocol(uriString: string): void {
		const result = uriString.match(sshProtocolRegex);
		if (result) {
			this.host = result[2];
			const path = result[3];
			this.owner = this.getOwnerName(path);
			this.repositoryName = this.getRepositoryName(path);
			this.type = ProtocolType.SSH;
			return;
		}
	}

	private stripLowLevelDomains(domain: string): string {
		let match = domain.match(/([^@:.]+\.[^@:.]+)(:\d+)?$/);
		return match ? match[1] : '';
	}

	getHostName(authority: string) {
		// <username>:<password>@<authority>:<port>
		let matches = /^(?:.*:?@)?([^:]*)(?::.*)?$/.exec(authority);

		if (matches && matches.length >= 2) {
			return this.stripLowLevelDomains(matches[1]);
		}

		return '';
	}

	getRepositoryName(path: string) {
		let normalized = path.replace('\\', '/');
		if (normalized.endsWith('/')) {
			normalized = normalized.substr(0, normalized.length - 1);
		}
		let lastIndex = normalized.lastIndexOf('/');
		let lastSegment = normalized.substr(lastIndex + 1);
		if (lastSegment === '' || lastSegment === '/') {
			return null;
		}

		return lastSegment.replace(/\/$/, '').replace(/\.git$/, '');
	}

	getOwnerName(path: string) {
		let normalized = path.replace('\\', '/');
		if (normalized.endsWith('/')) {
			normalized = normalized.substr(0, normalized.length - 1);
		}

		let fragments = normalized.split('/');
		if (fragments.length > 1) {
			return fragments[fragments.length - 2];
		}

		return null;
	}

	normalizeUri(): vscode.Uri {
		if (this.type === ProtocolType.OTHER && !this.url) {
			return null;
		}

		if (this.type === ProtocolType.Local) {
			return this.url;
		}

		let scheme = 'https';
		if (this.url && (this.url.scheme === 'http' || this.url.scheme === 'https')) {
			scheme = this.url.scheme;
		}

		try {
			return vscode.Uri.parse(`${scheme}://${this.host.toLocaleLowerCase()}/${this.nameWithOwner.toLocaleLowerCase()}`);
		} catch (e) {
			return null;
		}
	}

	equals(other: Protocol) {
		return this.normalizeUri().toString().toLocaleLowerCase() === other.normalizeUri().toString().toLocaleLowerCase();
	}
}