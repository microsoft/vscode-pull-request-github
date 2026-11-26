/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as yaml from 'js-yaml';
import { getIssueTemplateData } from '../../issues/issueTemplate';

const R = String.raw;

/** The title the extension reads from a Markdown template whose frontmatter sets `title:` to the given value. */
function templateTitle(frontmatterValue: string): string | undefined {
	return getIssueTemplateData(`---\nname: Template\ntitle: ${frontmatterValue}\n---\n\nBody\n`).title;
}

/** The parsed title, asserted to be present. */
function decodedTitle(frontmatterValue: string): string {
	const title = templateTitle(frontmatterValue);
	assert.ok(title !== undefined, `no title parsed from ${frontmatterValue}`);
	return title;
}

/** What GitHub gets: a frontmatter value is a plain YAML scalar. */
function yamlTitle(frontmatterValue: string): string | undefined {
	try {
		return ((yaml.load(`title: ${frontmatterValue}`) as { title?: string | null } | undefined)?.title) ?? undefined;
	} catch {
		return undefined;
	}
}

function hex(value: number, width: number): string {
	return value.toString(16).toUpperCase().padStart(width, '0');
}

/** The escape syntaxes of a YAML double-quoted scalar. */
const escape = {
	/** `\U` takes eight hex digits and reaches every code point. */
	U: (codePoint: number): string => `\\U${hex(codePoint, 8)}`,
	/** `\u` takes four hex digits and stays in the BMP. */
	u: (codePoint: number): string => `\\u${hex(codePoint, 4)}`,
	/** `\x` takes two hex digits and stays in Latin-1. */
	x: (codePoint: number): string => `\\x${hex(codePoint, 2)}`,
	/** A surrogate pair written as two `\u` escapes, for code points above the BMP. */
	surrogatePair: (codePoint: number): string => {
		const character = String.fromCodePoint(codePoint);
		let pair = '';
		for (let index = 0; index < character.length; index++) {
			pair += escape.u(character.charCodeAt(index));
		}
		return pair;
	},
	/** Escapes only apply inside the quotes of a scalar, so payloads are quoted. */
	quoted: (value: string): string => `"${value}"`,
};

/** One code point sampled at the edge of each range the escape syntaxes can address. */
const SAMPLES = [
	0x00, // first ASCII
	0x7f, // last ASCII
	0x80, // first Latin-1
	0xff, // last Latin-1
	0x100, // first code point above Latin-1
	0xd7ff, // last code point before the surrogate range
	0xe000, // first code point after the surrogate range
	0xfffd, // last assigned code point of the BMP
	0x10000, // first astral code point
	0x10fffd, // last code point of the last assigned astral plane
];

const BMP = SAMPLES.filter(codePoint => codePoint <= 0xffff);
const LATIN1 = SAMPLES.filter(codePoint => codePoint <= 0xff);
const ASTRAL = SAMPLES.filter(codePoint => codePoint > 0xffff);

/** An escape that was passed through undecoded. */
const ESCAPED_CODE_POINT = /\\[Uux][0-9a-fA-F]/;

/** Asserts that the payload denotes the code point, and that the parsed title decodes it to that character. */
function assertDecodes(actual: string | undefined, payload: string, codePoint: number): void {
	const expected = String.fromCodePoint(codePoint);
	assert.strictEqual(yamlTitle(payload), expected, `payload ${payload} must denote U+${hex(codePoint, 4)}`);
	assert.strictEqual(actual, expected, `frontmatter value ${payload}`);
	assert.ok(!ESCAPED_CODE_POINT.test(actual ?? ''), `escape left undecoded in ${JSON.stringify(actual)}`);
}

