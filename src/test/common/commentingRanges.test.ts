/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert = require('assert');
import { getCommentingRanges } from '../../common/commentingRanges';
import { parsePatch } from '../../common/diffHunk';

const patch = [
	`"@@ -8,6 +8,7 @@ import { Terminal } from './Terminal';`,
	` import { MockViewport, MockCompositionHelper, MockRenderer } from './TestUtils.test';`,
	` import { DEFAULT_ATTR_DATA } from 'common/buffer/BufferLine';`,
	` import { CellData } from 'common/buffer/CellData';`,
	`+import { wcwidth } from 'common/CharWidth';`,
	` `,
	` const INIT_COLS = 80;`,
	` const INIT_ROWS = 24;`,
	`@@ -750,10 +751,14 @@ describe('Terminal', () => {`,
	`        for (let i = 0xDC00; i <= 0xDCFF; ++i) {`,
	`        term.buffer.x = term.cols - 1;`,
	`        term.wraparoundMode = false;`,
	`+        const width = wcwidth((0xD800 - 0xD800) * 0x400 + i - 0xDC00 + 0x10000);`,
	`+        if (width !== 1) {`,
	`+          continue;`,
	`+        }`,
	`        term.write('a' + high + String.fromCharCode(i));`,
	`        // auto wraparound mode should cut off the rest of the line`,
	`-        expect(term.buffer.lines.get(0).loadCell(term.cols - 1, cell).getChars()).eql('a');`,
	`-        expect(term.buffer.lines.get(0).loadCell(term.cols - 1, cell).getChars().length).eql(1);`,
	`+        expect(term.buffer.lines.get(0).loadCell(term.cols - 1, cell).getChars()).eql(high + String.fromCharCode(i));`,
	`+        expect(term.buffer.lines.get(0).loadCell(term.cols - 1, cell).getChars().length).eql(2);`,
	`         expect(term.buffer.lines.get(1).loadCell(1, cell).getChars()).eql('');`,
	`         term.reset();`,
	` }"`
].join('\n');

const deletionPatch = [
	`"@@ -1,5 +0,0 @@`,
	`-var express = require('express');`,
	`-var path = require('path');`,
	`-var favicon = require('serve-favicon');`,
	`-var logger = require('morgan');`,
	`-var cookieParser = require('cookie-parser');`
].join('\n');

const diffHunks = parsePatch(patch);

describe('getCommentingRanges', () => {
	it('shoud return only ranges for deleted lines, mapped to full file, for the base file', () => {
		const commentingRanges = getCommentingRanges(diffHunks, true);
		assert.equal(commentingRanges.length, 1);
		assert.equal(commentingRanges[0].start.line, 754);
		assert.equal(commentingRanges[0].start.character, 0);
		assert.equal(commentingRanges[0].end.line, 755);
		assert.equal(commentingRanges[0].end.character, 0);
	});

	it('shoud return only ranges for changes, mapped to full file, for the modified file', () => {
		const commentingRanges = getCommentingRanges(diffHunks, false);
		assert.equal(commentingRanges.length, 2);
		assert.equal(commentingRanges[0].start.line, 7);
		assert.equal(commentingRanges[0].start.character, 0);
		assert.equal(commentingRanges[0].end.line, 13);
		assert.equal(commentingRanges[0].end.character, 0);

		assert.equal(commentingRanges[1].start.line, 750);
		assert.equal(commentingRanges[1].start.character, 0);
		assert.equal(commentingRanges[1].end.line, 763);
		assert.equal(commentingRanges[1].end.character, 0);
	});

	it('should handle the last part of the diff being a deletion, for the base file', () => {
		const diffHunksForDeletion = parsePatch(deletionPatch);
		const commentingRanges = getCommentingRanges(diffHunksForDeletion, true);
		assert.equal(commentingRanges.length, 1);
		assert.equal(commentingRanges[0].start.line, 0);
		assert.equal(commentingRanges[0].start.character, 0);
		assert.equal(commentingRanges[0].end.line, 4);
		assert.equal(commentingRanges[0].end.character, 0);
	});
});