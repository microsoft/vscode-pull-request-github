import { inspect } from 'util';

import isEqual from 'lodash.isequal';
import { ApolloQueryResult, QueryOptions, DocumentNode, OperationVariables, MutationOptions, FetchResult } from 'apollo-boost';
import Octokit from '@octokit/rest';
import { SinonSandbox, SinonStubbedInstance } from 'sinon';

interface RecordedQueryResult<T> {
	variables?: OperationVariables;
	result: ApolloQueryResult<any>;
}

interface RecordedMutationResult<T> {
	variables?: OperationVariables;
	result: FetchResult<any>;
}

export class QueryProvider {
	private _graphqlQueryResponses: Map<DocumentNode, RecordedQueryResult<any>[]>;
	private _graphqlMutationResponses: Map<DocumentNode, RecordedMutationResult<any>[]>;
	private _octokit: SinonStubbedInstance<Octokit>;

	constructor(private _sinon: SinonSandbox) {
		this._graphqlQueryResponses = new Map();
		this._graphqlMutationResponses = new Map();

		this._octokit = this._sinon.createStubInstance(Octokit);
	}

	get octokit(): Octokit {
		return this._octokit;
	}

	expectGraphQLQuery<T>(q: QueryOptions, result: ApolloQueryResult<T>) {
		if (!q.query) {
			throw new Error('Empty GraphQL query used in expectation. Is the GraphQL loader configured properly?');
		}

		const cannedResponse: RecordedQueryResult<T> = {variables: q.variables, result};

		const cannedResponses = this._graphqlQueryResponses.get(q.query) || [];
		if (cannedResponses.length === 0) {
			this._graphqlQueryResponses.set(q.query, [cannedResponse]);
		} else {
			cannedResponses.push(cannedResponse);
		}
	}

	expectGraphQLMutation<T>(m: MutationOptions, result: FetchResult<T>) {
		const cannedResponse: RecordedMutationResult<T> = {variables: m.variables, result};

		const cannedResponses = this._graphqlMutationResponses.get(m.mutation) || [];
		if (cannedResponses.length === 0) {
			this._graphqlMutationResponses.set(m.mutation, [cannedResponse]);
		} else {
			cannedResponses.push(cannedResponse);
		}
	}

	expectOctokitRequest<R>(accessorPath: string[], args: any[], response: R) {
		let currentStub: SinonStubbedInstance<any> = this._octokit;
		for (const accessor of accessorPath) {
			currentStub = currentStub[accessor] || currentStub.stub(accessor);
		}
		currentStub.withArgs(...args).resolves(response);
	}

	emulateGraphQLQuery<T>(q: QueryOptions): ApolloQueryResult<T> {
		const cannedResponses = this._graphqlQueryResponses.get(q.query) || [];
		const cannedResponse = cannedResponses.find(each => isEqual(each.variables, q.variables));
		if (cannedResponse) {
			return cannedResponse.result;
		} else {
			if (cannedResponses.length > 0) {
				let message = 'Variables did not match any expected queries:\n';
				for (const {variables} of cannedResponses) {
					message += `  ${inspect(variables, {depth: 3})}\n`;
				}
				console.error(message);
			}
			throw new Error(`Unexpected GraphQL query: ${q}`);
		}
	}

	emulateGraphQLMutation<T>(m: MutationOptions): FetchResult<T> {
		const cannedResponses = this._graphqlMutationResponses.get(m.mutation) || [];
		const cannedResponse = cannedResponses.find(each => isEqual(each.variables, m.variables));
		if (cannedResponse) {
			return cannedResponse.result;
		} else {
			if (cannedResponses.length > 0) {
				let message = 'Variables did not match any expected queries:\n';
				for (const {variables} of cannedResponses) {
					message += `  ${inspect(variables, {depth: 3})}\n`;
				}
				console.error(message);
			}
			throw new Error(`Unexpected GraphQL mutation: ${m}`);
		}
	}
}