describe('Issue template frontmatter', function () {
	it('decodes \\U escapes for code points from every plane', function () {
		for (const codePoint of SAMPLES) {
			const payload = escape.quoted(escape.U(codePoint));
			assertDecodes(templateTitle(payload), payload, codePoint);
		}
	});

	it('decodes \\u escapes for BMP code points', function () {
		for (const codePoint of BMP) {
			const payload = escape.quoted(escape.u(codePoint));
			assertDecodes(templateTitle(payload), payload, codePoint);
		}
	});

	it('decodes \\x escapes for Latin-1 code points', function () {
		for (const codePoint of LATIN1) {
			const payload = escape.quoted(escape.x(codePoint));
			assertDecodes(templateTitle(payload), payload, codePoint);
		}
	});

	it('decodes surrogate pairs for astral code points', function () {
		for (const codePoint of ASTRAL) {
			const payload = escape.quoted(escape.surrogatePair(codePoint));
			assertDecodes(templateTitle(payload), payload, codePoint);
			assert.strictEqual(
				templateTitle(payload),
				templateTitle(escape.quoted(escape.U(codePoint))),
				`both escape syntaxes for U+${hex(codePoint, 4)} denote the same character`,
			);
		}
	});

	it('agrees with the JavaScript string escapes', function () {
		for (const codePoint of SAMPLES) {
			const payload = escape.quoted(escape.U(codePoint));
			const fromJavaScript = JSON.parse(escape.quoted(escape.surrogatePair(codePoint)));
			assert.strictEqual(templateTitle(payload), fromJavaScript, `U+${hex(codePoint, 4)}`);
		}
	});

	it('decodes the escapes for characters that are not code points', function () {
		assert.deepStrictEqual(decodedTitle(R`"a\nb"`).split('\n'), ['a', 'b']);
		assert.deepStrictEqual(decodedTitle(R`"a\tb"`).split('\t'), ['a', 'b']);
		assert.strictEqual(templateTitle(R`"a\"b"`), 'a"b');
		assert.strictEqual(templateTitle(R`"C:\\temp"`), 'C:\\temp');
		assert.strictEqual(templateTitle(R`"a\/b"`), 'a/b');
		assert.strictEqual(templateTitle(R`"a\ b"`), 'a b');
	});

	it('decodes the YAML line break and space escapes into non-ASCII BMP characters', function () {
		// \N is a next-line control, \_ a no-break space, \L a line separator, \P a paragraph separator.
		const characters = [...decodedTitle(R`"a\Nb\_c\Ld\Pe"`)];

		assert.strictEqual(characters.length, 9);
		for (const index of [1, 3, 5, 7]) {
			const codePoint = characters[index].codePointAt(0);
			assert.ok(codePoint !== undefined);
			assert.ok(codePoint > 0x7f && codePoint <= 0xffff);
		}
	});

	it('decodes escapes in the name and about fields', function () {
		const template = getIssueTemplateData(
			`---\nname: "Bug ${escape.U(ASTRAL[0])}"\nabout: "${escape.u(BMP[0])}"\n---\n`,
		);

		assert.strictEqual(template.name, `Bug ${String.fromCodePoint(ASTRAL[0])}`);
		assert.strictEqual(template.about, String.fromCodePoint(BMP[0]));
	});

	it('does not keep quotes, comments or trailing whitespace', function () {
		assert.strictEqual(templateTitle('"a b" '), 'a b');
		assert.strictEqual(templateTitle('"a b" # note'), 'a b');
		assert.strictEqual(templateTitle("'it''s'"), "it's");
		assert.strictEqual(templateTitle("what's this'"), "what's this'");
	});

	it('leaves an empty title undefined', function () {
		assert.strictEqual(getIssueTemplateData('---\nname: Template\ntitle:\n---\n').title, undefined);
	});

	it('keeps the entire body, including rules made of dashes', function () {
		const template = getIssueTemplateData('---\ntitle: t\n---\nintro\n\n---\n\noutro\n');

		assert.strictEqual(template.body, 'intro\n\n---\n\noutro\n');
	});

	it('handles CRLF line endings', function () {
		const character = String.fromCodePoint(ASTRAL[0]);
		const template = getIssueTemplateData(
			`---\r\nname: "Bug ${escape.U(ASTRAL[0])}"\r\ntitle: "${escape.U(ASTRAL[0])}[BUG]"\r\n---\r\n\r\nBody\r\n`,
		);

		assert.strictEqual(template.name, `Bug ${character}`);
		assert.strictEqual(template.title, `${character}[BUG]`);
		assert.strictEqual(template.body, '\r\nBody\r\n');
	});

	it('does not throw for invalid frontmatter', function () {
		assert.doesNotThrow(() => getIssueTemplateData('---\ntitle: "\\u{1F41B}"\n---\n'));
	});

	it('decodes labels and assignees', function () {
		const character = String.fromCodePoint(ASTRAL[0]);
		const template = getIssueTemplateData(
			`---\nname: Template\ntitle: t\nlabels: "bug, ${escape.U(ASTRAL[0])}"\nassignees:\n  - alice\n  - bob\n---\n`,
		);

		assert.deepStrictEqual(template.labels, ['bug', character]);
		assert.deepStrictEqual(template.assignees, ['alice', 'bob']);
	});

	it('keeps converting YAML issue forms', function () {
		const form = [
			'name: Bug report',
			'description: Something is broken',
			'title: "[Bug] "',
			'body:',
			'  - type: markdown',
			'    attributes:',
			'      value: Thanks for reporting',
			'  - type: input',
			'    attributes:',
			'      label: Version',
			'  - type: dropdown',
			'    attributes:',
			'      label: Operating system',
			'      options:',
			'        - Windows',
			'        - Linux',
			'  - type: checkboxes',
			'    attributes:',
			'      label: Checklist',
			'      options:',
			'        - label: I searched existing issues',
			'',
		].join('\n');

		const template = getIssueTemplateData(form);

		assert.strictEqual(template.name, 'Bug report');
		assert.strictEqual(template.about, 'Something is broken');
		assert.strictEqual(template.title, '[Bug] ');
		assert.strictEqual(template.body, [
			'Thanks for reporting',
			'',
			'## Version',
			'',
			'## Operating system',
			'',
			'- Windows',
			'- Linux',
			'',
			'## Checklist',
			'',
			'- [ ] I searched existing issues',
		].join('\n'));
	});
});
