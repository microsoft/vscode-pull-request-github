/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as OctokitRest from '@octokit/rest';
import { Endpoints } from '@octokit/types';
import { ChatSessionStatus, Uri } from 'vscode';
import { Repository } from '../api/api';
import { GitHubRemote } from '../common/remote';
import { EventType, TimelineEvent } from '../common/timelineEvent';
import { SessionInfo, SessionSetupStep } from './copilotApi';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { GitHubRepository } from './githubRepository';

export namespace OctokitCommon {
	export type IssuesAssignParams = OctokitRest.RestEndpointMethodTypes['issues']['addAssignees']['parameters'];
	export type IssuesCreateParams = OctokitRest.RestEndpointMethodTypes['issues']['create']['parameters'];
	export type IssuesCreateResponseData = OctokitRest.RestEndpointMethodTypes['issues']['create']['response']['data'];
	export type IssuesListCommentsResponseData = OctokitRest.RestEndpointMethodTypes['issues']['listComments']['response']['data'];
	export type IssuesListEventsForTimelineResponseData = Endpoints['GET /repos/{owner}/{repo}/issues/{issue_number}/timeline']['response']['data'];
	export type IssuesListEventsForTimelineResponseItemActor = {
		name?: string | null;
		email?: string | null;
		login: string;
		id: number;
		node_id: string;
		avatar_url: string;
		gravatar_id: string;
		url: string;
		html_url: string;
		followers_url: string;
		following_url: string;
		gists_url: string;
		starred_url: string;
		subscriptions_url: string;
		organizations_url: string;
		repos_url: string;
		events_url: string;
		received_events_url: string;
		type: string;
		site_admin: boolean;
		starred_at: string;
		user_view_type: string;
	}
	export type PullsCreateParams = OctokitRest.RestEndpointMethodTypes['pulls']['create']['parameters'];
	export type PullsCreateReviewResponseData = Endpoints['POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews']['response']['data'];
	export type PullsCreateReviewCommentResponseData = Endpoints['POST /repos/{owner}/{repo}/pulls/{pull_number}/comments']['response']['data'];
	export type PullsGetResponseData = OctokitRest.RestEndpointMethodTypes['pulls']['get']['response']['data'];
	export type IssuesGetResponseData = OctokitRest.RestEndpointMethodTypes['issues']['get']['response']['data'];
	export type PullsGetResponseUser = Exclude<PullsGetResponseData['user'], null>;
	export type PullsListCommitsResponseData = Endpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}/commits']['response']['data'];
	export type PullsListRequestedReviewersResponseData = Endpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers']['response']['data'];
	export type PullsListResponseItem = OctokitRest.RestEndpointMethodTypes['pulls']['list']['response']['data'][0];
	export type PullsListResponseItemHead = PullsListResponseItem['head'];
	export type PullsListResponseItemBase = PullsListResponseItem['base'];
	export type PullsListResponseItemHeadRepo = PullsListResponseItemHead['repo'];
	export type PullsListResponseItemBaseRepo = PullsListResponseItemBase['repo'];
	export type PullsListResponseItemUser = Exclude<PullsListResponseItem['user'], null>;
	export type PullsListResponseItemAssignee = PullsListResponseItem['assignee'];
	export type PullsListResponseItemAssigneesItem = (Exclude<PullsListResponseItem['assignees'], null | undefined>)[0];
	export type PullsListResponseItemRequestedReviewersItem = (Exclude<PullsListResponseItem['requested_reviewers'], null | undefined>)[0];
	export type PullsListResponseItemBaseUser = PullsListResponseItemBase['user'];
	export type PullsListResponseItemBaseRepoOwner = PullsListResponseItemBase['repo']['owner'];
	export type PullsListResponseItemHeadUser = PullsListResponseItemHead['user'];
	export type PullsListResponseItemHeadRepoOwner = PullsListResponseItemHead['repo']['owner'];
	export type PullsListReviewRequestsResponseTeamsItem = Endpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers']['response']['data']['teams'][0];
	export type PullsListCommitsResponseItem = Endpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}/commits']['response']['data'][0];
	export type ReposCompareCommitsResponseData = OctokitRest.RestEndpointMethodTypes['repos']['compareCommits']['response']['data'];
	export type ReposGetCombinedStatusForRefResponseStatusesItem = Endpoints['GET /repos/{owner}/{repo}/commits/{ref}/status']['response']['data']['statuses'][0];
	export type ReposGetCommitResponseData = Endpoints['GET /repos/{owner}/{repo}/commits/{ref}']['response']['data'];
	export type ReposGetCommitResponseFiles = Endpoints['GET /repos/{owner}/{repo}/commits/{ref}']['response']['data']['files'];
	export type ReposGetResponseData = Endpoints['GET /repos/{owner}/{repo}']['response']['data'];
	export type ReposGetResponseCodeOfConduct = ReposGetResponseData['code_of_conduct'];
	export type ReposGetResponseOrganization = ReposGetResponseData['organization'];
	export type ReposListBranchesResponseData = Endpoints['GET /repos/{owner}/{repo}/branches']['response']['data'];
	export type SearchReposResponseItem = Endpoints['GET /search/repositories']['response']['data']['items'][0];
	export type CompareCommits = Endpoints['GET /repos/{owner}/{repo}/compare/{base}...{head}']['response']['data'];
	export type Commit = CompareCommits['commits'][0];
	export type CommitFiles = CompareCommits['files']
	export type Notification = Endpoints['GET /notifications']['response']['data'][0];
	export type ListEventsForTimelineResponse = Endpoints['GET /repos/{owner}/{repo}/issues/{issue_number}/timeline']['response']['data'][0];
	export type ListWorkflowRunsForRepo = Endpoints['GET /repos/{owner}/{repo}/actions/runs']['response']['data'];
	export type WorkflowRun = Endpoints['GET /repos/{owner}/{repo}/actions/runs']['response']['data']['workflow_runs'][0];
	export type WorkflowJob = Endpoints['GET /repos/{owner}/{repo}/actions/jobs/{job_id}']['response']['data'];
	export type WorkflowJobs = Endpoints['GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs']['response']['data'];
}

