import { SinonSandbox } from 'sinon';
import { QueryOptions, ApolloQueryResult, FetchResult, MutationOptions, NetworkStatus } from 'apollo-boost';

import { GitHubRepository } from '../../github/githubRepository';
import { QueryProvider } from './queryProvider';
import { Remote } from '../../common/remote';
import { CredentialStore } from '../../github/credentials';
import { RepositoryBuilder } from '../builders/rest/repoBuilder';
import { UserBuilder } from '../builders/rest/userBuilder';
import { PullRequestBuilder } from '../builders/graphql/pullRequestBuilder';
const queries = require('./queries.gql');

interface IMockGitHubRepositoryOptions {
	failAuthentication?: boolean;
	noGraphQL?: boolean;
}

export class MockGitHubRepository extends GitHubRepository {
	readonly queryProvider: QueryProvider;

	constructor(
		remote: Remote,
		credentialStore: CredentialStore,
		sinon: SinonSandbox,
		private _options: IMockGitHubRepositoryOptions = {},
	) {
		super(remote, credentialStore);

		this.queryProvider = new QueryProvider(sinon);

		this._hub = {
			octokit: this.queryProvider.octokit,
			graphql: null,
		};

		this._metadata = {
			...new RepositoryBuilder().build(),
			currentUser: new UserBuilder().build(),
		};

		this._initialized = true;
	}

	async ensure() {
		return this;
	}

	async authenticate() {
		return !this._options.failAuthentication;
	}

	get supportsGraphQl() {
		return !this._options.noGraphQL;
	}

	query = async <T>(query: QueryOptions): Promise<ApolloQueryResult<T>> => this.queryProvider.emulateGraphQLQuery(query);

	mutate = async <T>(mutation: MutationOptions): Promise<FetchResult<T>> => this.queryProvider.emulateGraphQLMutation(mutation);

	buildMetadata(
		block: (repoBuilder: RepositoryBuilder, userBuilder: UserBuilder) => void
	) {
		const repoBuilder = new RepositoryBuilder();
		const userBuilder = new UserBuilder();
		block(repoBuilder, userBuilder);
		this._metadata = {
			...repoBuilder.build(),
			currentUser: userBuilder.build(),
		};
	}

	addPullRequest(block: (prBuilder: PullRequestBuilder) => void) {
		const builder = new PullRequestBuilder();
		block(builder);
		const pr = builder.build();

		this.queryProvider.expectGraphQLQuery({
			query: queries.PullRequest,
			variables: {
				owner: this.remote.owner,
				name: this.remote.repositoryName,
				number: pr.repository.pullRequest.number,
			}
		}, {data: pr, loading: false, stale: false, networkStatus: NetworkStatus.ready});
	}
}