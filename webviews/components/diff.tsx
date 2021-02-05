/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';

import { DiffHunk, DiffLine, DiffChangeType } from '../../src/common/diffHunk';

function Diff({ hunks }: { hunks: DiffHunk[] }) {
	return <div className='diff'>
		{hunks.map(hunk => <Hunk hunk={hunk} />)}
	</div>;
}

export default Diff;

const Hunk = ({ hunk, maxLines=4 }: {hunk: DiffHunk, maxLines?: number }) => <>{
	hunk.diffLines.slice(-maxLines)
		.map(line =>
			<div key={keyForDiffLine(line)} className={`diffLine ${getDiffChangeClass(line.type)}`}>
				<LineNumber num={line.oldLineNumber} />
				<LineNumber num={line.newLineNumber} />
				<span className='diffTypeSign'>{(line as any)._raw.substr(0,1)}</span>
				<span className='lineContent'>{(line as any)._raw.substr(1)}</span>
			</div>)
}</>;

const keyForDiffLine = (diffLine: DiffLine) =>
	`${diffLine.oldLineNumber}->${diffLine.newLineNumber}`;

const LineNumber = ({ num }: { num: number }) =>
	<span className='lineNumber'>{num > 0 ? num : ' '}</span>;

const getDiffChangeClass = (type: DiffChangeType) =>
	DiffChangeType[type].toLowerCase();
