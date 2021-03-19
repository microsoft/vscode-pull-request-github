/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';
import { sep } from 'path';
import dayjs from 'dayjs';
import * as relativeTime from 'dayjs/plugin/relativeTime';
import * as updateLocale from 'dayjs/plugin/updateLocale';
import { Disposable, Event, Uri } from 'vscode';

dayjs.extend(relativeTime.default, {
	thresholds: [
		{ l: 's', r: 44, d: 'second' },
		{ l: 'm', r: 89 },
		{ l: 'mm', r: 44, d: 'minute' },
		{ l: 'h', r: 89 },
		{ l: 'hh', r: 21, d: 'hour' },
		{ l: 'd', r: 35 },
		{ l: 'dd', r: 6, d: 'day' },
		{ l: 'w', r: 7 },
		{ l: 'ww', r: 3, d: 'week' },
		{ l: 'M', r: 4 },
		{ l: 'MM', r: 10, d: 'month' },
		{ l: 'y', r: 17 },
		{ l: 'yy', d: 'year' },
	],
});

dayjs.extend(updateLocale.default);
dayjs.updateLocale('en', {
	relativeTime: {
		future: 'in %s',
		past: '%s ago',
		s: 'seconds',
		m: 'a minute',
		mm: '%d minutes',
		h: 'an hour',
		hh: '%d hours',
		d: 'a day',
		dd: '%d days',
		w: 'a week',
		ww: '%d weeks',
		M: 'a month',
		MM: '%d months',
		y: 'a year',
		yy: '%d years',
	},
});

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
	return (listener, thisArgs = null, disposables?) =>
		event(e => filter(e) && listener.call(thisArgs, e), null, disposables);
}

export function onceEvent<T>(event: Event<T>): Event<T> {
	return (listener, thisArgs = null, disposables?) => {
		const result = event(
			e => {
				result.dispose();
				return listener.call(thisArgs, e);
			},
			null,
			disposables,
		);

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
	return !!(e as any).errors;
}

function hasFieldErrors(e: any): e is Error & { errors: { value: string; field: string; code: string }[] } {
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
			return `${e.message}. Please check git output for more details`;
		}
		return 'Error';
	}

	let errorMessage = e.message;
	let furtherInfo: string | undefined;
	if (e.message === 'Validation Failed' && hasFieldErrors(e)) {
		furtherInfo = e.errors
			.map(error => {
				return `Value "${error.value}" cannot be set for field ${error.field} (code: ${error.code})`;
			})
			.join(', ');
	} else if (isHookError(e) && e.errors) {
		return e.errors
			.map((error: any) => {
				if (typeof error === 'string') {
					return error;
				} else {
					return error.message;
				}
			})
			.join(', ');
	}
	if (furtherInfo) {
		errorMessage = `${errorMessage}: ${furtherInfo}`;
	}

	return errorMessage;
}

