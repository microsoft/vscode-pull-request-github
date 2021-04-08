import * as path from 'path';
import { ResourceRef } from 'azure-devops-node-api/interfaces/common/VSSInterfaces';
import {
	Comment,
	CommentThreadContext,
	CommentThreadStatus,
	CommentType,
	FileDiff,
	FileDiffParams,
	GitBaseVersionDescriptor,
	GitChange,
	GitCommitDiffs,
	GitCommitRef,
	GitPullRequest,
	GitPullRequestCommentThread,
	GitPullRequestCommentThreadContext,
	GitStatusState,
	GitVersionOptions,
	GitVersionType,
	IdentityRefWithVote,
	PullRequestAsyncStatus,
	PullRequestStatus,
	VersionControlChangeType,
} from 'azure-devops-node-api/interfaces/GitInterfaces';
import * as vscode from 'vscode';
import { parseDiffAzdo } from '../common/diffHunk';
import { GitChangeType } from '../common/file';
import { GitHubRef } from '../common/githubRef';
import Logger from '../common/logger';
import { Remote } from '../common/remote';
import { ITelemetry } from '../common/telemetry';
import { toPRUriAzdo, toReviewUri } from '../common/uri';
import { formatError } from '../common/utils';
import { SETTINGS_NAMESPACE } from '../constants';
import { AzdoRepository } from './azdoRepository';
import { FolderRepositoryManager } from './folderRepositoryManager';
import {
	CommentPermissions,
	DiffBaseConfig,
	IRawFileChange,
	PullRequest,
	PullRequestChecks,
	PullRequestCompletion,
	PullRequestVote,
} from './interface';
import { convertAzdoPullRequestToRawPullRequest, getDiffHunkFromFileDiff, readableToString, removeLeadingSlash } from './utils';

interface IPullRequestModel {
	head: GitHubRef | null;
}

export interface IResolvedPullRequestModel extends IPullRequestModel {
	head: GitHubRef;
}

// interface NewCommentPosition {
// 	path: string;
// 	position: number;
// }

// interface ReplyCommentPosition {
// 	inReplyTo: string;
// }

export class PullRequestModel implements IPullRequestModel {
	static ID = 'PullRequestModel';

	public isDraft?: boolean;
	public localBranchName?: string;
	public mergeBase?: string;
	private _hasPendingReview: boolean = false;
	private _onDidChangePendingReviewState: vscode.EventEmitter<boolean> = new vscode.EventEmitter<boolean>();
	public onDidChangePendingReviewState = this._onDidChangePendingReviewState.event;

	// Whether the pull request is currently checked out locally
	public isActive: boolean;
	_telemetry: ITelemetry;
	public state: PullRequestStatus = PullRequestStatus.NotSet;

	constructor(
		telemetry: ITelemetry,
		public azdoRepository: AzdoRepository,
		public remote: Remote,
		public item: PullRequest,
		isActive?: boolean,
	) {
		// TODO: super.update was changing state of the issue and initializing some variable.
		// super(azdoRepository, remote, item);

		this._telemetry = telemetry;

		this.isActive = isActive === undefined ? item.status === PullRequestStatus.Active : false;
		this.update(item);
	}

	public get isMerged(): boolean {
		return this.state === PullRequestStatus.Completed;
	}

	public get hasPendingReview(): boolean {
		return this._hasPendingReview;
	}

	public set hasPendingReview(hasPendingReview: boolean) {
		if (this._hasPendingReview !== hasPendingReview) {
			this._hasPendingReview = hasPendingReview;
			this._onDidChangePendingReviewState.fire(this._hasPendingReview);
		}
	}

	public get url(): string {
		if (!!this.item.repository?.webUrl) {
			return `${this.item.repository?.webUrl}/pullrequest/${this.getPullRequestId()}`;
		}

		const org = this.azdoRepository.azdo?.orgUrl;
		const project = this.azdoRepository.azdo?.projectName;
		return `${org}/${this.item.repository?.project?.name ?? project}/_git/${
			this.item.repository?.name
		}/pullrequest/${this.getPullRequestId()}`;
	}

	public head: GitHubRef;
	public base: GitHubRef;

