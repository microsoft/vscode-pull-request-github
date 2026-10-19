/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

type Edit = { type: ' ' | '-' | '+'; text: string };

const CONTEXT = 3;
const MAX_EDIT_DISTANCE = 1000;

function lines(text: string): string[] {
	if (!text) {
		return [];
	}
	const result = text.split('\n');
	if (result[result.length - 1] === '') {
		result.pop();
	}
	return result;
}

/** Myers shortest edit script. Returns undefined when the edit distance exceeds the limit. */
function myers(a: string[], b: string[]): Edit[] | undefined {
	const max = Math.min(a.length + b.length, MAX_EDIT_DISTANCE);
	const offset = max + 1;
	let v = new Int32Array(2 * max + 3);
	const trace: Int32Array[] = [];
	for (let d = 0; d <= max; d++) {
		trace.push(v.slice());
		const next = v.slice();
		for (let k = -d; k <= d; k += 2) {
			let x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) ? v[offset + k + 1] : v[offset + k - 1] + 1;
			let y = x - k;
			while (x < a.length && y < b.length && a[x] === b[y]) {
				x++;
				y++;
			}
			next[offset + k] = x;
			if (x >= a.length && y >= b.length) {
				return backtrack(a, b, trace, offset, d, k);
			}
		}
		v = next;
	}
	return undefined;
}

function backtrack(a: string[], b: string[], trace: Int32Array[], offset: number, d: number, k: number): Edit[] {
	const edits: Edit[] = [];
	let x = a.length;
	let y = b.length;
	for (let depth = d; depth > 0; depth--) {
		const v = trace[depth];
		const down = k === -depth || (k !== depth && v[offset + k - 1] < v[offset + k + 1]);
		const previousK = down ? k + 1 : k - 1;
		const previousX = v[offset + previousK];
		const previousY = previousX - previousK;
		while (x > previousX && y > previousY) {
			edits.push({ type: ' ', text: a[--x] });
			y--;
		}
		if (down) {
			edits.push({ type: '+', text: b[--y] });
		} else {
			edits.push({ type: '-', text: a[--x] });
		}
		k = previousK;
	}
	while (x > 0 && y > 0) {
		edits.push({ type: ' ', text: a[--x] });
		y--;
	}
	return edits.reverse();
}

function edits(a: string[], b: string[]): Edit[] {
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) {
		start++;
	}
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const middleA = a.slice(start, endA);
	const middleB = b.slice(start, endB);
	// A large rewrite is still described correctly as a full replacement of the changed region.
	const middle = myers(middleA, middleB) ?? [
		...middleA.map(text => ({ type: '-' as const, text })),
		...middleB.map(text => ({ type: '+' as const, text })),
	];
	return [
		...a.slice(0, start).map(text => ({ type: ' ' as const, text })),
		...middle,
		...a.slice(endA).map(text => ({ type: ' ' as const, text })),
	];
}

/** Builds the hunk portion of a unified diff (the same shape as GitHub's `patch` field). */
export function unifiedPatch(base: string, head: string): { patch: string; additions: number; deletions: number } {
	const script = edits(lines(base), lines(head));
	const hunks: string[] = [];
	let additions = 0;
	let deletions = 0;
	let index = 0;
	let oldLine = 1;
	let newLine = 1;
	const positions = script.map(edit => {
		const position = { old: oldLine, new: newLine };
		if (edit.type !== '+') {
			oldLine++;
		}
		if (edit.type !== '-') {
			newLine++;
		}
		return position;
	});
	while (index < script.length) {
		if (script[index].type === ' ') {
			index++;
			continue;
		}
		const start = Math.max(0, index - CONTEXT);
		let end = index;
		let lastChange = index;
		while (end < script.length && end - lastChange <= 2 * CONTEXT) {
			if (script[end].type !== ' ') {
				lastChange = end;
			}
			end++;
		}
		end = Math.min(script.length, lastChange + CONTEXT + 1);
		const slice = script.slice(start, end);
		const oldCount = slice.filter(edit => edit.type !== '+').length;
		const newCount = slice.filter(edit => edit.type !== '-').length;
		const oldStart = oldCount ? positions[start].old : positions[start].old - 1;
		const newStart = newCount ? positions[start].new : positions[start].new - 1;
		hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
		for (const edit of slice) {
			additions += edit.type === '+' ? 1 : 0;
			deletions += edit.type === '-' ? 1 : 0;
			hunks.push(`${edit.type}${edit.text}`);
		}
		index = end;
	}
	return { patch: hunks.join('\n'), additions, deletions };
}
