export type State = {
	newPR: NewPRState;
	gitHubRemotes: GitHubRemotesState;
	localBranches: string[];
};

export type NewPRState = {
	spec: NewPRSpecState;
	errors?: { [location: string]: string };
	request?: NewPRRequest;
};

export type NewPRRequest = {
	user: string;
	push: PushParams;
	params: PullRequestCreateParams;
};

export type PushParams = {
	localBranch: string;
	remoteBranch: string;
	remote: string;
};

export type NewPRSpecState = {
	title: string;
	body: string;
	branch: {
		name?: string;
		upstream?: Upstream;
	};
	parentIsBase: boolean;
};

export type GitHubRemotesState = {
	[remoteName: string]: GitHubRemote
};

export type Upstream = {
	branch: string;
	remote: string;
};

export type GitHubRemote = {
	readonly host: string;
	readonly owner: string;
	readonly name: string;
	readonly metadata?: any;
};

export type PullRequestCreateParams = {
	base: string;
	body?: string;
	head: string;
	maintainer_can_modify?: boolean;
	owner: string;
	repo: string;
	title: string;
};