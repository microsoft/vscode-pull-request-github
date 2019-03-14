/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export class PathIterator implements IKeyIterator {

	private _value: string;
	private _from: number;
	private _to: number;

	reset(key: string): this {
		this._value = key.replace(/\\$|\/$/, '');
		this._from = 0;
		this._to = 0;
		return this.next();
	}

	hasNext(): boolean {
		return this._to < this._value.length;
	}

	next(): this {
		// this._data = key.split(/[\\/]/).filter(s => !!s);
		this._from = this._to;
		let justSeps = true;
		for (; this._to < this._value.length; this._to++) {
			const ch = this._value.charCodeAt(this._to);
			if (ch === 47 /* CharCode.Slash */ || ch === 92 /* CharCode.Backslash */) {
				if (justSeps) {
					this._from++;
				} else {
					break;
				}
			} else {
				justSeps = false;
			}
		}
		return this;
	}

	cmp(a: string): number {

		let aPos = 0;
		const aLen = a.length;
		let thisPos = this._from;

		while (aPos < aLen && thisPos < this._to) {
			const cmp = a.charCodeAt(aPos) - this._value.charCodeAt(thisPos);
			if (cmp !== 0) {
				return cmp;
			}
			aPos += 1;
			thisPos += 1;
		}

		if (aLen === this._to - this._from) {
			return 0;
		} else if (aPos < aLen) {
			return -1;
		} else {
			return 1;
		}
	}

	value(): string {
		return this._value.substring(this._from, this._to);
	}
}

export interface IteratorUndefinedResult {
	readonly done: true;
	readonly value: undefined;
}
export const FIN: IteratorUndefinedResult = { done: true, value: undefined };

export interface IKeyIterator {
	reset(key: string): this;
	next(): this;

	hasNext(): boolean;
	cmp(a: string): number;
	value(): string;
}

class TernarySearchTreeNode<E> {
	segment: string;
	value: E | undefined;
	key: string;
	left: TernarySearchTreeNode<E> | undefined;
	mid: TernarySearchTreeNode<E> | undefined;
	right: TernarySearchTreeNode<E> | undefined;

	isEmpty(): boolean {
		return !this.left && !this.mid && !this.right && !this.value;
	}
}

export class TernarySearchTree<E> {

	static forPaths<E>(): TernarySearchTree<E> {
		return new TernarySearchTree<E>(new PathIterator());
	}

	private _iter: IKeyIterator;
	private _root: TernarySearchTreeNode<E> | undefined;

	constructor(segments: IKeyIterator) {
		this._iter = segments;
	}

	clear(): void {
		this._root = undefined;
	}

	set(key: string, element: E): E | undefined {
		const iter = this._iter.reset(key);
		let node: TernarySearchTreeNode<E>;

		if (!this._root) {
			this._root = new TernarySearchTreeNode<E>();
			this._root.segment = iter.value();
		}

		node = this._root;
		while (true) {
			const val = iter.cmp(node.segment);
			if (val > 0) {
				// left
				if (!node.left) {
					node.left = new TernarySearchTreeNode<E>();
					node.left.segment = iter.value();
				}
				node = node.left;

			} else if (val < 0) {
				// right
				if (!node.right) {
					node.right = new TernarySearchTreeNode<E>();
					node.right.segment = iter.value();
				}
				node = node.right;

			} else if (iter.hasNext()) {
				// mid
				iter.next();
				if (!node.mid) {
					node.mid = new TernarySearchTreeNode<E>();
					node.mid.segment = iter.value();
				}
				node = node.mid;
			} else {
				break;
			}
		}
		const oldElement = node.value;
		node.value = element;
		node.key = key;
		return oldElement;
	}

	get(key: string): E | undefined {
		const iter = this._iter.reset(key);
		let node = this._root;
		while (node) {
			const val = iter.cmp(node.segment);
			if (val > 0) {
				// left
				node = node.left;
			} else if (val < 0) {
				// right
				node = node.right;
			} else if (iter.hasNext()) {
				// mid
				iter.next();
				node = node.mid;
			} else {
				break;
			}
		}
		return node ? node.value : undefined;
	}

	delete(key: string): void {

		const iter = this._iter.reset(key);
		const stack: [-1 | 0 | 1, TernarySearchTreeNode<E>][] = [];
		let node = this._root;

		// find and unset node
		while (node) {
			const val = iter.cmp(node.segment);
			if (val > 0) {
				// left
				stack.push([1, node]);
				node = node.left;
			} else if (val < 0) {
				// right
				stack.push([-1, node]);
				node = node.right;
			} else if (iter.hasNext()) {
				// mid
				iter.next();
				stack.push([0, node]);
				node = node.mid;
			} else {
				// remove element
				node.value = undefined;

				// clean up empty nodes
				while (stack.length > 0 && node.isEmpty()) {
					let [dir, parent] = stack.pop()!;
					switch (dir) {
						case 1: parent.left = undefined; break;
						case 0: parent.mid = undefined; break;
						case -1: parent.right = undefined; break;
					}
					node = parent;
				}
				break;
			}
		}
	}

	findSubstr(key: string): E | undefined {
		const iter = this._iter.reset(key);
		let node = this._root;
		let candidate: E | undefined = undefined;
		while (node) {
			const val = iter.cmp(node.segment);
			if (val > 0) {
				// left
				node = node.left;
			} else if (val < 0) {
				// right
				node = node.right;
			} else if (iter.hasNext()) {
				// mid
				iter.next();
				candidate = node.value || candidate;
				node = node.mid;
			} else {
				break;
			}
		}
		return node && node.value || candidate;
	}

	findSuperstr(key: string): Iterator<E | undefined> | undefined {
		const iter = this._iter.reset(key);
		let node = this._root;
		while (node) {
			const val = iter.cmp(node.segment);
			if (val > 0) {
				// left
				node = node.left;
			} else if (val < 0) {
				// right
				node = node.right;
			} else if (iter.hasNext()) {
				// mid
				iter.next();
				node = node.mid;
			} else {
				// collect
				if (!node.mid) {
					return undefined;
				} else {
					return this._nodeIterator(node.mid);
				}
			}
		}
		return undefined;
	}

	private _nodeIterator(node: TernarySearchTreeNode<E>): Iterator<E | undefined> {
		let res: { done: false; value: E; };
		let idx: number;
		let data: E[];
		const next = (): IteratorResult<E | undefined> => {
			if (!data) {
				// lazy till first invocation
				data = [];
				idx = 0;
				this._forEach(node, value => data.push(value));
			}
			if (idx >= data.length) {
				return { done: true, value: undefined };
			}

			if (!res) {
				res = { done: false, value: data[idx++] };
			} else {
				res.value = data[idx++];
			}
			return res;
		};
		return { next };
	}

	forEach(callback: (value: E, index: string) => any) {
		this._forEach(this._root, callback);
	}

	private _forEach(node: TernarySearchTreeNode<E> | undefined, callback: (value: E, index: string) => any) {
		if (node) {
			// left
			this._forEach(node.left, callback);

			// node
			if (node.value) {
				// callback(node.value, this._iter.join(parts));
				callback(node.value, node.key);
			}
			// mid
			this._forEach(node.mid, callback);

			// right
			this._forEach(node.right, callback);
		}
	}
}
