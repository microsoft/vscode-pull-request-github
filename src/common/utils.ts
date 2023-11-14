/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';
import { sep } from 'path';
import dayjs from 'dayjs';
import * as relativeTime from 'dayjs/plugin/relativeTime';
import * as updateLocale from 'dayjs/plugin/updateLocale';
import type { Disposable, Event, ExtensionContext, Uri } from 'vscode';
// TODO: localization for webview needed

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
	return (listener, thisArgs = null, disposables?: Disposable[]) =>
		event(e => filter(e) && listener.call(thisArgs, e), null, disposables);
}

export function onceEvent<T>(event: Event<T>): Event<T> {
	return (listener, thisArgs = null, disposables?: Disposable[]) => {
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

export class UnreachableCaseError extends Error {
	constructor(val: never) {
		super(`Unreachable case: ${val}`);
	}
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
		} else if (e.stderr) {
			return `${e.stderr}. Please check git output for more details`;
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
	} else if (e.message.startsWith('Validation Failed:')) {
		return e.message;
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

// Copied from https://github.com/microsoft/vscode/blob/cfd9d25826b5b5bc3b06677521660b4f1ba6639a/extensions/vscode-api-tests/src/utils.ts#L135-L136
export async function asPromise<T>(event: Event<T>): Promise<T> {
	return new Promise<T>((resolve) => {
		const sub = event(e => {
			sub.dispose();
			resolve(e);
		});
	});
}

export async function promiseWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	return Promise.race([promise, new Promise<undefined>(resolve => {
		setTimeout(() => resolve(undefined), ms);
	})]);
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


export function gitHubLabelColor(hexColor: string, isDark: boolean, markDown: boolean = false): { textColor: string, backgroundColor: string, borderColor: string } {
	if (hexColor.startsWith('#')) {
		hexColor = hexColor.substring(1);
	}
	const rgbColor = hexToRgb(hexColor);

	if (isDark) {
		const hslColor = rgbToHsl(rgbColor.r, rgbColor.g, rgbColor.b);

		const lightnessThreshold = 0.6;
		const backgroundAlpha = 0.18;
		const borderAlpha = 0.3;

		const perceivedLightness = (rgbColor.r * 0.2126 + rgbColor.g * 0.7152 + rgbColor.b * 0.0722) / 255;
		const lightnessSwitch = Math.max(0, Math.min((perceivedLightness - lightnessThreshold) * -1000, 1));

		const lightenBy = (lightnessThreshold - perceivedLightness) * 100 * lightnessSwitch;
		const rgbBorder = hexToRgb(hslToHex(hslColor.h, hslColor.s, hslColor.l + lightenBy));

		const textColor = `#${hslToHex(hslColor.h, hslColor.s, hslColor.l + lightenBy)}`;
		const backgroundColor = !markDown ?
			`rgba(${rgbColor.r},${rgbColor.g},${rgbColor.b},${backgroundAlpha})` :
			`#${rgbToHex({ ...rgbColor, a: backgroundAlpha })}`;
		const borderColor = !markDown ?
			`rgba(${rgbBorder.r},${rgbBorder.g},${rgbBorder.b},${borderAlpha})` :
			`#${rgbToHex({ ...rgbBorder, a: borderAlpha })}`;

		return { textColor: textColor, backgroundColor: backgroundColor, borderColor: borderColor };
	}
	else {
		return { textColor: `#${contrastColor(rgbColor)}`, backgroundColor: `#${hexColor}`, borderColor: `#${hexColor}` };
	}
}

const rgbToHex = (color: { r: number, g: number, b: number, a?: number }) => {
	const colors = [color.r, color.g, color.b];
	if (color.a) {
		colors.push(Math.floor(color.a * 255));
	}
	return colors.map((digit) => {
		return digit.toString(16).padStart(2, '0');
	}).join('');
};

function hexToRgb(color: string) {
	const result = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color);

	if (result) {
		return {
			r: parseInt(result[1], 16),
			g: parseInt(result[2], 16),
			b: parseInt(result[3], 16),
		};
	}
	return {
		r: 0,
		g: 0,
		b: 0,
	};
}

function rgbToHsl(r: number, g: number, b: number) {
	// Source: https://css-tricks.com/converting-color-spaces-in-javascript/
	// Make r, g, and b fractions of 1
	r /= 255;
	g /= 255;
	b /= 255;

	// Find greatest and smallest channel values
	let cmin = Math.min(r, g, b),
		cmax = Math.max(r, g, b),
		delta = cmax - cmin,
		h = 0,
		s = 0,
		l = 0;

	// Calculate hue
	// No difference
	if (delta == 0)
		h = 0;
	// Red is max
	else if (cmax == r)
		h = ((g - b) / delta) % 6;
	// Green is max
	else if (cmax == g)
		h = (b - r) / delta + 2;
	// Blue is max
	else
		h = (r - g) / delta + 4;

	h = Math.round(h * 60);

	// Make negative hues positive behind 360 deg
	if (h < 0)
		h += 360;

	// Calculate lightness
	l = (cmax + cmin) / 2;

	// Calculate saturation
	s = delta == 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));

	// Multiply l and s by 100
	s = +(s * 100).toFixed(1);
	l = +(l * 100).toFixed(1);

	return { h: h, s: s, l: l };
}

function hslToHex(h: number, s: number, l: number): string {
	// source https://www.jameslmilner.com/posts/converting-rgb-hex-hsl-colors/
	const hDecimal = l / 100;
	const a = (s * Math.min(hDecimal, 1 - hDecimal)) / 100;
	const f = (n: number) => {
		const k = (n + h / 30) % 12;
		const color = hDecimal - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);

		// Convert to Hex and prefix with "0" if required
		return Math.round(255 * color)
			.toString(16)
			.padStart(2, '0');
	};
	return `${f(0)}${f(8)}${f(4)}`;
}

function contrastColor(rgbColor: { r: number, g: number, b: number }) {
	// Color algorithm from https://stackoverflow.com/questions/1855884/determine-font-color-based-on-background-color
	const luminance = (0.299 * rgbColor.r + 0.587 * rgbColor.g + 0.114 * rgbColor.b) / 255;
	return luminance > 0.5 ? '000000' : 'ffffff';
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

	constructor(private readonly _caseSensitive: boolean = true) { }

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

	constructor(private readonly _splitOnBackslash: boolean = true, private readonly _caseSensitive: boolean = true) { }

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

	constructor(private readonly _ignorePathCasing: (uri: Uri) => boolean) { }

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

export function isPreRelease(context: ExtensionContext): boolean {
	const uri = context.extensionUri;
	const path = uri.path;
	const lastIndexOfDot = path.lastIndexOf('.');
	if (lastIndexOfDot === -1) {
		return false;
	}
	const patchVersion = path.substr(lastIndexOfDot + 1);
	// The patch version of release versions should never be more than 1 digit since it is only used for recovery releases.
	// The patch version of pre-release is the date + time.
	return patchVersion.length > 1;
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

export async function stringReplaceAsync(str: string, regex: RegExp, asyncFn: (substring: string, ...args: any[]) => Promise<string>): Promise<string> {
	const promises: Promise<string>[] = [];
	str.replace(regex, (match, ...args) => {
		const promise = asyncFn(match, ...args);
		promises.push(promise);
		return '';
	});
	const data = await Promise.all(promises);
	let offset = 0;
	return str.replace(regex, () => data[offset++]);
}
