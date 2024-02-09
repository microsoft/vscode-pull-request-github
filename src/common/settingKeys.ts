/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const PR_SETTINGS_NAMESPACE = 'githubPullRequests';
export const TERMINAL_LINK_HANDLER = 'terminalLinksHandler';
export const BRANCH_PUBLISH = 'createOnPublishBranch';
export const USE_REVIEW_MODE = 'useReviewMode';
export const FILE_LIST_LAYOUT = 'fileListLayout';
export const ASSIGN_TO = 'assignCreated';
export const PUSH_BRANCH = 'pushBranch';
export const IGNORE_PR_BRANCHES = 'ignoredPullRequestBranches';
export const NEVER_IGNORE_DEFAULT_BRANCH = 'neverIgnoreDefaultBranch';
export const OVERRIDE_DEFAULT_BRANCH = 'overrideDefaultBranch';
export const PULL_BRANCH = 'pullBranch';
export const PULL_REQUEST_DESCRIPTION = 'pullRequestDescription';
export const NOTIFICATION_SETTING = 'notifications';
export const POST_CREATE = 'postCreate';
export const QUERIES = 'queries';
export const PULL_REQUEST_LABELS = 'labelCreated';
export const FOCUSED_MODE = 'focusedMode';
export const CREATE_DRAFT = 'createDraft';
export const QUICK_DIFF = 'quickDiff';
export const SET_AUTO_MERGE = 'setAutoMerge';
export const SHOW_PULL_REQUEST_NUMBER_IN_TREE = 'showPullRequestNumberInTree';
export const DEFAULT_MERGE_METHOD = 'defaultMergeMethod';
export const DEFAULT_DELETION_METHOD = 'defaultDeletionMethod';
export const SELECT_LOCAL_BRANCH = 'selectLocalBranch';
export const SELECT_REMOTE = 'selectRemote';
export const REMOTES = 'remotes';
export const PULL_PR_BRANCH_BEFORE_CHECKOUT = 'pullPullRequestBranchBeforeCheckout';
export type PullPRBranchVariants = 'never' | 'pull' | 'pullAndMergeBase' | 'pullAndUpdateBase' | true | false;
export const UPSTREAM_REMOTE = 'upstreamRemote';
export const DEFAULT_CREATE_OPTION = 'defaultCreateOption';
export const CREATE_BASE_BRANCH = 'createDefaultBaseBranch';

export const ISSUES_SETTINGS_NAMESPACE = 'githubIssues';
export const ASSIGN_WHEN_WORKING = 'assignWhenWorking';
export const ISSUE_COMPLETIONS = 'issueCompletions';
export const USER_COMPLETIONS = 'userCompletions';
export const ENABLED = 'enabled';
export const IGNORE_USER_COMPLETION_TRIGGER = 'ignoreUserCompletionTrigger';
export const CREATE_INSERT_FORMAT = 'createInsertFormat';
export const ISSUE_BRANCH_TITLE = 'issueBranchTitle';
export const USE_BRANCH_FOR_ISSUES = 'useBranchForIssues';
export const WORKING_ISSUE_FORMAT_SCM = 'workingIssueFormatScm';
export const IGNORE_COMPLETION_TRIGGER = 'ignoreCompletionTrigger';
export const ISSUE_COMPLETION_FORMAT_SCM = 'issueCompletionFormatScm';
export const CREATE_ISSUE_TRIGGERS = 'createIssueTriggers';
export const DEFAULT = 'default';
export const IGNORE_MILESTONES = 'ignoreMilestones';
export const ALLOW_FETCH = 'allowFetch';

// git
export const GIT = 'git';
export const PULL_BEFORE_CHECKOUT = 'pullBeforeCheckout';
export const OPEN_DIFF_ON_CLICK = 'openDiffOnClick';
export const AUTO_STASH = 'autoStash';

// GitHub Enterprise
export const GITHUB_ENTERPRISE = 'github-enterprise';
export const URI = 'uri';

// Editor
export const EDITOR = 'editor';
export const WORD_WRAP = 'wordWrap';

// Comments
export const COMMENTS = 'comments';
export const OPEN_VIEW = 'openView';

// Explorer
export const EXPLORER = 'explorer';
export const AUTO_REVEAL = 'autoReveal';
