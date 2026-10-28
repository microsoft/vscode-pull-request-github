/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Azure DevOps reviewer votes. */
export enum AzdoVote {
	Approved = 10,
	ApprovedWithSuggestions = 5,
	NoVote = 0,
	WaitingForAuthor = -5,
	Rejected = -10,
}

export type AzdoPolicyState = 'succeeded' | 'failed' | 'running' | 'queued' | 'notApplicable' | 'unknown';

export interface AzdoIdentity {
	id: string;
	displayName: string;
	imageUrl?: string;
}

export interface AzdoReviewer extends AzdoIdentity {
	vote: AzdoVote;
	isRequired: boolean;
	isContainer: boolean;
}

export interface AzdoPolicy {
	id: string;
	name: string;
	description?: string;
	state: AzdoPolicyState;
	isBlocking: boolean;
	buildId?: number;
	buildUrl?: string;
	canRequeue: boolean;
	issues: string[];
}

export interface AzdoWorkItem {
	id: number;
	title: string;
	type: string;
	state: string;
	changedDate?: string;
	url: string;
}

export interface AzdoOverview {
	number: number;
	title: string;
	url: string;
	status: 'active' | 'abandoned' | 'completed';
	isDraft: boolean;
	createdBy: AzdoIdentity;
	creationDate?: string;
	closedDate?: string;
	sourceBranch: string;
	targetBranch: string;
	sourceBranchUrl: string;
	targetBranchUrl: string;
	mergeStatus?: string;
	viewer: AzdoIdentity;
	viewerVote?: AzdoVote;
	isAuthor: boolean;
	autoComplete?: { setBy: AzdoIdentity; mergeStrategy?: string };
	reviewers: AzdoReviewer[];
	policies: AzdoPolicy[];
	policiesError?: string;
	workItems: AzdoWorkItem[];
	workItemsError?: string;
	tags: string[];
	threads: { active: number; resolved: number };
}
