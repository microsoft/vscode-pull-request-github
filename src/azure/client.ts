/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fetch, { Response } from 'cross-fetch';
import { AzureRemote, azureRepositoryUrl } from './remote';

export interface Identity {
	id: string;
	displayName: string;
	uniqueName?: string;
	vote?: number;
	isRequired?: boolean;
	imageUrl?: string;
	url?: string;
}

export interface Commit {
	commitId: string;
	comment?: string;
}

export interface PullRequest {
	pullRequestId: number;
	title: string;
	description?: string;
	status: 'active' | 'abandoned' | 'completed';
	isDraft: boolean;
	createdBy: Identity;
	sourceRefName: string;
	targetRefName: string;
	reviewers: Identity[];
	lastMergeSourceCommit: Commit;
	lastMergeTargetCommit: Commit;
	lastMergeCommit?: Commit;
	mergeStatus?: string;
	autoCompleteSetBy?: Identity;
	creationDate?: string;
	forkSource?: { name?: string; repository: { id: string; name: string; project: { id: string; name: string } } };
	repository: { id: string; name: string; project: { id: string; name: string } };
}

export interface PullRequestIteration {
	id: number;
	sourceRefCommit: Commit;
	targetRefCommit: Commit;
	commonRefCommit: Commit;
}

export interface FileChange {
	changeTrackingId: number;
	changeType: string;
	item: { path: string; isFolder?: boolean };
	originalPath?: string;
}

export interface ThreadComment {
	id: number;
	parentCommentId?: number;
	content?: string;
	author: Identity;
	isDeleted?: boolean;
	commentType?: string | number;
	usersLiked?: Identity[];
	publishedDate?: string;
}

export interface ThreadContext {
	filePath: string;
	leftFileStart?: { line: number; offset: number };
	leftFileEnd?: { line: number; offset: number };
	rightFileStart?: { line: number; offset: number };
	rightFileEnd?: { line: number; offset: number };
}

export interface ReviewThread {
	id: number;
	status: string | number;
	isDeleted?: boolean;
	comments: ThreadComment[];
	threadContext?: ThreadContext;
	pullRequestThreadContext?: {
		changeTrackingId?: number;
		iterationContext?: { firstComparingIteration: number; secondComparingIteration: number };
	};
}

export interface WorkItem {
	id: number;
	fields: {
		'System.Title': string;
		'System.State': string;
		'System.WorkItemType': string;
		'System.Description'?: string;
		'System.AssignedTo'?: Identity;
		'System.Tags'?: string;
	};
}

export interface PolicyEvaluation {
	evaluationId: string;
	status: string;
	configuration: { type: { displayName: string }; isBlocking: boolean };
}

export interface PullRequestStatus {
	id: number;
	state: string;
	description?: string;
	context: { name: string; genre?: string };
	targetUrl?: string;
}

export interface PullRequestLabel {
	id: string;
	name: string;
}

export class AzureApiError extends Error {
	constructor(public readonly status: number, method: string, path: string) {
		// Do not include response bodies, URLs with credentials, or tokens in diagnostics.
		super(`Azure DevOps: ${method} ${path.split('?')[0]} failed (HTTP ${status}).${status === 401 ? ' Sign in again.' : status === 403 ? ' Check your permissions and token scopes.' : ''}`);
		this.name = 'AzureApiError';
	}
}

