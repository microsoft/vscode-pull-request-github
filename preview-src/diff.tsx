import * as React from 'react';

import { DiffHunk, DiffLine } from '../src/common/diffHunk';

export const Diff = ({ hunks, path, outdated=false }: { hunks: DiffHunk[], outdated: boolean, path: string }) =>
	<div className='diff'>
		<div className='diffHeader'>
			<span className={`diffPath ${outdated ? 'outdated' : ''}`}>{path}</span>
		</div>
		{hunks.map(hunk => <Hunk hunk={hunk} />)}
	</div>;

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
