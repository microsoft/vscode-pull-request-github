/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { PendingReviews, suggestionText } from '../../azure/review';
import { InMemoryMemento } from '../mocks/inMemoryMemento';

describe('Azure DevOps pending reviews', () => {
	let reviews: PendingReviews;
	let storage: InMemoryMemento;
	beforeEach(() => {
		storage = new InMemoryMemento();
		reviews = new PendingReviews(storage);
	});

	it('extracts plain suggestions including empty replacements and CRLF blocks', () => {
		assert.strictEqual(suggestionText('A change:\n```suggestion\none\ntwo\n```\nExplanation'), 'one\ntwo');
		assert.strictEqual(suggestionText('```suggestion\n```'), '');
		assert.strictEqual(suggestionText('```suggestion\r\nreplacement\r\n```'), 'replacement');
	});

	it('rejects ambiguous and offset suggestions rather than applying the wrong range', () => {
		for (const content of ['No suggestion', '```suggestion:-1+2\ntext\n```', '```suggestion\none\n```\n```suggestion\ntwo\n```']) {
			assert.throws(() => suggestionText(content), /one plain suggestion/);
		}
	});

	it('persists drafts across activations and isolates repositories', async () => {
		await reviews.start('repository/42', 'author', 'commit');
		await reviews.add('repository/42', { content: 'Private draft' });
		const restored = new PendingReviews(storage);
		assert.strictEqual(restored.get('repository/42')?.comments[0].content, 'Private draft');
		assert.strictEqual(restored.get('other/42'), undefined);
	});

	it('serializes concurrent draft writes without dropping comments', async () => {
		await reviews.start('key', 'author', 'commit');
		await Promise.all([reviews.add('key', { content: 'One' }), reviews.add('key', { content: 'Two' })]);
		assert.deepStrictEqual(reviews.get('key')?.comments.map(comment => comment.id), [-1, -2]);
	});

	it('edits and deletes local drafts without an HTTP request', async () => {
		await reviews.start('key', 'author', 'commit');
		await reviews.add('key', { content: 'Original' });
		await reviews.edit('key', -1, 'Edited');
		assert.strictEqual(reviews.get('key')?.comments[0].content, 'Edited');
		await reviews.edit('key', -1);
		assert.deepStrictEqual(reviews.get('key')?.comments, []);
	});

	it('rejects account/commit changes before posting anything', async () => {
		await reviews.start('key', 'author', 'commit');
		await reviews.add('key', { content: 'Draft' });
		await assert.rejects(reviews.submit('key', 'other', 'commit', async () => assert.fail('must not publish'), async () => { }), /account|Account/);
		await assert.rejects(reviews.submit('key', 'author', 'updated', async () => assert.fail('must not publish'), async () => { }), /commit/);
		assert.strictEqual(reviews.get('key')?.comments.length, 1);
	});

	it('removes only acknowledged drafts and resumes a partial failure', async () => {
		await reviews.start('key', 'author', 'commit');
		await reviews.add('key', { content: 'One' });
		await reviews.add('key', { content: 'Two' });
		const markers: string[] = [];
		await assert.rejects(reviews.submit('key', 'author', 'commit', async (comment, marker) => {
			if (comment.content === 'Two') {
				throw new Error('HTTP 503');
			}
			markers.push(marker);
		}, async () => assert.fail('do not vote after a failure')), /503/);
		assert.deepStrictEqual(reviews.get('key')?.comments.map(comment => comment.content), ['Two']);
		let votes = 0;
		await reviews.submit('key', 'author', 'commit', async (comment, marker) => {
			assert.strictEqual(comment.content, 'Two');
			markers.push(marker);
		}, async () => { votes++; });
		assert.strictEqual(votes, 1);
		assert.notStrictEqual(markers[0], markers[1]);
		assert.strictEqual(reviews.get('key'), undefined);
	});

	it('retains a resumable session if voting fails after all comments were posted', async () => {
		await reviews.start('key', 'author', 'commit');
		await reviews.add('key', { content: 'Draft' });
		await assert.rejects(reviews.submit('key', 'author', 'commit', async () => { }, async () => { throw new Error('vote failed'); }), /vote failed/);
		assert.deepStrictEqual(reviews.get('key')?.comments, []);
		await reviews.submit('key', 'author', 'commit', async () => assert.fail('must not repost'), async () => { });
		assert.strictEqual(reviews.get('key'), undefined);
	});
});
