'use strict';
import { Disposable } from 'vscode';

export { Disposable } from 'vscode';

export interface RemoteProvider {
	readonly id: string;
	readonly name: string;
	readonly domain: string;
}

export interface CreatePullRequestActionContext {
	readonly type: 'createPullRequest';
	readonly runnerId?: number;

	readonly repoPath: string;
	readonly branch: {
		readonly name: string;
		readonly upstream: string | undefined;
		readonly isRemote: boolean;
	};
	readonly remote:
		| {
				readonly name: string;
				readonly provider?: RemoteProvider;
				readonly url?: string;
		  }
		| undefined;
}

export interface OpenPullRequestActionContext {
	readonly type: 'openPullRequest';
	readonly runnerId?: number;

	readonly repoPath: string;
	readonly provider: RemoteProvider | undefined;
	readonly pullRequest: {
		readonly id: string;
		readonly url: string;
	};
}

export type ActionContext = CreatePullRequestActionContext | OpenPullRequestActionContext;
export type Action<T extends ActionContext> = T['type'];

export interface ActionRunner {
	readonly name: string;
	readonly label: string;

	run(context: ActionContext): void | Promise<void>;
}

export interface GitLensApi {
	registerActionRunner<T extends ActionContext>(action: Action<T>, runner: ActionRunner): Disposable;
}