export interface PromiseAdapter<T, U> {
	(value: T, resolve: (value?: U | PromiseLike<U>) => void, reject: (reason: any) => void): any;
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
export async function promiseFromEvent<T, U>(event: Event<T>, adapter: PromiseAdapter<T, U> = passthrough): Promise<U> {
	let subscription: Disposable;
	return new Promise<U>(
		(resolve, reject) =>
			(subscription = event((value: T) => {
				try {
					Promise.resolve<U>(adapter(value, resolve as any, reject)).catch(reject);
				} catch (error) {
					reject(error);
				}
			})),
	).then(
		(result: U) => {
			subscription.dispose();
			return result;
		},
		error => {
			subscription.dispose();
			throw error;
		},
	);
}

export function dateFromNow(date: Date | string): string {
	const djs = dayjs(date);

	const now = Date.now();
	djs.diff(now, 'month');

	if (djs.diff(now, 'month') < 1) {
		return djs.fromNow();
	} else if (djs.diff(now, 'year') < 1) {
		return `on ${djs.format('MMM D')}`;
	}
	return `on ${djs.format('MMM D, YYYY')}`;
}

export interface Predicate<T> {
	(input: T): boolean;
}

export const enum CharCode {
	Period = 46,
	/**
	 * The `/` character.
	 */
	Slash = 47,

	A = 65,
	Z = 90,

	Backslash = 92,

	a = 97,
	z = 122,
}

export function compare(a: string, b: string): number {
	if (a < b) {
		return -1;
	} else if (a > b) {
		return 1;
	}
	return 0;
}

export function compareSubstring(
	a: string,
	b: string,
	aStart: number = 0,
	aEnd: number = a.length,
	bStart: number = 0,
	bEnd: number = b.length,
): number {
	for (; aStart < aEnd && bStart < bEnd; aStart++, bStart++) {
		const codeA = a.charCodeAt(aStart);
		const codeB = b.charCodeAt(bStart);
		if (codeA < codeB) {
			return -1;
		} else if (codeA > codeB) {
			return 1;
		}
	}
	const aLen = aEnd - aStart;
	const bLen = bEnd - bStart;
	if (aLen < bLen) {
		return -1;
	} else if (aLen > bLen) {
		return 1;
	}
	return 0;
}

export function compareIgnoreCase(a: string, b: string): number {
	return compareSubstringIgnoreCase(a, b, 0, a.length, 0, b.length);
}

export function compareSubstringIgnoreCase(
	a: string,
	b: string,
	aStart: number = 0,
	aEnd: number = a.length,
	bStart: number = 0,
	bEnd: number = b.length,
): number {
	for (; aStart < aEnd && bStart < bEnd; aStart++, bStart++) {
		let codeA = a.charCodeAt(aStart);
		let codeB = b.charCodeAt(bStart);

		if (codeA === codeB) {
			// equal
			continue;
		}

		const diff = codeA - codeB;
		if (diff === 32 && isUpperAsciiLetter(codeB)) {
			//codeB =[65-90] && codeA =[97-122]
			continue;
		} else if (diff === -32 && isUpperAsciiLetter(codeA)) {
			//codeB =[97-122] && codeA =[65-90]
			continue;
		}

		if (isLowerAsciiLetter(codeA) && isLowerAsciiLetter(codeB)) {
			//
			return diff;
		} else {
			return compareSubstring(a.toLowerCase(), b.toLowerCase(), aStart, aEnd, bStart, bEnd);
		}
	}

	const aLen = aEnd - aStart;
	const bLen = bEnd - bStart;

	if (aLen < bLen) {
		return -1;
	} else if (aLen > bLen) {
		return 1;
	}

	return 0;
}

export function isLowerAsciiLetter(code: number): boolean {
	return code >= CharCode.a && code <= CharCode.z;
}

export function isUpperAsciiLetter(code: number): boolean {
	return code >= CharCode.A && code <= CharCode.Z;
}

export interface IKeyIterator<K> {
	reset(key: K): this;
	next(): this;

	hasNext(): boolean;
	cmp(a: string): number;
	value(): string;
}

export class StringIterator implements IKeyIterator<string> {
	private _value: string = '';
	private _pos: number = 0;

	reset(key: string): this {
		this._value = key;
		this._pos = 0;
		return this;
	}

	next(): this {
		this._pos += 1;
		return this;
	}

	hasNext(): boolean {
		return this._pos < this._value.length - 1;
	}

	cmp(a: string): number {
		const aCode = a.charCodeAt(0);
		const thisCode = this._value.charCodeAt(this._pos);
		return aCode - thisCode;
	}

	value(): string {
		return this._value[this._pos];
	}
}

export class ConfigKeysIterator implements IKeyIterator<string> {
	private _value!: string;
	private _from!: number;
	private _to!: number;

	constructor(private readonly _caseSensitive: boolean = true) {}

	reset(key: string): this {
		this._value = key;
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
			if (ch === CharCode.Period) {
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
		return this._caseSensitive
			? compareSubstring(a, this._value, 0, a.length, this._from, this._to)
			: compareSubstringIgnoreCase(a, this._value, 0, a.length, this._from, this._to);
	}

	value(): string {
		return this._value.substring(this._from, this._to);
	}
}

export class PathIterator implements IKeyIterator<string> {
	private _value!: string;
	private _from!: number;
	private _to!: number;

	constructor(private readonly _splitOnBackslash: boolean = true, private readonly _caseSensitive: boolean = true) {}

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
			if (ch === CharCode.Slash || (this._splitOnBackslash && ch === CharCode.Backslash)) {
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
		return this._caseSensitive
			? compareSubstring(a, this._value, 0, a.length, this._from, this._to)
			: compareSubstringIgnoreCase(a, this._value, 0, a.length, this._from, this._to);
	}

