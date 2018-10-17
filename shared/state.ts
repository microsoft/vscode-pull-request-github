export type State = {
	spec: {
		title: string,
		body: string,
		localBranches: string[],
		selectedLocalBranch: {
			name: string,
			upstream: {
				branch: string,
				remote: string,
			}
		},
		gitHubRemotes: {
			[name: string]: {
				host: string,
				name: string,
				owner: string,
				metadata: any,
			}
		},
		parentIsBase: boolean,
	},
	willCreatePR: {
		remote: string,
		params: PullRequestsCreateParams,
	} | null
};

type PullRequestsCreateParams = {
	base: string;
	body?: string;
	head: string;
	maintainer_can_modify?: boolean;
	owner: string;
	repo: string;
	title: string;
};