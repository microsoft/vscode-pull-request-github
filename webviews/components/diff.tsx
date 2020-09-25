/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { useContext } from 'react';

import { IComment } from '../../src/common/comment';
import { DiffHunk, DiffLine, DiffChangeType } from '../../src/common/diffHunk';
import PullRequestContext from '../common/context';

function Diff({ comment, hunks, path, outdated=false }: { comment: IComment, hunks: DiffHunk[], outdated: boolean, path: string }) {
	const { openDiff } = useContext(PullRequestContext);
	return <div className='diff'>
		<div className='diffHeader'>
			<a className={`diffPath ${outdated ? 'outdated' : ''}`} onClick={() => openDiff(comment)}>{path}</a>
			{outdated && <span className='outdatedLabel'>Outdated</span>}
		</div>
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