	protected updateState(state: string) {
		if (state.toLowerCase() === 'active') {
			this.state = PullRequestStatus.Active;
		} else if (state.toLowerCase() === 'abandoned') {
			this.state = PullRequestStatus.Abandoned;
		} else {
			this.state = PullRequestStatus.Completed;
		}
	}

	update(item: PullRequest): void {
		// TODO: super.update was changing state of the issue and initializing some variable.
		// super.update(item);
		this.isDraft = item.isDraft;

		if (item.head && item.head.exists) {
			this.head = new GitHubRef(item.head.ref, '', item.head.sha, item.head.repo.cloneUrl);
		}

		if (item.base && item.base.exists) {
			this.base = new GitHubRef(item.base.ref, '', item.base.sha, item.base.repo.cloneUrl);
		}
	}

	/**
	 * Validate if the pull request has a valid HEAD.
	 * Use only when the method can fail silently, otherwise use `validatePullRequestModel`
	 */
	isResolved(): this is IResolvedPullRequestModel {
		return !!this.head;
	}

	getPullRequestId(): number {
		return this.item.pullRequestId || -1;
	}

	/**
	 * Validate if the pull request has a valid HEAD. Show a warning message to users when the pull request is invalid.
	 * @param message Human readable action execution failure message.
	 */
	validatePullRequestModel(message?: string): this is IResolvedPullRequestModel {
		if (!!this.head) {
			return true;
		}

		const reason = `There is no upstream branch for Pull Request #${this.getPullRequestId()}. View it on Azure Devops for more details`;

		if (message) {
			message += `: ${reason}`;
		} else {
			message = reason;
		}

		vscode.window.showWarningMessage(message, 'Open in Azure Devops').then(action => {
			if (action && action === 'Open in Azure Devops') {
				vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(this.url || ''));
			}
		});