	value(): string {
		return this._value.substring(this._from, this._to);
	}
}

const enum UriIteratorState {
	Scheme = 1,
	Authority = 2,
	Path = 3,
	Query = 4,
	Fragment = 5,
}

export class UriIterator implements IKeyIterator<Uri> {
	private _pathIterator!: PathIterator;
	private _value!: Uri;
	private _states: UriIteratorState[] = [];
	private _stateIdx: number = 0;

	constructor(private readonly _ignorePathCasing: (uri: Uri) => boolean) {}

	reset(key: Uri): this {
		this._value = key;
		this._states = [];
		if (this._value.scheme) {
			this._states.push(UriIteratorState.Scheme);
		}
		if (this._value.authority) {
			this._states.push(UriIteratorState.Authority);
		}
		if (this._value.path) {
			this._pathIterator = new PathIterator(false, !this._ignorePathCasing(key));
			this._pathIterator.reset(key.path);
			if (this._pathIterator.value()) {
				this._states.push(UriIteratorState.Path);
			}
		}
		if (this._value.query) {
			this._states.push(UriIteratorState.Query);
		}
		if (this._value.fragment) {
			this._states.push(UriIteratorState.Fragment);
		}
		this._stateIdx = 0;
		return this;
	}

	next(): this {
		if (this._states[this._stateIdx] === UriIteratorState.Path && this._pathIterator.hasNext()) {
			this._pathIterator.next();
		} else {
			this._stateIdx += 1;
		}
		return this;
	}

	hasNext(): boolean {
		return (
			(this._states[this._stateIdx] === UriIteratorState.Path && this._pathIterator.hasNext()) ||
			this._stateIdx < this._states.length - 1
		);
	}

	cmp(a: string): number {
		if (this._states[this._stateIdx] === UriIteratorState.Scheme) {
			return compareIgnoreCase(a, this._value.scheme);
		} else if (this._states[this._stateIdx] === UriIteratorState.Authority) {
			return compareIgnoreCase(a, this._value.authority);
		} else if (this._states[this._stateIdx] === UriIteratorState.Path) {
			return this._pathIterator.cmp(a);
		} else if (this._states[this._stateIdx] === UriIteratorState.Query) {
			return compare(a, this._value.query);
		} else if (this._states[this._stateIdx] === UriIteratorState.Fragment) {
			return compare(a, this._value.fragment);
		}
		throw new Error();
	}

	value(): string {
		if (this._states[this._stateIdx] === UriIteratorState.Scheme) {
			return this._value.scheme;
		} else if (this._states[this._stateIdx] === UriIteratorState.Authority) {
			return this._value.authority;
		} else if (this._states[this._stateIdx] === UriIteratorState.Path) {
			return this._pathIterator.value();
		} else if (this._states[this._stateIdx] === UriIteratorState.Query) {
			return this._value.query;
		} else if (this._states[this._stateIdx] === UriIteratorState.Fragment) {
			return this._value.fragment;
		}
		throw new Error();
	}
}

class TernarySearchTreeNode<K, V> {
	segment!: string;
	value: V | undefined;
	key!: K;
	left: TernarySearchTreeNode<K, V> | undefined;
	mid: TernarySearchTreeNode<K, V> | undefined;
	right: TernarySearchTreeNode<K, V> | undefined;

	isEmpty(): boolean {
		return !this.left && !this.mid && !this.right && !this.value;
	}
}

export class TernarySearchTree<K, V> {
	static forUris<E>(ignorePathCasing: (key: Uri) => boolean = () => false): TernarySearchTree<Uri, E> {
		return new TernarySearchTree<Uri, E>(new UriIterator(ignorePathCasing));
	}

	static forPaths<E>(): TernarySearchTree<string, E> {
		return new TernarySearchTree<string, E>(new PathIterator());
	}

	static forStrings<E>(): TernarySearchTree<string, E> {
		return new TernarySearchTree<string, E>(new StringIterator());
	}

	static forConfigKeys<E>(): TernarySearchTree<string, E> {
		return new TernarySearchTree<string, E>(new ConfigKeysIterator());
	}

	private _iter: IKeyIterator<K>;
	private _root: TernarySearchTreeNode<K, V> | undefined;

	constructor(segments: IKeyIterator<K>) {
		this._iter = segments;
	}

