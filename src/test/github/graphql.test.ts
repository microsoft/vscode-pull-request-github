/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { isAccount, isTeam, Actor, Account, Team, Node } from '../../github/graphql';

describe('graphql type guards', () => {

	describe('isAccount', () => {
		it('returns true for a valid Account', () => {
			const account: Account = {
				__typename: 'User',
				id: 'acct1',
				login: 'alice',
				avatarUrl: 'https://example.com/a.png',
				url: 'https://example.com/alice',
				name: 'Alice',
				email: 'alice@example.com'
			};
			assert.strictEqual(isAccount(account), true);
		});

		it('returns false for Actor missing name/email', () => {
			const actor: Actor = {
				__typename: 'User',
				id: 'act1',
				login: 'bob',
				avatarUrl: 'https://example.com/b.png',
				url: 'https://example.com/bob'
			};
			assert.strictEqual(isAccount(actor), false);
		});

		it('returns false for Team object', () => {
			const team: Team = {
				avatarUrl: 'https://example.com/t.png',
				name: 'Dev Team',
				url: 'https://example.com/team',
				repositories: { nodes: [] },
				slug: 'dev-team',
				id: 'team1'
			};
			assert.strictEqual(isAccount(team), false);
		});

		it('returns false for Node object', () => {
			const node: Node = { id: 'node1' };
			assert.strictEqual(isAccount(node), false);
		});

		it('returns false for null and undefined', () => {
			assert.strictEqual(isAccount(null), false);
			assert.strictEqual(isAccount(undefined), false);
		});

		it('returns true when name and email are null', () => {
			const obj: any = {
				__typename: 'User', id: 'null1', login: 'nullUser', avatarUrl: '', url: '', name: null, email: null
			};
			assert.strictEqual(isAccount(obj), true);
		});

		it('returns true when name is null but email present', () => {
			const obj: any = {
				__typename: 'User', id: 'null2', login: 'nullName', avatarUrl: '', url: '', name: null, email: 'e@example.com'
			};
			assert.strictEqual(isAccount(obj), true);
		});

		it('returns false when email or name is undefined', () => {
			const obj: any = {
				__typename: 'User', id: 'null3', login: 'nullEmail', avatarUrl: '', url: '', name: undefined, email: undefined
			};
			assert.strictEqual(isAccount(obj), false);
		});
	});

	describe('isTeam', () => {
		it('returns true for a valid Team', () => {
			const team: Team = {
				avatarUrl: 'https://example.com/t.png',
				name: 'Engineering',
				url: 'https://example.com/eng',
				repositories: { nodes: [] },
				slug: 'engineering',
				id: 'team2'
			};
			assert.strictEqual(isTeam(team), true);
		});

		it('returns false for Account object', () => {
			const account: Account = {
				__typename: 'User',
				id: 'acct2',
				login: 'carol',
				avatarUrl: 'https://example.com/c.png',
				url: 'https://example.com/carol',
				name: 'Carol',
				email: 'carol@example.com'
			};
			assert.strictEqual(isTeam(account), false);
		});

		it('returns false for Actor without slug', () => {
			const actor: Actor = {
				__typename: 'User',
				id: 'act2',
				login: 'dave',
				avatarUrl: 'https://example.com/d.png',
				url: 'https://example.com/dave'
			};
			assert.strictEqual(isTeam(actor), false);
		});

		it('returns false for Node object', () => {
			const node: Node = { id: 'node2' };
			assert.strictEqual(isTeam(node), false);
		});

		it('returns false for null and undefined', () => {
			assert.strictEqual(isTeam(null), false);
			assert.strictEqual(isTeam(undefined), false);
		});

		it('returns false when slug is undefined', () => {
			const obj: any = {
				avatarUrl: '', name: 'Team', url: '', repositories: { nodes: [] }, slug: undefined, id: 'tslugnull'
			};
			assert.strictEqual(isTeam(obj), false);
		});
		it('returns true when slug is null', () => {
			const obj: any = {
				avatarUrl: '', name: 'Team', url: '', repositories: { nodes: [] }, slug: null, id: 'tslugnull'
			};
			assert.strictEqual(isTeam(obj), true);
		});
	});
});

