/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * An in-memory, read-only text document with `\n` line endings. Unlike documents from
 * `vscode.workspace.openTextDocument`, it isn't known to VS Code, so editor services
 * (such as `vscode.languages.getTokenInformationAtPosition`) must be stubbed when used with it.
 */
export class MockTextDocument implements vscode.TextDocument {
	readonly uri: vscode.Uri;
	readonly fileName: string;
	readonly isUntitled = true;
	readonly encoding = 'utf8';
	readonly version = 1;
	readonly isDirty = false;
	readonly isClosed = false;
	readonly eol = vscode.EndOfLine.LF;
	private readonly _lines: string[];

	constructor(readonly languageId: string, private readonly _content: string) {
		this._lines = _content.split('\n');
		this.uri = vscode.Uri.from({ scheme: 'untitled', path: `mock.${languageId}` });
		this.fileName = this.uri.path;
	}

	get lineCount(): number {
		return this._lines.length;
	}

	async save(): Promise<boolean> {
		return false;
	}

	lineAt(lineOrPosition: number | vscode.Position): vscode.TextLine {
		const lineNumber = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line;
		if (lineNumber < 0 || lineNumber >= this._lines.length) {
			throw new Error(`Illegal line number ${lineNumber}`);
		}
		const text = this._lines[lineNumber];
		const firstNonWhitespace = text.search(/\S/);
		const firstNonWhitespaceCharacterIndex = firstNonWhitespace === -1 ? text.length : firstNonWhitespace;
		const isLastLine = lineNumber === this._lines.length - 1;
		return {
			lineNumber,
			text,
			range: new vscode.Range(lineNumber, 0, lineNumber, text.length),
			rangeIncludingLineBreak: isLastLine ? new vscode.Range(lineNumber, 0, lineNumber, text.length) : new vscode.Range(lineNumber, 0, lineNumber + 1, 0),
			firstNonWhitespaceCharacterIndex,
			isEmptyOrWhitespace: firstNonWhitespaceCharacterIndex === text.length,
		};
	}

	offsetAt(position: vscode.Position): number {
		const { line, character } = this.validatePosition(position);
		let offset = 0;
		for (let i = 0; i < line; i++) {
			offset += this._lines[i].length + 1;
		}
		return offset + character;
	}

	positionAt(offset: number): vscode.Position {
		let remaining = Math.max(0, Math.min(offset, this._content.length));
		for (let line = 0; line < this._lines.length; line++) {
			if (remaining <= this._lines[line].length) {
				return new vscode.Position(line, remaining);
			}
			remaining -= this._lines[line].length + 1;
		}
		const lastLine = this._lines.length - 1;
		return new vscode.Position(lastLine, this._lines[lastLine].length);
	}

	getText(range?: vscode.Range): string {
		if (!range) {
			return this._content;
		}
		const validRange = this.validateRange(range);
		return this._content.substring(this.offsetAt(validRange.start), this.offsetAt(validRange.end));
	}

	getWordRangeAtPosition(position: vscode.Position, regex: RegExp = /\w+/g): vscode.Range | undefined {
		const { line, character } = this.validatePosition(position);
		const text = this._lines[line];
		const globalRegex = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
		let match: RegExpExecArray | null;
		while ((match = globalRegex.exec(text))) {
			const start = match.index;
			const end = start + match[0].length;
			if (start <= character && character <= end) {
				return new vscode.Range(line, start, line, end);
			}
			if (match[0].length === 0) {
				globalRegex.lastIndex++;
			}
		}
		return undefined;
	}

	validateRange(range: vscode.Range): vscode.Range {
		return new vscode.Range(this.validatePosition(range.start), this.validatePosition(range.end));
	}

	validatePosition(position: vscode.Position): vscode.Position {
		if (position.line < 0) {
			return new vscode.Position(0, 0);
		}
		if (position.line >= this._lines.length) {
			const lastLine = this._lines.length - 1;
			return new vscode.Position(lastLine, this._lines[lastLine].length);
		}
		const character = Math.max(0, Math.min(position.character, this._lines[position.line].length));
		return new vscode.Position(position.line, character);
	}
}
