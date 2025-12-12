/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';

import { DiffChangeType, DiffHunk, DiffLine } from '../../src/common/diffHunk';

function Diff({ hunks }: { hunks: DiffHunk[] }) {
	return (
		<div className="diff">
			{hunks.map((hunk, index) => (
				<Hunk key={index} hunk={hunk} />
			))}
		</div>
	);
}

export default Diff;

const Hunk = ({ hunk, maxLines = 8 }: { hunk: DiffHunk; maxLines?: number }) => (
	<>
		{hunk.diffLines.slice(-maxLines).map(line => (
			<div key={keyForDiffLine(line)} className={`diffLine ${getDiffChangeClass(line.type)}`}>
				<LineNumber num={line.oldLineNumber} />
				<LineNumber num={line.newLineNumber} />
				<div className="diffTypeSign">{(line as any)._raw.substr(0, 1)}</div>
				<div className="lineContent">{(line as any)._raw.substr(1)}</div>
			</div>
		))}
	</>
);

const keyForDiffLine = (diffLine: DiffLine) => `${diffLine.oldLineNumber}->${diffLine.newLineNumber}`;

const LineNumber = ({ num }: { num: number }) => <div className="lineNumber">{num > 0 ? num : ' '}</div>;

const getDiffChangeClass = (type: DiffChangeType) => DiffChangeType[type].toLowerCase();
