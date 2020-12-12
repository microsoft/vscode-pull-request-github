import * as vscode from 'vscode';
import Logger from '../common/logger';
import { Remote, parseRemote } from '../common/remote';
import { PullRequestModel } from './pullRequestModel';
import { Azdo, CredentialStore } from './credentials';
import { PRCommentController } from '../view/prCommentController';
import { convertAzdoBranchRefToIGitHubRef, convertAzdoPullRequestToRawPullRequest } from './utils';
import { ITelemetry } from '../common/telemetry';
import { GitRepository, GitPullRequestSearchCriteria, PullRequestStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { Profile } from 'azure-devops-node-api/interfaces/ProfileInterfaces';
import { IGitHubRef } from './interface';


export const PULL_REQUEST_PAGE_SIZE = 20;

export interface IMetadata extends GitRepository {
}

export class AzdoRepository implements vscode.Disposable {
	static ID = 'AzdoRepository';
	protected _initialized: boolean;
	protected _hub: Azdo | undefined;
	protected _metadata: IMetadata | undefined;
	private _toDispose: vscode.Disposable[] = [];
	public commentsController?: vscode.CommentController;
	public commentsHandler?: PRCommentController;
	public readonly isGitHubDotCom: boolean; // TODO: WTF is this for? Enterprise?

	constructor(public remote: Remote,  private readonly _credentialStore: CredentialStore, private readonly _telemetry: ITelemetry) {
		// this.isGitHubDotCom = remote.host.toLowerCase() === 'github.com';
	}

	public equals(repo: AzdoRepository): boolean {
		return this.remote.equals(repo.remote);
	}

	async ensure(): Promise<AzdoRepository> {
		this._initialized = true;

		if (!this._hub === undefined) {
			await this._credentialStore.initialize()
			this._hub = this._credentialStore.getHub();
		}

		return this;
	}

	public async ensureCommentsController(): Promise<void> {
		try {
			if (this.commentsController) {
				return;
			}

			await this.ensure();
			this.commentsController = vscode.comments.createCommentController(`browse-${this.remote.normalizedHost}`, `Azdo Pull Request for ${this.remote.normalizedHost}`);
			this.commentsHandler = new PRCommentController(this.commentsController);
			this._toDispose.push(this.commentsController);
			this._toDispose.push(this.commentsController);
		} catch (e) {
			console.log(e);
		}

	}

	dispose() {
		this._toDispose.forEach(d => d.dispose());
	}

	async getMetadata(): Promise<IMetadata | undefined> {
		Logger.debug(`Fetch metadata - enter`, AzdoRepository.ID);
		await this.ensure();
		const gitApi = await this._hub?.connection?.getGitApi();
		if (this._metadata) {
			Logger.debug(`Fetch metadata for repo: ${this._metadata.id}/${this._metadata.name} - done`, AzdoRepository.ID);
			return this._metadata;
		}
		const repos = await gitApi?.getRepositories(this._hub?.projectName);
		this._metadata = await repos?.find(v => v.name === this.remote.repositoryName);
		if (!this._metadata) {
			Logger.debug(`Fetch metadata ${this.remote.repositoryName} failed. No repo by that name.`, AzdoRepository.ID)
			return this._metadata;
		}
		Logger.debug(`Fetch metadata ${this._metadata?.id}/${this._metadata?.name} - done`, AzdoRepository.ID);
		return this._metadata;
	}

	async resolveRemote(): Promise<void> {
		try {
			const metadata = await this.getMetadata();
			this.remote = parseRemote(this.remote.remoteName, metadata?.remoteUrl, this.remote.gitProtocol)!;
		} catch (e) {
			Logger.appendLine(`Unable to resolve remote: ${e}`);
		}
	}

	async getDefaultBranch(): Promise<string> {
		try {
			Logger.debug(`Fetch default branch - enter`, AzdoRepository.ID);
			const metadata = await this.getMetadata();
			Logger.debug(`Fetch default branch - done`, AzdoRepository.ID);

			return metadata?.defaultBranch || 'master';
		} catch (e) {
			Logger.appendLine(`AzdoRepository> Fetching default branch failed: ${e}`);
		}

		return 'master';
	}

	async getAllPullRequests(page?: number): Promise<PullRequestModel[] | undefined> {
		return await this.getPullRequests({status: PullRequestStatus.All});
	}

	async getPullRequestForBranch(branch: string): Promise<PullRequestModel[] | undefined> {
		return await this.getPullRequests({ sourceRefName: branch });
	}

	async getPullRequests(search: GitPullRequestSearchCriteria): Promise<PullRequestModel[] | undefined> {
		try {
			Logger.debug(`Fetch pull requests for branch - enter`, AzdoRepository.ID);
			const azdo = await this.ensure();
			const metadata = await this.getMetadata();
			const gitApi = await azdo._hub?.connection.getGitApi();
			const result = await gitApi?.getPullRequests(metadata?.id || '', search);

			if (!result || result.length === 0) {
				Logger.appendLine(`Warning: no result data for ${this.remote.owner}/${this.remote.repositoryName} for search: ${JSON.stringify(search)}`);
				return [];
			}

			const pullRequests = result
				.map(pullRequest => {
						return new PullRequestModel(this._telemetry, this, this.remote, convertAzdoPullRequestToRawPullRequest(pullRequest, this));
					}
				)
				.filter(item => item !== null) as PullRequestModel[];

			Logger.debug(`Fetch pull requests for branch - done`, AzdoRepository.ID);
			return pullRequests;
		} catch (e) {
			Logger.appendLine(`Fetching pull requests for search: ${JSON.stringify(search)} failed: ${e}`, AzdoRepository.ID);
			if (e.code === 404) {
				// TODO: not found
				vscode.window.showWarningMessage(`Fetching pull requests for remote '${this.remote.remoteName}' failed, please check if the url ${this.remote.url} is valid.`);
			} else {
				throw e;
			}
		}
	}

	async getAuthenticatedUserName(): Promise<string> {
		const azdo = await this.ensure();
		const profileApi = await azdo._hub?.connection.getProfileApi();
		const user = await profileApi?.getProfile('me', true);
		return user?.coreAttributes['displayName']?.value;
	}

	async getAuthenticatedUser(): Promise<Profile | undefined> {
		const azdo = await this.ensure();
		const profileApi = await azdo._hub?.connection.getProfileApi();
		const user = await profileApi?.getProfile('me', true);
		return user;
	}

	async getPullRequest(id: number): Promise<PullRequestModel | undefined> {
		try {
			Logger.debug(`Fetch pull request ${id} - enter`, AzdoRepository.ID);
			const azdo = await this.ensure();
			const gitApi = await azdo._hub?.connection.getGitApi();
			const pullRequest = await gitApi?.getPullRequestById(id);

			if (!pullRequest) {
				Logger.debug(`Fetch pull request ${id} - failed. No PR with such ID`, AzdoRepository.ID);
				return undefined;
			}

			Logger.debug(`Fetch pull request ${id} - done`, AzdoRepository.ID);

			return new PullRequestModel(this._telemetry, this, this.remote, convertAzdoPullRequestToRawPullRequest(pullRequest, this));
		} catch (e) {
			Logger.appendLine(`Azdo> Unable to fetch PR: ${e}`);
			return;
		}
	}

	async getBranchRef(branchName: string): Promise<IGitHubRef | undefined> {
		try {
			Logger.debug(`Get branch for name ${branchName} - enter`, AzdoRepository.ID);
			const azdo = await this.ensure();
			const metadata = await this.getMetadata();
			const gitApi = await azdo._hub?.connection.getGitApi();
			const branch = await gitApi?.getBranch(metadata?.id || '', branchName);

			if (!branch) {
				Logger.debug(`Get branch for name ${branchName} - failed. No branch with such name`, AzdoRepository.ID);
				return undefined;
			}

			Logger.debug(`Get branch for name ${branchName} - done`, AzdoRepository.ID);
			return convertAzdoBranchRefToIGitHubRef(branch);
		} catch (e) {
			Logger.appendLine(`Azdo> Unable to fetch PR: ${e}`);
			return;
		}
	}
}