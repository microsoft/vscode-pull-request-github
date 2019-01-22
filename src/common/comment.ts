/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DiffHunk } from './diffHunk';
import { IAccount } from '../github/interface';

export interface Comment {
	absolutePosition?: number;
	bodyHTML?: string;
	diffHunks?: DiffHunk[];
	canEdit?: boolean;
	canDelete?: boolean;
	url: string;
	id: number;
	pullRequestReviewId?: number;
	diffHunk: string;
	path: string;
	position: number;
	commitId?: string;
	originalPosition: number;
	originalCommitId: string;
	user: IAccount;
	body: string;
	createdAt: string;
	htmlUrl: string;
	isDraft?: boolean;
	graphNodeId: string;
}