// eslint-disable-next-line rulesdir/no-any-except-union-method-signature
export type Schema = { [key: string]: any, definitions: any[]; };
export function mergeQuerySchemaWithShared(sharedSchema: Schema, schema: Schema) {
	const sharedSchemaDefinitions = sharedSchema.definitions;
	const schemaDefinitions = schema.definitions;
	const mergedDefinitions = schemaDefinitions.concat(sharedSchemaDefinitions);
	return {
		...schema,
		...sharedSchema,
		definitions: mergedDefinitions
	};
}

type RemoteAgentSuccessResult = { link: string; state: 'success'; number: number; webviewUri: Uri; llmDetails: string };
type RemoteAgentErrorResult = { error: string; state: 'error' };
export type RemoteAgentResult = RemoteAgentSuccessResult | RemoteAgentErrorResult;

export interface IAPISessionLogs {
	readonly info: SessionInfo;
	readonly logs: string;
	readonly setupSteps: SessionSetupStep[] | undefined;
}

export interface ICopilotRemoteAgentCommandArgs {
	userPrompt: string;
	summary?: string;
	source?: 'prompt' | (string & {});
	followup?: string;
	_version?: number; // TODO(jospicer): Remove once stabilized/engine version enforced
}

export interface ICopilotRemoteAgentCommandResponse {
	uri: string;
	title: string;
	description: string;
	author: string;
	linkTag: string;
}

export interface ToolCall {
	function: {
		arguments: string;
		name: 'bash' | 'reply_to_comment' | (string & {});
	};
	id: string;
	type: string;
	index: number;
}

export interface AssistantDelta {
	content?: string;
	role: 'assistant' | (string & {});
	tool_calls?: ToolCall[];
}

export interface Choice {
	finish_reason?: 'tool_calls' | (string & {});
	delta: {
		content?: string;
		role: 'assistant' | (string & {});
		tool_calls?: ToolCall[];
	};
}

export interface RepoInfo {
	owner: string;
	repo: string;
	baseRef: string;
	remote: GitHubRemote;
	repository: Repository;
	ghRepository: GitHubRepository;
	fm: FolderRepositoryManager;
}

export function copilotEventToSessionStatus(event: TimelineEvent | undefined): ChatSessionStatus {
	if (!event) {
		return ChatSessionStatus.InProgress;
	}

	switch (event.event) {
		case EventType.CopilotStarted:
			return ChatSessionStatus.InProgress;
		case EventType.CopilotFinished:
			return ChatSessionStatus.Completed;
		case EventType.CopilotFinishedError:
			return ChatSessionStatus.Failed;
		default:
			return ChatSessionStatus.InProgress;
	}
}
