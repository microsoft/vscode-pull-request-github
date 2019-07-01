import * as React from 'react';
import { useContext } from 'react';

import { IComment } from '../src/common/comment';
import { DiffHunk, DiffLine } from '../src/common/diffHunk';
import PullRequestContext from './context';

function Diff({ comment, hunks, path, outdated=false }: { comment: IComment, hunks: DiffHunk[], outdated: boolean, path: string }) {
	const { openDiff } = useContext(PullRequestContext);
	return <div className='diff'>
		<div className='diffHeader'>
			<a className={`diffPath ${outdated ? 'outdated' : ''}`} onClick={() => openDiff(comment)}>{path}</a>
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
				<span className='lineContent'>{(line as any)._raw}</span>
			</div>)
}</>;

const keyForDiffLine = (diffLine: DiffLine) =>
	`${diffLine.oldLineNumber}->${diffLine.newLineNumber}`;

const LineNumber = ({ num }: { num: number }) =>
	<span className='lineNumber'>{num > 0 ? num : ' '}</span>;

export enum DiffChangeType {
	Context,
	Add,
	Delete,
	Control
}

export function getDiffChangeType(text: string) {
	let c = text[0];
	switch (c) {
		case ' ': return DiffChangeType.Context;
		case '+': return DiffChangeType.Add;
		case '-': return DiffChangeType.Delete;
		default: return DiffChangeType.Control;
	}
}

const getDiffChangeClass = (type: DiffChangeType) =>
	DiffChangeType[type].toLowerCase();
