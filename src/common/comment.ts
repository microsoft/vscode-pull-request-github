/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GitPullRequestCommentThread } from 'azure-devops-node-api/interfaces/GitInterfaces';
import * as vscode from 'vscode';
import { IAccount } from '../azdo/interface';
import { DiffHunk } from './diffHunk';

export interface Reaction {
	label: string;
	count: number;
	icon?: vscode.Uri;
	viewerHasReacted: boolean;
}

export interface IComment {
	absolutePosition?: number;
	bodyHTML?: string;
	diffHunks?: DiffHunk[];
	canEdit?: boolean;
	canDelete?: boolean;
	url: string;
	id: number;
	pullRequestReviewId?: number;
	diffHunk: string;
	path?: string;
	position?: number;
	commitId?: string;
	originalPosition?: number;
	originalCommitId?: string;
	user?: IAccount;
	body: string;
	createdAt: string;
	htmlUrl: string;
	isDraft?: boolean;
	inReplyToId?: number;
	graphNodeId: string;
	reactions?: Reaction[];
	threadId?: number;
}

export enum ViewedState {
	DISMISSED = 'DISMISSED',
	VIEWED = 'VIEWED',
	UNVIEWED = 'UNVIEWED',
}

export interface IReviewThread {
	id: number;
	isResolved: boolean;
	viewerCanResolve: boolean;
	path: string;
	diffSide: DiffSide;
	line: number;
	originalLine: number;
	isOutdated: boolean;
	isDeleted: boolean;
	thread: GitPullRequestCommentThread;
}

export enum DiffSide {
	LEFT = 'LEFT',
	RIGHT = 'RIGHT',
}
