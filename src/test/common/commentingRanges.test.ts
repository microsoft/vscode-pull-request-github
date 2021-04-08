/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'assert';
import { FileDiff, LineDiffBlockChangeType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { getDiffHunkFromFileDiff } from '../../azdo/utils';
import { getCommentingRanges } from '../../common/commentingRanges';

const edit_filediff: FileDiff = {
	path: '/Readme.md',
	originalPath: '/Readme.md',
	lineDiffBlocks: [
		{
			changeType: LineDiffBlockChangeType.None,
			originalLineNumberStart: 1,
			originalLinesCount: 40,
			modifiedLineNumberStart: 1,
			modifiedLinesCount: 40,
		},
		{
			changeType: LineDiffBlockChangeType.Edit,
			originalLineNumberStart: 41,
			originalLinesCount: 1,
			modifiedLineNumberStart: 41,
			modifiedLinesCount: 2,
		},
		{
			changeType: LineDiffBlockChangeType.None,
			originalLineNumberStart: 42,
			originalLinesCount: 61,
			modifiedLineNumberStart: 43,
			modifiedLinesCount: 61,
		},
		{
			changeType: LineDiffBlockChangeType.Edit,
			originalLineNumberStart: 103,
			originalLinesCount: 1,
			modifiedLineNumberStart: 104,
			modifiedLinesCount: 1,
		},
		{
			changeType: LineDiffBlockChangeType.None,
			originalLineNumberStart: 104,
			originalLinesCount: 228,
			modifiedLineNumberStart: 105,
			modifiedLinesCount: 228,
		},
	],
};

const delete_filediff: FileDiff = {
	path: '',
	originalPath: '/README.md',
	lineDiffBlocks: [
		{
			changeType: LineDiffBlockChangeType.Delete,
			originalLineNumberStart: 1,
			originalLinesCount: 22,
			modifiedLineNumberStart: 0,
			modifiedLinesCount: 0,
		},
	],
};

const edit_hunks = getDiffHunkFromFileDiff(edit_filediff);

describe('getCommentingRanges', () => {
	it('shoud return only ranges for deleted lines, mapped to full file, for the base file', () => {
		const commentingRanges = getCommentingRanges(edit_hunks, true);
		assert.equal(commentingRanges.length, 2);
		assert.equal(commentingRanges[0].start.line, 40);
		assert.equal(commentingRanges[0].start.character, 0);
		assert.equal(commentingRanges[0].end.line, 40);
		assert.equal(commentingRanges[0].end.character, 0);

		assert.equal(commentingRanges[1].start.line, 102);
		assert.equal(commentingRanges[1].start.character, 0);
		assert.equal(commentingRanges[1].end.line, 102);
		assert.equal(commentingRanges[1].end.character, 0);
	});

	it('shoud return only ranges for changes, mapped to full file, for the modified file', () => {
		const commentingRanges = getCommentingRanges(edit_hunks, false);
		assert.equal(commentingRanges.length, 2);
		assert.equal(commentingRanges[0].start.line, 37);
		assert.equal(commentingRanges[0].start.character, 0);
		assert.equal(commentingRanges[0].end.line, 44);
		assert.equal(commentingRanges[0].end.character, 0);

		assert.equal(commentingRanges[1].start.line, 100);
		assert.equal(commentingRanges[1].start.character, 0);
		assert.equal(commentingRanges[1].end.line, 105);
		assert.equal(commentingRanges[1].end.character, 0);
	});

	it('should handle the last part of the diff being a deletion, for the base file', () => {
		const diffHunksForDeletion = getDiffHunkFromFileDiff(delete_filediff);
		const commentingRanges = getCommentingRanges(diffHunksForDeletion, true);
		assert.equal(commentingRanges.length, 1);
		assert.equal(commentingRanges[0].start.line, 0);
		assert.equal(commentingRanges[0].start.character, 0);
		assert.equal(commentingRanges[0].end.line, 21);
		assert.equal(commentingRanges[0].end.character, 0);
	});
});