	clear(): void {
		this._root = undefined;
	}

	set(key: K, element: V): V | undefined {
		const iter = this._iter.reset(key);
		let node: TernarySearchTreeNode<K, V>;

		if (!this._root) {
			this._root = new TernarySearchTreeNode<K, V>();
			this._root.segment = iter.value();
		}

		node = this._root;
		while (true) {
			const val = iter.cmp(node.segment);
			if (val > 0) {
				// left
				if (!node.left) {
					node.left = new TernarySearchTreeNode<K, V>();
					node.left.segment = iter.value();
				}
				node = node.left;
			} else if (val < 0) {
				// right
				if (!node.right) {
					node.right = new TernarySearchTreeNode<K, V>();
					node.right.segment = iter.value();
				}
				node = node.right;
			} else if (iter.hasNext()) {
				// mid
				iter.next();
				if (!node.mid) {
					node.mid = new TernarySearchTreeNode<K, V>();
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

	get(key: K): V | undefined {
		return this._getNode(key)?.value;
	}

	private _getNode(key: K) {
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
		return node;
	}

	has(key: K): boolean {
		const node = this._getNode(key);
		return !(node?.value === undefined && node?.mid === undefined);
	}

	delete(key: K): void {
		return this._delete(key, false);
	}

	deleteSuperstr(key: K): void {
		return this._delete(key, true);
	}

	private _delete(key: K, superStr: boolean): void {
		const iter = this._iter.reset(key);
		const stack: [-1 | 0 | 1, TernarySearchTreeNode<K, V>][] = [];
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
				if (superStr) {
					// remove children
					node.left = undefined;
					node.mid = undefined;
					node.right = undefined;
				} else {
					// remove element
					node.value = undefined;
				}

				// clean up empty nodes
				while (stack.length > 0 && node.isEmpty()) {
					let [dir, parent] = stack.pop()!;
					switch (dir) {
						case 1:
							parent.left = undefined;
							break;
						case 0:
							parent.mid = undefined;
							break;
						case -1:
							parent.right = undefined;
							break;
					}
					node = parent;
				}
				break;
			}
		}
	}

	findSubstr(key: K): V | undefined {
		const iter = this._iter.reset(key);
		let node = this._root;
		let candidate: V | undefined = undefined;
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
		return (node && node.value) || candidate;
	}

	findSuperstr(key: K): IterableIterator<[K, V]> | undefined {
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
					return this._entries(node.mid);
				}
			}
		}
		return undefined;
	}

	forEach(callback: (value: V, index: K) => any): void {
		for (const [key, value] of this) {
			callback(value, key);
		}
	}

	*[Symbol.iterator](): IterableIterator<[K, V]> {
		yield* this._entries(this._root);
	}

	private *_entries(node: TernarySearchTreeNode<K, V> | undefined): IterableIterator<[K, V]> {
		if (node) {
			// left
			yield* this._entries(node.left);

			// node
			if (node.value) {
				// callback(node.value, this._iter.join(parts));
				yield [node.key, node.value];
			}
			// mid
			yield* this._entries(node.mid);

			// right
			yield* this._entries(node.right);
		}
	}
}

export function equals(one: any, other: any): boolean {
	if (one === other) {
		return true;
	}
	if (one === null || one === undefined || other === null || other === undefined) {
		return false;
	}
	if (typeof one !== typeof other) {
		return false;
	}
	if (typeof one !== 'object') {
		return false;
	}
	if ((Array.isArray(one)) !== (Array.isArray(other))) {
		return false;
	}

	let i: number;
	let key: string;

	if (Array.isArray(one)) {
		if (one.length !== other.length) {
			return false;
		}
		for (i = 0; i < one.length; i++) {
			if (!equals(one[i], other[i])) {
				return false;
			}
		}
	} else {
		const oneKeys: string[] = [];

		for (key in one) {
			oneKeys.push(key);
		}
		oneKeys.sort();
		const otherKeys: string[] = [];
		for (key in other) {
			otherKeys.push(key);
		}
		otherKeys.sort();
		if (!equals(oneKeys, otherKeys)) {
			return false;
		}
		for (i = 0; i < oneKeys.length; i++) {
			if (!equals(one[oneKeys[i]], other[oneKeys[i]])) {
				return false;
			}
		}
	}
	return true;
}