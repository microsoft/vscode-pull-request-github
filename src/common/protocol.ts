/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Logger from './logger';

import { resolve } from '../env/node/ssh';

export enum ProtocolType {
	Local,
	HTTP,
	SSH,
	GIT,
	OTHER
}

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
		uriString: string,
	) {
		if (this.parseSshProtocol(uriString)) {
			return;
		}

		try {
			this.url = vscode.Uri.parse(uriString);
			this.type = this.getType(this.url.scheme);

			this.host = this.getHostName(this.url.authority);
			if (this.host) {
				this.repositoryName = this.getRepositoryName(this.url.path) || '';
				this.owner = this.getOwnerName(this.url.path) || '';
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

	private parseSshProtocol(uriString: string): boolean {
		const sshConfig = resolve(uriString);
		if (!sshConfig) { return false; }
		const { Hostname, HostName, path } = sshConfig;
		this.host = HostName || Hostname;
		this.owner = this.getOwnerName(path) || '';
		this.repositoryName = this.getRepositoryName(path) || '';
		this.type = ProtocolType.SSH;
		return true;
	}

	getHostName(authority: string) {
		// <username>:<password>@<authority>:<port>
		const matches = /^(?:.*:?@)?([^:]*)(?::.*)?$/.exec(authority);

		if (matches && matches.length >= 2) {

			// normalize to fix #903.
			// www.github.com will redirect anyways, so this is safe in this specific case, but potentially not in others.
			return matches[1].toLocaleLowerCase() === 'www.github.com' ? 'github.com' : matches[1];
		}

		return '';
	}

	getRepositoryName(path: string) {
		let normalized = path.replace(/\\/g, '/');
		if (normalized.endsWith('/')) {
			normalized = normalized.substr(0, normalized.length - 1);
		}
		const lastIndex = normalized.lastIndexOf('/');
		const lastSegment = normalized.substr(lastIndex + 1);
		if (lastSegment === '' || lastSegment === '/') {
			return;
		}

		return lastSegment.replace(/\/$/, '').replace(/\.git$/, '');
	}

	getOwnerName(path: string) {
		let normalized = path.replace(/\\/g, '/');
		if (normalized.endsWith('/')) {
			normalized = normalized.substr(0, normalized.length - 1);
		}

		const fragments = normalized.split('/');
		if (fragments.length > 1) {
			return fragments[fragments.length - 2];
		}

		return;
	}

	normalizeUri(): vscode.Uri | undefined {
		if (this.type === ProtocolType.OTHER && !this.url) {
			return;
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
			return;
		}
	}

	toString(): string | undefined {
		// based on Uri scheme for SSH https://tools.ietf.org/id/draft-salowey-secsh-uri-00.html#anchor1 and heuristics of how GitHub handles ssh url
		// sshUri        = `ssh:`
		//    - omitted
		// hier-part     =  "//" authority path-abempty
		//    - // is omitted
		// authority     = [ [ ssh-info ] "@" host ] [ ":" port]
		//   - ssh-info: git
		//   - host: ${this.host}
		//   - port: omitted
		// path-abempty  = <as specified in [RFC3986]>
		//   - we use relative path here `${this.owner}/${this.repositoryName}`
		if (this.type === ProtocolType.SSH) {
			return `git@${this.host}:${this.owner}/${this.repositoryName}`;
		}

		if (this.type === ProtocolType.GIT) {
			return `git://git@${this.host}:${this.owner}/${this.repositoryName}`;
		}

		const normalizedUri = this.normalizeUri();
		if (normalizedUri) {
			return normalizedUri.toString();
		}

		return;
	}

	update(change: { type?: ProtocolType; host?: string; owner?: string; repositoryName?: string; }): Protocol {
		if (change.type) {
			this.type = change.type;
		}

		if (change.host) {
			this.host = change.host;
		}

		if (change.owner) {
			this.owner = change.owner;
		}

		if (change.repositoryName) {
			this.repositoryName = change.repositoryName;
		}

		return this;
	}

	equals(other: Protocol) {
		const normalizeUri = this.normalizeUri();
		if (!normalizeUri) {
			return false;
		}

		const otherNormalizeUri = other.normalizeUri();
		if (!otherNormalizeUri) {
			return false;
		}

		return normalizeUri.toString().toLocaleLowerCase() === otherNormalizeUri.toString().toLocaleLowerCase();
	}
}