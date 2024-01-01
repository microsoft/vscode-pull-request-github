/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Protocol } from './protocol';

export class GitHubRef {
	public repositoryCloneUrl: Protocol;
	constructor(public ref: string, public label: string, public sha: string, repositoryCloneUrl: string,
		public readonly owner: string, public readonly name: string, public readonly isInOrganization: boolean) {
		this.repositoryCloneUrl = new Protocol(repositoryCloneUrl);
	}
}
