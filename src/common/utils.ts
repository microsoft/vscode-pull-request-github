/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';
import { Event, Disposable } from 'vscode';
import { sep } from 'path';
import moment = require('moment');

export function uniqBy<T>(arr: T[], fn: (el: T) => string): T[] {
	const seen = Object.create(null);

	return arr.filter(el => {
		const key = fn(el);

		if (seen[key]) {
			return false;
		}

		seen[key] = true;
		return true;
	});
}

export function dispose<T extends Disposable>(disposables: T[]): T[] {
	disposables.forEach(d => d.dispose());
	return [];
}

export function toDisposable(d: () => void): Disposable {
	return { dispose: d };
}

export function combinedDisposable(disposables: Disposable[]): Disposable {
	return toDisposable(() => dispose(disposables));
}

export function anyEvent<T>(...events: Event<T>[]): Event<T> {
	return (listener, thisArgs = null, disposables?) => {
		const result = combinedDisposable(events.map(event => event(i => listener.call(thisArgs, i))));

		if (disposables) {
			disposables.push(result);
		}

		return result;
	};
}

export function filterEvent<T>(event: Event<T>, filter: (e: T) => boolean): Event<T> {
	return (listener, thisArgs = null, disposables?) => event(e => filter(e) && listener.call(thisArgs, e), null, disposables);
}

export function onceEvent<T>(event: Event<T>): Event<T> {
	return (listener, thisArgs = null, disposables?) => {
		const result = event(e => {
			result.dispose();
			return listener.call(thisArgs, e);
		}, null, disposables);

		return result;
	};
}

function isWindowsPath(path: string): boolean {
	return /^[a-zA-Z]:\\/.test(path);
}

export function isDescendant(parent: string, descendant: string): boolean {
	if (parent === descendant) {
		return true;
	}

	if (parent.charAt(parent.length - 1) !== sep) {
		parent += sep;
	}

	// Windows is case insensitive
	if (isWindowsPath(parent)) {
		parent = parent.toLowerCase();
		descendant = descendant.toLowerCase();
	}

	return descendant.startsWith(parent);
}

export function groupBy<T>(arr: T[], fn: (el: T) => string): { [key: string]: T[] } {
	return arr.reduce((result, el) => {
		const key = fn(el);
		result[key] = [...(result[key] || []), el];
		return result;
	}, Object.create(null));
}

interface HookError extends Error {
	errors: any;
}

function isHookError(e: Error): e is HookError {
	return !!(<any>e).errors;
}

function hasFieldErrors(e: any): e is (Error & { errors: { value: string, field: string, code: string }[] }) {
	let areFieldErrors = true;
	if (!!e.errors && Array.isArray(e.errors)) {
		for (const error of e.errors) {
			if (!error.field || !error.value || !error.code) {
				areFieldErrors = false;
				break;
			}
		}
	} else {
		areFieldErrors = false;
	}
	return areFieldErrors;
}

export function formatError(e: HookError | any): string {
	if (!(e instanceof Error)) {
		if (typeof e === 'string') {
			return e;
		}

		if (e.gitErrorCode) {
			// known git errors, we should display detailed git error messages.
			return e.message + '. Please check git output for more details';
		}
		return 'Error';
	}

	let errorMessage = e.message;
	let furtherInfo: string | undefined;
	if (e.message === 'Validation Failed' && hasFieldErrors(e)) {
		furtherInfo = e.errors.map(error => {
			return `Value "${error.value}" cannot be set for field ${error.field} (code: ${error.code})`;
		}).join(', ');
	} else if (isHookError(e) && e.errors) {
		return e.errors.map((error: any) => {
			if (typeof error === 'string') {
				return error;
			} else {
				return error.message;
			}
		}).join(', ');
	}
	if (furtherInfo) {
		errorMessage = `${errorMessage}: ${furtherInfo}`;
	}

	return errorMessage;
}

export interface PromiseAdapter<T, U> {
	(
		value: T,
		resolve:
			(value?: U | PromiseLike<U>) => void,
		reject:
			(reason: any) => void
	): any;
}

const passthrough = (value: any, resolve: (value?: any) => void) => resolve(value);

/**
 * Return a promise that resolves with the next emitted event, or with some future
 * event as decided by an adapter.
 *
 * If specified, the adapter is a function that will be called with
 * `(event, resolve, reject)`. It will be called once per event until it resolves or
 * rejects.
 *
 * The default adapter is the passthrough function `(value, resolve) => resolve(value)`.
 *
 * @param {Event<T>} event the event
 * @param {PromiseAdapter<T, U>?} adapter controls resolution of the returned promise
 * @returns {Promise<U>} a promise that resolves or rejects as specified by the adapter
 */
export async function promiseFromEvent<T, U>(
	event: Event<T>,
	adapter: PromiseAdapter<T, U> = passthrough): Promise<U> {
	let subscription: Disposable;
	return new Promise<U>((resolve, reject) =>
		subscription = event((value: T) => {
			try {
				Promise.resolve(adapter(value, resolve, reject))
					.catch(reject);
			} catch (error) {
				reject(error);
			}
		})
	).then(
		(result: U) => {
			subscription.dispose();
			return result;
		},
		error => {
			subscription.dispose();
			throw error;
		}
	);
}

export function dateFromNow(date: Date | string): string {
	const duration = moment.duration(moment().diff(date));

	if (duration.asMonths() < 1) {
		return moment(date).fromNow();
	} else if (duration.asYears() < 1) {
		return 'on ' + moment(date).format('MMM D');
	} else {
		return 'on ' + moment(date).format('MMM D, YYYY');
	}
}
export interface Predicate<T> {
	(input: T): boolean;
}

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
					const [dir, parent] = stack.pop()!;
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