		return false;
	}

	/**
	 * Close the pull request.
	 */
	async abandon(): Promise<PullRequest> {
		const azdoRepo = await this.azdoRepository.ensure();
		const repoId = await azdoRepo.getRepositoryId();
		const azdo = azdoRepo.azdo;
		const git = await azdo?.connection.getGitApi();
		const ret = await git?.updatePullRequest(
			{ status: PullRequestStatus.Abandoned },
			repoId || '',
			this.getPullRequestId(),
		);

		if (ret === undefined) {
			Logger.debug('Update pull request did not return a valid PR', PullRequestModel.ID);
			return this.item;
		}

		/* __GDPR__
			"azdopr.close" : {}
		*/
		this._telemetry.sendTelemetryEvent('azdopr.close');

		return convertAzdoPullRequestToRawPullRequest(ret, this.azdoRepository);
	}

	async updatePullRequest(title?: string, description?: string): Promise<GitPullRequest> {
		const azdoRepo = await this.azdoRepository.ensure();
		const repoId = await azdoRepo.getRepositoryId();
		const azdo = azdoRepo.azdo;
		const git = await azdo?.connection.getGitApi();

		return git!.updatePullRequest({ description, title }, repoId!, this.getPullRequestId());
	}

	async completePullRequest(options: PullRequestCompletion): Promise<GitPullRequest> {
		const azdoRepo = await this.azdoRepository.ensure();
		const repoId = await azdoRepo.getRepositoryId();
		const azdo = azdoRepo.azdo;
		const git = await azdo?.connection.getGitApi();

		return await git!.updatePullRequest(
			{
				status: PullRequestStatus.Completed,
				lastMergeSourceCommit: this.item.lastMergeSourceCommit,
				completionOptions: {
					deleteSourceBranch: options.deleteSourceBranch,
					mergeStrategy: options.mergeStrategy,
					transitionWorkItems: options.transitionWorkItems,
				},
			},
			repoId!,
			this.getPullRequestId(),
		);
	}

	public async getWorkItemRefs(): Promise<ResourceRef[] | undefined> {
		const azdoRepo = await this.azdoRepository.ensure();
		const repoId = await azdoRepo.getRepositoryId();
		const azdo = azdoRepo.azdo;
		const git = await azdo?.connection.getGitApi();

		const refs = await git?.getPullRequestWorkItemRefs(repoId!, this.getPullRequestId());
		return refs;
	}

	async createThread(
		message?: string,
		threadContext?: { filePath: string; line: number; startOffset: number; endOffset: number; isLeft: boolean },
		prCommentThreadContext?: GitPullRequestCommentThreadContext,
	): Promise<GitPullRequestCommentThread | undefined> {
		const azdoRepo = await this.azdoRepository.ensure();
		const repoId = (await azdoRepo.getRepositoryId()) || '';
		const azdo = azdoRepo.azdo;
		const git = await azdo?.connection.getGitApi();

		let tc: CommentThreadContext = undefined;

		if (threadContext?.isLeft) {
			tc = {
				filePath: threadContext?.filePath,
				leftFileStart: { line: threadContext?.line, offset: threadContext?.startOffset },
				leftFileEnd: { line: threadContext?.line, offset: threadContext?.endOffset },
			};
		} else {
			tc = {
				filePath: threadContext?.filePath,
				rightFileStart: { line: threadContext?.line, offset: threadContext?.startOffset },
				rightFileEnd: { line: threadContext?.line, offset: threadContext?.endOffset },
			};
		}

		const thread: GitPullRequestCommentThread = {
			comments: [
				{
					commentType: CommentType.Text,
					parentCommentId: 0,
					content: message,
				},
			],
			status: CommentThreadStatus.Active,
			threadContext: tc,
			pullRequestThreadContext: prCommentThreadContext,
		};

		return await git?.createThread(thread, repoId, this.getPullRequestId());
	}

	async updateThreadStatus(
		threadId: number,
		status: CommentThreadStatus,
		prCommentThreadContext?: GitPullRequestCommentThreadContext,
	): Promise<GitPullRequestCommentThread | undefined> {
		const azdoRepo = await this.azdoRepository.ensure();
		const repoId = (await azdoRepo.getRepositoryId()) || '';
		const azdo = azdoRepo.azdo;
		const git = await azdo?.connection.getGitApi();

		const thread: GitPullRequestCommentThread = {
			status,
			pullRequestThreadContext: prCommentThreadContext,
		};

		return await git?.updateThread(thread, repoId, this.getPullRequestId(), threadId);
	}

	async getAllActiveThreadsBetweenAllIterations(): Promise<GitPullRequestCommentThread[] | undefined> {
		const azdoRepo = await this.azdoRepository.ensure();
		const repoId = (await azdoRepo.getRepositoryId()) || '';
		const azdo = azdoRepo.azdo;
		const git = await azdo?.connection.getGitApi();

		const iterations = await git?.getPullRequestIterations(repoId, this.getPullRequestId());
		const max = Math.max(...(iterations?.map(i => i.id!) ?? [0]));

		return await this.getAllActiveThreads(max, 1);
	}

	async getAllActiveThreads(iteration?: number, baseIteration?: number): Promise<GitPullRequestCommentThread[] | undefined> {
		const azdoRepo = await this.azdoRepository.ensure();
		const repoId = (await azdoRepo.getRepositoryId()) || '';
		const azdo = azdoRepo.azdo;
		const git = await azdo?.connection.getGitApi();

		return (await git?.getThreads(repoId, this.getPullRequestId(), undefined, iteration, baseIteration))?.filter(
			t => !t.isDeleted,
		);
	}

	async createCommentOnThread(threadId: number, message: string, parentCommentId?: number): Promise<Comment | undefined> {
		const azdoRepo = await this.azdoRepository.ensure();
		const repoId = (await azdoRepo.getRepositoryId()) || '';
		const azdo = azdoRepo.azdo;
		const git = await azdo?.connection.getGitApi();

		const comment: Comment = {
			commentType: CommentType.Text,
			parentCommentId: parentCommentId,
			content: message,
		};

		return await git?.createComment(comment, repoId, this.getPullRequestId(), threadId);
	}

	async getCommentsOnThread(threadId: number): Promise<Comment[] | undefined> {
		const azdoRepo = await this.azdoRepository.ensure();
		const repoId = (await azdoRepo.getRepositoryId()) || '';
		const azdo = azdoRepo.azdo;
		const git = await azdo?.connection.getGitApi();

		return await git?.getComments(repoId, this.getPullRequestId(), threadId);
	}

	async submitVote(vote: PullRequestVote): Promise<IdentityRefWithVote | undefined> {
		const azdoRepo = await this.azdoRepository.ensure();
		const repoId = (await azdoRepo.getRepositoryId()) || '';
		const azdo = azdoRepo.azdo;
		const git = await azdo?.connection.getGitApi();

		return await git?.createPullRequestReviewer(
			{ vote: vote },
			repoId,
			this.getPullRequestId(),
			azdo?.authenticatedUser?.id || '',
		);
	}

	async addReviewer(userid: string, isRequired: boolean) {
		const azdoRepo = await this.azdoRepository.ensure();
		const repoId = (await azdoRepo.getRepositoryId()) || '';
		const azdo = azdoRepo.azdo;
		const git = await azdo?.connection.getGitApi();

		return await git?.createPullRequestReviewer(
			{ vote: 0, id: userid, isRequired: isRequired },
			repoId,
			this.getPullRequestId(),
			userid,
		);
	}

	async removeReviewer(reviewerId: string) {
		const azdoRepo = await this.azdoRepository.ensure();
		const repoId = (await azdoRepo.getRepositoryId()) || '';
		const azdo = azdoRepo.azdo;
		const git = await azdo?.connection.getGitApi();

		await git?.deletePullRequestReviewer(repoId, this.getPullRequestId(), reviewerId);
	}

	async editThread(message: string, threadId: number, commentId: number): Promise<Comment> {
		const azdoRepo = await this.azdoRepository.ensure();
		const repoId = (await azdoRepo.getRepositoryId()) || '';
		const azdo = azdoRepo.azdo;
		const git = await azdo?.connection.getGitApi();

		const comment: Comment = {
			id: commentId,
			content: message,
		};

		return await git!.updateComment(comment, repoId, this.getPullRequestId(), threadId, commentId);
	}

	getCommentPermission(comment: Comment): CommentPermissions {
		const user = this.azdoRepository.azdo?.authenticatedUser;
		const isSameUser = comment.author?.id === user?.id;

		return {
			canDelete: isSameUser ?? false,
			canEdit: isSameUser ?? false,
		};
	}

	async getCommits(forceRefresh?: boolean): Promise<GitCommitRef[]> {
		Logger.debug(`Fetch commits of PR #${this.getPullRequestId()} - enter`, PullRequestModel.ID);
		let commits = this.item.commits;

		if (!!commits && !forceRefresh) {
			Logger.debug(`Fetch commits of PR #${this.getPullRequestId()} - cache hit`, PullRequestModel.ID);
			return commits;
		}

		try {
			Logger.debug(`Fetch commits of PR #${this.getPullRequestId()} - Cache hit failed`, PullRequestModel.ID);

			const azdoRepo = await this.azdoRepository.ensure();
			const repoId = (await azdoRepo.getRepositoryId()) || '';
			const azdo = azdoRepo.azdo;
			const git = await azdo?.connection.getGitApi();

			commits = await git?.getPullRequestCommits(repoId, this.getPullRequestId());
			this.item.commits = commits ?? [];

			Logger.debug(`Fetch commits of PR #${this.getPullRequestId()} - done`, PullRequestModel.ID);
			return this.item.commits;
		} catch (e) {
			vscode.window.showErrorMessage(`Fetching commits failed: ${formatError(e)}`);
			return [];
		}
	}

	/**
	 * Get all changed files within a commit
	 * @param commit The commit
	 */
	async getCommitChanges(commit: Partial<GitCommitRef>, forceRefresh?: boolean): Promise<GitChange[]> {
		try {
			Logger.debug(
				`Fetch file changes of commit ${commit.commitId} in PR #${this.getPullRequestId()} - enter`,
				PullRequestModel.ID,
			);

			if (!!commit.changes && !forceRefresh) {
				Logger.debug(
					`Fetch file changes of commit ${commit.commitId} in PR #${this.getPullRequestId()} - cache hit`,
					PullRequestModel.ID,
				);
				return commit.changes;
			}

			const azdoRepo = await this.azdoRepository.ensure();
			const repoId = (await azdoRepo.getRepositoryId()) || '';
			const azdo = azdoRepo.azdo;
			const git = await azdo?.connection.getGitApi();

			const changes = await git?.getChanges(commit.commitId || '', repoId);
			commit.changes = changes?.changes;
			Logger.debug(
				`Fetch file changes of commit ${commit.commitId} in PR #${this.getPullRequestId()} - done`,
				PullRequestModel.ID,
			);

			return commit.changes || [];
		} catch (e) {
			vscode.window.showErrorMessage(`Fetching commit changes failed: ${formatError(e)}`);
			return [];
		}
	}

	/**
	 * Gets file content for a file at the specified commit
	 * @param sha The sha of the file
	 */
	async getFile(sha: string): Promise<string> {
		const azdoRepo = await this.azdoRepository.ensure();
		const repoId = (await azdoRepo.getRepositoryId()) || '';
		const azdo = azdoRepo.azdo;
		const git = await azdo?.connection.getGitApi();

		const fileStream = await git?.getBlobContent(repoId, sha);

		const fileContent = await readableToString(fileStream);
		return fileContent ?? '';
	}

	async getCommitDiffs(
		base: GitBaseVersionDescriptor,
		target: GitBaseVersionDescriptor,
		diffCommonCommit?: boolean,
	): Promise<GitCommitDiffs | undefined> {
		const azdoRepo = await this.azdoRepository.ensure();
		const repoId = (await azdoRepo.getRepositoryId()) || '';
		const azdo = azdoRepo.azdo;
		const git = await azdo?.connection.getGitApi();

		// diffCommonCommit is any because https://github.com/microsoft/azure-devops-node-api/issues/429
		return await git?.getCommitDiffs(
			repoId,
			undefined,
			String(diffCommonCommit) as any,
			undefined,
			undefined,
			base,
			target,
		);
	}

	async getFileDiff(
		baseVersionCommit: string,
		targetVersionCommit: string,
		fileDiffParams: FileDiffParams[],
	): Promise<FileDiff[]> {
		const azdoRepo = await this.azdoRepository.ensure();
		const repoId = (await azdoRepo.getRepositoryId()) || '';
		const azdo = azdoRepo.azdo;
		const git = await azdo?.connection.getGitApi();

		return git!.getFileDiffs(
			{
				baseVersionCommit: baseVersionCommit,
				targetVersionCommit: targetVersionCommit,
				fileDiffParams: fileDiffParams,
			},
			this.azdoRepository.azdo!.projectName,
			repoId,
		);
	}

	equals(other: PullRequestModel | undefined): boolean {
		if (!other) {
			return false;
		}

		if (this.getPullRequestId() !== other.getPullRequestId()) {
			return false;
		}

		if (this.item.url !== other.item.url) {
			return false;
		}

		return true;
	}
	async getStatusChecks(): Promise<PullRequestChecks> {
		const azdoRepo = await this.azdoRepository.ensure();
		const repoId = (await azdoRepo.getRepositoryId()) || '';
		const azdo = azdoRepo.azdo;
		const git = await azdo?.connection.getGitApi();

		let pr_statuses = (await git?.getPullRequestStatuses(repoId, this.getPullRequestId())) ?? [];
		pr_statuses = pr_statuses
			.filter(p => p.iterationId === Math.max(...pr_statuses.map(s => s.iterationId ?? 0)))
			.filter(
				p =>
					p.id ===
					Math.max(
						...pr_statuses
							.filter(s => s.context?.name === p.context?.name && s.context?.genre === p.context?.genre)
							.map(t => t.id!),
					),
			);

		const statuses: PullRequestChecks = {
			state: GitStatusState.Pending,
			statuses: pr_statuses?.map(status => {
				return {
					id: status.id!.toString(),
					url: status.targetUrl,
					description: status.description,
					state: status.state,
					context: status.context?.name || 'pending',
					target_url: status.targetUrl,
					genre: status.context?.genre,
				};
			}),
		};

		if (pr_statuses?.every(s => s.state === GitStatusState.Succeeded)) {
			statuses.state = GitStatusState.Succeeded;
		} else if (pr_statuses?.some(s => s.state === GitStatusState.Error || s.state === GitStatusState.Failed)) {
			statuses.state = GitStatusState.Failed;
		} else if (pr_statuses?.every(s => s.state === GitStatusState.NotApplicable)) {
			statuses.state = GitStatusState.NotApplicable;
		}

		return statuses;
	}

	/**
	 * List the changed files in a pull request.
	 */
	async getFileChangesInfo(): Promise<IRawFileChange[]> {
		Logger.debug(
			`Fetch file changes, base, head and merge base of PR #${this.getPullRequestId()} - enter`,
			PullRequestModel.ID,
		);

		if (!this.base) {
			this.update(this.item);
		}

		// baseVersion does not work. So using version.
		// target: feature branch, base: main branch
		const target: GitBaseVersionDescriptor = {
			version: this.item.head?.sha,
			versionOptions: GitVersionOptions.None,
			versionType: GitVersionType.Commit,
		};
		const base: GitBaseVersionDescriptor = {
			version: this.item.base?.sha,
			versionOptions: GitVersionOptions.None,
			versionType: GitVersionType.Commit,
		};

		if (!this.item.head?.exists) {
			target.version = this.item.lastMergeSourceCommit?.commitId;
			base.version = this.item.lastMergeTargetCommit?.commitId;
		}

		// Find mergebase to be used later.
		this.mergeBase = (await this.getMergeBase(base.version!, target.version!))?.[0].commitId;

		const diffBase = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<string>('diffBase');
		const useCommonCommit = diffBase !== DiffBaseConfig.head;

		const commitDiffs = await this.getCommitDiffs(base, target, useCommonCommit);
		const commonCommit = commitDiffs?.commonCommit ?? this.mergeBase!;
		Logger.debug(
			`Fetching file changes for PR #${this.getPullRequestId()}. base: ${base.version}, mergeBase: ${
				this.mergeBase
			}, commonCommit: ${commitDiffs?.commonCommit}, target: ${target.version}, diffBaseSetting: ${diffBase}`,
			PullRequestModel.ID,
		);

		const baseCommit = diffBase !== DiffBaseConfig.head ? commonCommit : base.version!;

		const changes = commitDiffs?.changes?.filter(c => (c.item?.gitObjectType as any) === 'blob'); // The API returns string not enum (int)
		if (!changes?.length) {
			Logger.debug(
				`Fetch file changes, base, head and merge base of PR #${this.getPullRequestId()} - No changes found - done`,
				PullRequestModel.ID,
			);
			return [];
		}

		const BATCH_SIZE = 10;
		const batches = (changes!.length - 1) / BATCH_SIZE;
		const diffsPromises: Promise<FileDiff[]>[] = [];
		for (let i: number = 0; i <= batches; i++) {
			const batchedChanges = changes!.slice(i * BATCH_SIZE, Math.min((i + 1) * BATCH_SIZE, changes!.length));
			diffsPromises.push(
				this.getFileDiff(baseCommit!, target.version!, this.getFileDiffParamsFromChanges(batchedChanges)),
			);
		}

		const diffsPromisesResult = await Promise.all(diffsPromises);

		const result: IRawFileChange[] = [];

		for (const diff of ([] as FileDiff[]).concat(...diffsPromisesResult)) {
			// flatten
			const change_map = changes.find(c => c.item?.path === (diff.path!.length > 0 ? diff.path : diff.originalPath));
			result.push({
				diffHunk: getDiffHunkFromFileDiff(diff),
				filename: diff.path!,
				previous_filename: diff.originalPath!,
				blob_url: change_map?.item?.url,
				raw_url: change_map?.item?.url,
				file_sha: change_map?.item?.objectId,
				previous_file_sha: change_map?.item?.originalObjectId,
				status: change_map?.changeType,
			});
		}

		return result;
	}

	async getMergability(): Promise<PullRequestAsyncStatus> {
		// TODO Can I just return current _item status?
		return (await this.azdoRepository.getPullRequest(this.item.pullRequestId!))!.item.mergeStatus!;
	}

	private async getMergeBase(sourceCommit: string, targetCommit: string): Promise<GitCommitRef[] | undefined> {
		const azdoRepo = await this.azdoRepository.ensure();
		const repoId = (await azdoRepo.getRepositoryId()) || '';
		const azdo = azdoRepo.azdo;
		const git = await azdo?.connection.getGitApi();

		return await git?.getMergeBases(repoId, sourceCommit, targetCommit);
	}

	async canEdit(): Promise<boolean> {
		const username = await this.azdoRepository.getAuthenticatedUserName();
		return this.item.createdBy?.uniqueName === username;
	}

	public getDiffTarget(): string {
		const config = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<string>('diffBase');
		if (config === DiffBaseConfig.head) {
			return this.base.sha;
		}
		if (!this.mergeBase) {
			vscode.window.showErrorMessage(
				'Merge Base is not set. This may be a bug. Use HEAD as diff target and report this error.',
			);
			Logger.appendLine(`Merge Base is not set. config: ${config}`, PullRequestModel.ID);
			return '';
		}
		return this.mergeBase;
	}

	private getFileDiffParamsFromChanges(changes: GitChange[]): FileDiffParams[] {
		const diff_params = changes
			.filter(
				change => change.changeType !== VersionControlChangeType.None && (change.item?.gitObjectType as any) === 'blob',
			)
			.map(change => {
				const params: FileDiffParams = { path: '', originalPath: '' };
				// tslint:disable-next-line: no-bitwise
				if (
					change.changeType! & VersionControlChangeType.Rename &&
					change.changeType! & VersionControlChangeType.Edit
				) {
					params.path = change.item!.path;
					params.originalPath = change.sourceServerItem;
				}
				if (change.changeType! === VersionControlChangeType.Rename) {
					params.path = change.item!.path;
				} else if (change.changeType! === VersionControlChangeType.Edit) {
					params.path = change.item!.path;
					params.originalPath = change.item?.path;
				} else if (change.changeType! === VersionControlChangeType.Add) {
					params.path = change.item!.path;
					// tslint:disable-next-line: no-bitwise
				} else if (change.changeType! & VersionControlChangeType.Delete) {
					params.originalPath = change.item!.path;
				}
				return params;
			});
		return diff_params;
	}

	static async openDiffFromComment(
		folderManager: FolderRepositoryManager,
		pullRequestModel: PullRequestModel,
		comment: GitPullRequestCommentThread,
	): Promise<void> {
		const fileChanges = await pullRequestModel.getFileChangesInfo();
		// TODO merge base is here also
		const mergeBase = pullRequestModel.getDiffTarget();
		const contentChanges = await parseDiffAzdo(fileChanges, folderManager.repository, mergeBase);
		const change = contentChanges.find(
			fileChange =>
				fileChange.fileName === comment.threadContext?.filePath ||
				fileChange.previousFileName === comment.threadContext?.filePath,
		);
		if (!change) {
			throw new Error(`Can't find matching file`);
		}

		let headUri, baseUri: vscode.Uri;
		if (!pullRequestModel.equals(folderManager.activePullRequest)) {
			const headCommit = pullRequestModel.head!.sha;
			const fileName = change.status === GitChangeType.DELETE ? change.previousFileName! : change.fileName;
			const parentFileName = change.previousFileName ?? '';
			headUri = toPRUriAzdo(
				vscode.Uri.file(path.resolve(folderManager.repository.rootUri.fsPath, removeLeadingSlash(fileName))),
				pullRequestModel,
				change.baseCommit,
				headCommit,
				fileName,
				false,
				change.status,
			);
			baseUri = toPRUriAzdo(
				vscode.Uri.file(path.resolve(folderManager.repository.rootUri.fsPath, removeLeadingSlash(parentFileName))),
				pullRequestModel,
				change.baseCommit,
				headCommit,
				parentFileName,
				true,
				change.status,
			);
		} else {
			const uri = vscode.Uri.file(
				path.resolve(folderManager.repository.rootUri.fsPath, removeLeadingSlash(change.fileName)),
			);

			headUri =
				change.status === GitChangeType.DELETE
					? toReviewUri(uri, undefined, undefined, '', false, { base: false }, folderManager.repository.rootUri)
					: uri;

			baseUri = toReviewUri(
				uri,
				change.status === GitChangeType.RENAME ? change.previousFileName : change.fileName,
				undefined,
				change.status === GitChangeType.ADD ? '' : mergeBase,
				false,
				{ base: true },
				folderManager.repository.rootUri,
			);
		}

		const pathSegments = comment.threadContext?.filePath?.split('/');
		vscode.commands.executeCommand(
			'vscode.diff',
			baseUri,
			headUri,
			`${pathSegments[pathSegments.length - 1]} (Pull Request)`,
			{},
		);
	}
}