type Query = Record<string, string | number | boolean | undefined>;
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class AzureClient {
	private readonly projectPath: string;
	private readonly repositoryPath: string;

	constructor(
		public readonly remote: AzureRemote,
		private readonly authorization: () => Promise<string>,
		private readonly request: Fetch = fetch,
	) {
		this.projectPath = `${remote.organizationUrl}/${encodeURIComponent(remote.project)}/_apis`;
		this.repositoryPath = `${this.projectPath}/git/repositories/${encodeURIComponent(remote.repository)}`;
	}

	private async send(path: string, method = 'GET', body?: unknown, query: Query = {}, patch = false): Promise<Response> {
		const url = new URL(path);
		url.searchParams.set('api-version', '7.1');
		for (const [key, value] of Object.entries(query)) {
			if (value !== undefined) {
				url.searchParams.set(key, String(value));
			}
		}
		const response = await this.request(url.toString(), {
			method,
			redirect: 'error',
			headers: {
				Authorization: await this.authorization(),
				Accept: 'application/json',
				'Content-Type': patch ? 'application/json-patch+json' : 'application/json',
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (!response.ok) {
			throw new AzureApiError(response.status, method, url.pathname);
		}
		return response;
	}

	private async json<T>(path: string, method = 'GET', body?: unknown, query?: Query, patch = false): Promise<T> {
		return (await this.send(path, method, body, query, patch)).json();
	}

	private async list<T>(path: string, query: Query = {}): Promise<T[]> {
		const result: T[] = [];
		let continuationToken: string | undefined;
		const seen = new Set<string>();
		do {
			const response = await this.send(path, 'GET', undefined, { ...query, continuationToken });
			const page: { value: T[] } = await response.json();
			result.push(...page.value);
			continuationToken = response.headers.get('x-ms-continuationtoken') || undefined;
			if (continuationToken && seen.has(continuationToken)) {
				throw new Error('Azure DevOps returned a repeated continuation token.');
			}
			if (continuationToken) {
				seen.add(continuationToken);
			}
		} while (continuationToken);
		return result;
	}

	async currentUser(): Promise<Identity> {
		const data = await this.json<{ authenticatedUser?: { id?: string; displayName?: string; providerDisplayName?: string; uniqueName?: string } }>(
			`${this.remote.organizationUrl}/_apis/connectionData`, 'GET', undefined, { 'api-version': '7.1-preview.1' },
		);
		const user = data.authenticatedUser;
		if (!user?.id) {
			throw new Error('Azure DevOps did not return an authenticated identity. Sign in again.');
		}
		return { id: user.id, displayName: user.displayName ?? user.providerDisplayName ?? user.id, uniqueName: user.uniqueName };
	}

	async repository(): Promise<{ id: string; defaultBranch?: string; project: { id: string; name: string }; parentRepository?: { id: string; name: string; project: { id: string; name: string } } }> {
		return this.json(this.repositoryPath);
	}

	async pullRequests(status: PullRequest['status'] | 'all' = 'active', filter: Query = {}): Promise<PullRequest[]> {
		const result: PullRequest[] = [];
		const size = 100;
		let page: PullRequest[];
		do {
			page = await this.list<PullRequest>(`${this.repositoryPath}/pullrequests`, {
				...filter, 'searchCriteria.status': status, '$top': size, '$skip': result.length,
			});
			result.push(...page);
		} while (page.length === size);
		return result;
	}

	async pullRequest(id: number): Promise<PullRequest> {
		return this.json(`${this.repositoryPath}/pullrequests/${id}`);
	}

	async reviewDetails(id: number, path?: string) {
		const [pullRequest, threads, iterations] = await Promise.all([this.pullRequest(id), this.threads(id), this.iterations(id)]);
		const iteration = iterations.at(-1);
		const changes = iteration ? await this.changes(id, iteration.id) : [];
		let file: { path: string; base: string; source: string } | undefined;
		if (path !== undefined) {
			const change = changes.find(change => change.item.path === path && !change.item.isFolder);
			if (!change || !iteration) {
				throw new Error('Choose a changed file from this pull request before requesting file contents.');
			}
			const [base, source] = await Promise.all([
				/\badd\b/i.test(change.changeType) ? '' : this.file(change.originalPath ?? path, iteration.commonRefCommit.commitId),
				/\bdelete\b/i.test(change.changeType) ? '' : this.file(path, iteration.sourceRefCommit.commitId),
			]);
			file = { path, base, source };
		}
		return { pullRequest, threads, iteration, changes, file };
	}

	async createPullRequest(title: string, description: string, sourceRefName: string, targetRefName: string, isDraft: boolean, forkSource?: { repository: { id: string; project: { id: string } } }): Promise<PullRequest> {
		return this.json(`${this.repositoryPath}/pullrequests`, 'POST', {
			title, description, sourceRefName, targetRefName, isDraft,
			forkSource: forkSource && { ...forkSource, name: sourceRefName },
		});
	}

	async updatePullRequest(id: number, update: { title?: string; description?: string; targetRefName?: string; isDraft?: boolean; status?: PullRequest['status']; autoCompleteSetBy?: { id: string } | null; lastMergeSourceCommit?: Commit; completionOptions?: { mergeStrategy: string; deleteSourceBranch: boolean; transitionWorkItems: boolean } }): Promise<PullRequest> {
		return this.json(`${this.repositoryPath}/pullrequests/${id}`, 'PATCH', update);
	}

	async completePullRequest(pr: PullRequest, mergeStrategy: string, deleteSourceBranch: boolean, autoComplete = false): Promise<PullRequest> {
		if (!pr.lastMergeSourceCommit?.commitId) {
			throw new Error('The pull request source commit is not available. Refresh before completing the pull request.');
		}
		const completionOptions = { mergeStrategy, deleteSourceBranch, transitionWorkItems: true };
		return this.updatePullRequest(pr.pullRequestId, autoComplete
			? { autoCompleteSetBy: { id: (await this.currentUser()).id }, completionOptions }
			: { status: 'completed', lastMergeSourceCommit: pr.lastMergeSourceCommit, completionOptions });
	}

	async iterations(id: number): Promise<PullRequestIteration[]> {
		return this.list(`${this.repositoryPath}/pullrequests/${id}/iterations`);
	}

	async changes(id: number, iteration: number): Promise<FileChange[]> {
		const result: FileChange[] = [];
		let skip = 0;
		let top = 2000;
		while (top > 0) {
			const page = await this.json<{ changeEntries: FileChange[]; nextSkip?: number; nextTop?: number }>(
				`${this.repositoryPath}/pullrequests/${id}/iterations/${iteration}/changes`, 'GET', undefined,
				{ '$compareTo': 0, '$skip': skip, '$top': top },
			);
			result.push(...page.changeEntries);
			top = page.nextTop ?? 0;
			if (top > 0 && (page.nextSkip === undefined || page.nextSkip <= skip)) {
				throw new Error('Azure DevOps returned an invalid changes page.');
			}
			skip = page.nextSkip ?? 0;
		}
		return result;
	}

	async file(path: string, commit: string): Promise<string> {
		const item = await this.json<{ content?: string; contentMetadata?: { isBinary?: boolean } }>(`${this.repositoryPath}/items`, 'GET', undefined, {
			path, 'versionDescriptor.version': commit, 'versionDescriptor.versionType': 'commit',
			includeContent: true, includeContentMetadata: true, '$format': 'json',
		});
		if (item.contentMetadata?.isBinary) {
			throw new Error('This Azure DevOps file is binary. Open the pull request in your browser to view it.');
		}
		if (typeof item.content !== 'string') {
			throw new Error('Azure DevOps did not return file content.');
		}
		return item.content;
	}

	async commits(id: number): Promise<Commit[]> {
		return this.list(`${this.repositoryPath}/pullrequests/${id}/commits`);
	}

	async threads(id: number, iteration?: number): Promise<ReviewThread[]> {
		return this.list(`${this.repositoryPath}/pullrequests/${id}/threads`, { iteration, baseIteration: iteration === undefined ? undefined : 0 });
	}

	async createThread(id: number, content: string, threadContext?: ThreadContext, iteration?: number, changeTrackingId?: number): Promise<ReviewThread> {
		return this.json(`${this.repositoryPath}/pullrequests/${id}/threads`, 'POST', {
			comments: [{ parentCommentId: 0, content, commentType: 1 }],
			status: 1,
			threadContext,
			pullRequestThreadContext: iteration === undefined ? undefined : {
				changeTrackingId, iterationContext: { firstComparingIteration: 0, secondComparingIteration: iteration },
			},
		});
	}

	async reply(id: number, thread: number, content: string, parentCommentId = 1): Promise<ThreadComment> {
		return this.json(`${this.repositoryPath}/pullrequests/${id}/threads/${thread}/comments`, 'POST', { content, parentCommentId, commentType: 1 });
	}

	async updateComment(id: number, thread: number, comment: number, content: string): Promise<ThreadComment> {
		return this.json(`${this.repositoryPath}/pullrequests/${id}/threads/${thread}/comments/${comment}`, 'PATCH', { content });
	}

	async deleteComment(id: number, thread: number, comment: number): Promise<void> {
		await this.send(`${this.repositoryPath}/pullrequests/${id}/threads/${thread}/comments/${comment}`, 'DELETE');
	}

	async likeComment(id: number, thread: number, comment: number, like: boolean): Promise<void> {
		await this.send(`${this.repositoryPath}/pullrequests/${id}/threads/${thread}/comments/${comment}/likes`, like ? 'PUT' : 'DELETE');
	}

	async resolveThread(id: number, thread: number, resolved: boolean): Promise<ReviewThread> {
		return this.json(`${this.repositoryPath}/pullrequests/${id}/threads/${thread}`, 'PATCH', { status: resolved ? 2 : 1 });
	}

	async vote(id: number, vote: number, reviewer?: string): Promise<Identity> {
		return this.json(`${this.repositoryPath}/pullrequests/${id}/reviewers/${encodeURIComponent(reviewer ?? (await this.currentUser()).id)}`, 'PUT', { vote });
	}

	async removeReviewer(id: number, reviewer: string): Promise<void> {
		await this.send(`${this.repositoryPath}/pullrequests/${id}/reviewers/${encodeURIComponent(reviewer)}`, 'DELETE');
	}

	async users(): Promise<Identity[]> {
		const path = `${this.remote.organizationUrl}/_apis/projects/${encodeURIComponent(this.remote.project)}/teams`;
		const teams: { id: string }[] = [];
		let page: { id: string }[];
		do {
			page = await this.list<{ id: string }>(path, { '$top': 100, '$skip': teams.length });
			teams.push(...page);
		} while (page.length === 100);
		const users = new Map<string, Identity>();
		for (const team of teams) {
			const members: { identity: Identity }[] = [];
			let batch: { identity: Identity }[];
			do {
				batch = await this.list<{ identity: Identity }>(`${path}/${encodeURIComponent(team.id)}/members`, { '$top': 100, '$skip': members.length });
				members.push(...batch);
			} while (batch.length === 100);
			for (const member of members) {
				users.set(member.identity.id, member.identity);
			}
		}
		return [...users.values()];
	}

	async labels(id: number): Promise<PullRequestLabel[]> {
		return this.list(`${this.repositoryPath}/pullrequests/${id}/labels`);
	}

	async addLabel(id: number, name: string): Promise<PullRequestLabel> {
		return this.json(`${this.repositoryPath}/pullrequests/${id}/labels`, 'POST', { name });
	}

	async removeLabel(id: number, label: string): Promise<void> {
		await this.send(`${this.repositoryPath}/pullrequests/${id}/labels/${encodeURIComponent(label)}`, 'DELETE');
	}

	async linkedWorkItems(id: number): Promise<WorkItem[]> {
		const references = await this.list<{ id: string }>(`${this.repositoryPath}/pullrequests/${id}/workitems`);
		const items: WorkItem[] = [];
		for (const reference of references) {
			items.push(await this.workItem(Number(reference.id)));
		}
		return items;
	}

	async linkWorkItem(pr: PullRequest, workItem: number): Promise<WorkItem> {
		return this.json(`${this.projectPath}/wit/workitems/${workItem}`, 'PATCH', [{
			op: 'add', path: '/relations/-', value: {
				rel: 'ArtifactLink',
				url: `vstfs:///Git/PullRequestId/${pr.repository.project.id}%2F${pr.repository.id}%2F${pr.pullRequestId}`,
				attributes: { name: 'Pull Request' },
			},
		}], undefined, true);
	}

	async statuses(id: number): Promise<PullRequestStatus[]> {
		return this.list(`${this.repositoryPath}/pullrequests/${id}/statuses`);
	}

	async policies(pr: PullRequest): Promise<PolicyEvaluation[]> {
		return this.list(`${this.projectPath}/policy/evaluations`, {
			'api-version': '7.1-preview.1',
			artifactId: `vstfs:///CodeReview/CodeReviewId/${pr.repository.project.id}/${pr.pullRequestId}`,
		});
	}

	async workItems(query: string): Promise<WorkItem[]> {
		const result = await this.json<{ workItems: { id: number }[] }>(`${this.projectPath}/wit/wiql`, 'POST', { query });
		const items: WorkItem[] = [];
		for (let offset = 0; offset < result.workItems.length; offset += 200) {
			const batch = await this.json<{ value: WorkItem[] }>(`${this.projectPath}/wit/workitemsbatch`, 'POST', {
				ids: result.workItems.slice(offset, offset + 200).map(item => item.id),
				fields: ['System.Title', 'System.State', 'System.WorkItemType', 'System.Description', 'System.AssignedTo', 'System.Tags'],
			});
			items.push(...batch.value);
		}
		return items;
	}

	async workItemComments(id: number): Promise<{ text: string; createdBy: Identity }[]> {
		const result: { text: string; createdBy: Identity }[] = [];
		let continuationToken: string | undefined;
		const seen = new Set<string>();
		do {
			const page = await this.json<{ comments: { text: string; createdBy: Identity }[]; continuationToken?: string }>(
				`${this.projectPath}/wit/workitems/${id}/comments`, 'GET', undefined,
				{ 'api-version': '7.1-preview.4', continuationToken },
			);
			result.push(...page.comments);
			continuationToken = page.continuationToken;
			if (continuationToken && seen.has(continuationToken)) {
				throw new Error('Azure DevOps returned a repeated work item comment continuation token.');
			}
			if (continuationToken) {
				seen.add(continuationToken);
			}
		} while (continuationToken);
		return result;
	}

	async workItem(id: number): Promise<WorkItem> {
		return this.json(`${this.projectPath}/wit/workitems/${id}`);
	}

	async saveWorkItem(fields: Record<string, string>, type = 'Issue', id?: number): Promise<WorkItem> {
		const patch = Object.entries(fields).map(([field, value]) => ({ op: 'add', path: `/fields/${field}`, value }));
		return this.json(`${this.projectPath}/wit/workitems/${id ?? `$${encodeURIComponent(type)}`}`, id === undefined ? 'POST' : 'PATCH', patch, undefined, true);
	}

	async workItemComment(id: number, text: string): Promise<void> {
		await this.json(`${this.projectPath}/wit/workitems/${id}/comments`, 'POST', { text }, { 'api-version': '7.1-preview.4' });
	}

	pullRequestUrl(id: number): string {
		return `${azureRepositoryUrl(this.remote)}/pullrequest/${id}`;
	}

	workItemUrl(id: number): string {
		return `${this.remote.organizationUrl}/${encodeURIComponent(this.remote.project)}/_workitems/edit/${id}`;
	}
}
