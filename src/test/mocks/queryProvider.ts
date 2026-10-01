/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { inspect } from 'util';
import { Octokit } from '@octokit/rest';
import {
	ApolloQueryResult,
	QueryOptions,
	DocumentNode,
	OperationVariables,
	MutationOptions,
	FetchResult,
} from 'apollo-boost';
import { SinonSandbox, SinonStub, SinonStubbedInstance } from 'sinon';
import equals from 'fast-deep-equal';

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

		// Create the stubbed Octokit instance indirectly like this, rather than using `this._sinon.createStubbedInstance()`,
		// because the exported Octokit function is actually a bound constructor method. `Object.getPrototypeOf(Octokit)` returns
		// the correct prototype, but `Octokit.prototype` does not.
		this._octokit = this._sinon.stub(Object.create(Object.getPrototypeOf(Octokit)));
	}

	get octokit(): Octokit {
		// Cast through "any" because SinonStubbedInstance<Octokit> does not properly map the type of the
		// overloaded "authenticate" method.
		return (this._octokit as any) as Octokit;
	}

	expectGraphQLQuery<T>(q: QueryOptions, result: ApolloQueryResult<T>) {
		if (!q.query) {
			throw new Error('Empty GraphQL query used in expectation. Is the GraphQL loader configured properly?');
		}

		const cannedResponse: RecordedQueryResult<T> = { variables: q.variables, result };

		const cannedResponses = this._graphqlQueryResponses.get(q.query) || [];
		if (cannedResponses.length === 0) {
			this._graphqlQueryResponses.set(q.query, [cannedResponse]);
		} else {
			cannedResponses.push(cannedResponse);
		}
	}

	expectGraphQLMutation<T>(m: MutationOptions, result: FetchResult<T>) {
		const cannedResponse: RecordedMutationResult<T> = { variables: m.variables, result };

		const cannedResponses = this._graphqlMutationResponses.get(m.mutation) || [];
		if (cannedResponses.length === 0) {
			this._graphqlMutationResponses.set(m.mutation, [cannedResponse]);
		} else {
			cannedResponses.push(cannedResponse);
		}
	}

	expectOctokitRequest<R>(accessorPath: string[], args: any[], response: R) {
		this.getOctokitRequestStub(accessorPath).withArgs(...args).resolves({
			data: response,
			headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999' },
		});
	}

	expectOctokitError(accessorPath: string[], args: any[], error: Error) {
		this.getOctokitRequestStub(accessorPath).withArgs(...args).rejects(error);
	}

	private getOctokitRequestStub(accessorPath: string[]): SinonStub {
		let currentStub: SinonStubbedInstance<any> = this._octokit;
		accessorPath.forEach((accessor, i) => {
			let nextStub = currentStub[accessor];
			if (nextStub === undefined) {
				nextStub =
					i < accessorPath.length - 1
						? {}
						: this._sinon.stub().callsFake((...variables) => {
							throw new Error(
								`Unexpected octokit query: ${accessorPath.join('.')}(${variables
									.map(v => inspect(v))
									.join(', ')})`,
							);
						});
				currentStub[accessor] = nextStub;
			}
			currentStub = nextStub;
		});
		return currentStub as SinonStub;
	}

	emulateGraphQLQuery<T>(q: QueryOptions): ApolloQueryResult<T> {
		const cannedResponses = this._graphqlQueryResponses.get(q.query) || [];
		const cannedResponse = cannedResponses.find(
			each =>
				!!each.variables &&
				Object.keys(each.variables).every(key => each.variables![key] === q.variables![key]),
		);
		if (cannedResponse) {
			return cannedResponse.result;
		} else {
			if (cannedResponses.length > 0) {
				let message = 'Variables did not match any expected queries:\n';
				for (const { variables } of cannedResponses) {
					message += `  ${inspect(variables, { depth: 3 })}\n`;
				}
				console.error(message);
			}
			throw new Error(`Unexpected GraphQL query: ${q}`);
		}
	}

	emulateGraphQLMutation<T>(m: MutationOptions<T, OperationVariables>): FetchResult<T> {
		const cannedResponses = this._graphqlMutationResponses.get(m.mutation) || [];
		const cannedResponse = cannedResponses.find(
			each =>
				!!each.variables &&
				Object.keys(each.variables).every(key => equals(each.variables![key], m.variables![key])),
		);
		if (cannedResponse) {
			return cannedResponse.result;
		} else {
			if (cannedResponses.length > 0) {
				let message = 'Variables did not match any expected queries:\n';
				for (const { variables } of cannedResponses) {
					message += `  ${inspect(variables, { depth: 3 })}\n`;
				}
				console.error(message);
			}
			throw new Error(`Unexpected GraphQL mutation: ${m}`);
		}
	}
}
