import { expect } from 'chai';
import { parseDiffHunk } from '../../common/diff';

describe('parseDiffHunk', () => {
	it('diffhunk iterator', () => {		
		let diffHunkReader = parseDiffHunk('');
		let diffHunkIter = diffHunkReader.next();
		let diffHunks = [];

		while (!diffHunkIter.done) {
			let diffHunk = diffHunkIter.value;
			diffHunks.push(diffHunk);
		}
		
		expect(diffHunks.length).to.equal(0);
	});	
});