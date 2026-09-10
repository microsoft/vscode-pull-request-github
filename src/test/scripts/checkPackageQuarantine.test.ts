/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import childProcess from 'child_process';
import fs from 'fs';
import * as path from 'path';
import { createSandbox, SinonSandbox } from 'sinon';

interface PackageVersion {
	name: string;
	version: string;
	resolved?: string;
	integrity?: string;
}

interface QuarantineViolation extends PackageVersion {
	publishedAt: Date;
	eligibleAt: Date;
}

interface PackageQuarantine {
	extractPackageVersions(lockfile: object): PackageVersion[];
	findChangedPackageVersions(baseLockfile: object, currentLockfile: object): PackageVersion[];
	findQuarantineViolations(
		packageVersions: PackageVersion[],
		publicationDates: Map<string, Date>,
		now: Date,
		quarantineDays: number
	): QuarantineViolation[];
	getPublicationDates(packageVersions: PackageVersion[]): Promise<Map<string, Date>>;
	getPackageName(packagePath: string): string | undefined;
	parseArguments(args: string[]): { baseRef: string; quarantineDays: number };
	readBaseLockfile(workspaceRoot: string, baseRef: string): object;
	readCurrentLockfile(workspaceRoot: string): object;
	validateInstallationSources(manifest: object, lockfile: object): void;
	main(args: string[]): Promise<void>;
}

const quarantine: PackageQuarantine = require(
	path.resolve(__dirname, '../../../../scripts/check-package-quarantine.js')
);
const directoryReader: { readdirSync(directory: string): string[] } = fs;

function artifact(name: string, version: string, overrides: Partial<PackageVersion> = {}): PackageVersion {
	return {
		name,
		version,
		resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`,
		integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
		...overrides,
	};
}

function registryMetadata(packageVersion: PackageVersion, publishedAt = '2026-09-01T00:00:00Z') {
	return {
		versions: {
			[packageVersion.version]: {
				name: packageVersion.name,
				version: packageVersion.version,
				dist: { tarball: packageVersion.resolved, integrity: packageVersion.integrity },
			},
		},
		time: { [packageVersion.version]: publishedAt },
	};
}

describe('Package quarantine check', () => {
	let sandbox: SinonSandbox;

	beforeEach(() => {
		sandbox = createSandbox();
	});

	afterEach(() => {
		sandbox.restore();
	});

	function mockRegistry(metadata: object) {
		return sandbox.stub(globalThis, 'fetch').resolves(new Response(JSON.stringify(metadata)));
	}

	it('extracts package names from top-level, scoped, and nested paths', () => {
		const lockfile = {
			packages: {
				'': { version: '1.0.0' },
				'node_modules/alpha': artifact('alpha', '1.0.0'),
				'node_modules/@scope/bravo': artifact('@scope/bravo', '2.0.0'),
				'node_modules/alpha/node_modules/charlie': artifact('charlie', '3.0.0'),
			},
		};

		assert.deepStrictEqual(quarantine.extractPackageVersions(lockfile), [
			artifact('@scope/bravo', '2.0.0'),
			artifact('alpha', '1.0.0'),
			artifact('charlie', '3.0.0'),
		]);
	});

	it('finds new artifacts but exempts identical artifacts moved within the tree', () => {
		const baseLockfile = {
			packages: {
				'node_modules/alpha': artifact('alpha', '1.0.0'),
				'node_modules/bravo': artifact('bravo', '1.0.0'),
			},
		};
		const currentLockfile = {
			packages: {
				'node_modules/alpha': artifact('alpha', '2.0.0'),
				'node_modules/charlie/node_modules/bravo': artifact('bravo', '1.0.0'),
				'node_modules/delta': artifact('delta', '1.0.0'),
			},
		};

		assert.deepStrictEqual(quarantine.findChangedPackageVersions(baseLockfile, currentLockfile), [
			artifact('alpha', '2.0.0'),
			artifact('delta', '1.0.0'),
		]);
	});

	it('keeps unchanged legacy entries without resolution or integrity exempt', () => {
		const lockfile = { packages: { 'node_modules/alpha': { version: '1.0.0' } } };
		assert.deepStrictEqual(quarantine.findChangedPackageVersions(lockfile, lockfile), []);
	});

	for (const field of ['_resolved', '_integrity']) {
		it(`rejects npm's alternate ${field} field on an otherwise unchanged legacy entry`, () => {
			const original = { version: '1.0.0' };
			const replacement = {
				...original,
				[field]: field === '_resolved' ? 'https://example.invalid/replacement.tgz' : artifact('alpha', '1.0.0').integrity,
			};

			assert.throws(() => quarantine.findChangedPackageVersions(
				{ packages: { 'node_modules/alpha': original } },
				{ packages: { 'node_modules/alpha': replacement } }
			), /alternate _(?:resolved|integrity) field is not supported/);
		});
	}

	it('does not mistake node_modules inside a scope name for a directory boundary', async () => {
		const name = '@review-proof-node_modules/semver';
		const scoped = { version: '7.7.2' };
		const original = { packages: { 'node_modules/semver': scoped } };
		const changed = quarantine.findChangedPackageVersions(original, {
			packages: { ...original.packages, [`node_modules/${name}`]: scoped },
		});

		assert.strictEqual(quarantine.getPackageName(`node_modules/${name}`), name);
		assert.strictEqual(quarantine.getPackageName(`node_modules/parent/node_modules/${name}`), name);
		assert.strictEqual(changed.length, 1);
		assert.strictEqual(changed[0].name, name);
		await assert.rejects(quarantine.getPublicationDates(changed), /must have both resolved and integrity/);
	});

	for (const packagePath of [
		'node_modules/@scope',
		'node_modules/@scope/',
		'node_modules/@scope/package/extra',
		'node_modules/alpha//node_modules/bravo',
		'node_modules/../alpha',
		'something_node_modules/alpha',
	]) {
		it(`rejects noncanonical installation path ${packagePath}`, () => {
			assert.strictEqual(quarantine.getPackageName(packagePath), undefined);
			assert.throws(() => quarantine.extractPackageVersions({ packages: { [packagePath]: { version: '1.0.0' } } }), /Cannot verify/);
		});
	}

	it('does not let an alias borrow its installation name and version from the base', async () => {
		const existing = artifact('alpha', '1.0.0');
		const alias = artifact('@scope/new-package', '1.0.0');
		const baseLockfile = { packages: { 'node_modules/alpha': existing } };
		const currentLockfile = { packages: { 'node_modules/alpha': alias } };
		const fetch = mockRegistry(registryMetadata(alias, '2026-09-09T00:00:00Z'));

		const changed = quarantine.findChangedPackageVersions(baseLockfile, currentLockfile);
		assert.deepStrictEqual(changed, [alias]);
		const dates = await quarantine.getPublicationDates(changed);
		const violations = quarantine.findQuarantineViolations(changed, dates, new Date('2026-09-10T00:00:00Z'), 7);

		assert.strictEqual(violations.length, 1);
		assert.strictEqual(violations[0].name, '@scope/new-package');
		assert.strictEqual(fetch.callCount, 1);
		assert.strictEqual(fetch.firstCall.args[0], 'https://registry.npmjs.org/%40scope%2Fnew-package');
	});

	it('uses canonical identities for aliases in the base as well', () => {
		const alias = artifact('alpha', '1.0.0');
		const baseLockfile = { packages: { 'node_modules/alias': alias } };
		const currentLockfile = { packages: { 'node_modules/alpha': alias } };

		assert.deepStrictEqual(quarantine.findChangedPackageVersions(baseLockfile, currentLockfile), []);
	});

	it('validates a new alias even when its installation name is an old published package', async () => {
		const alias = artifact('new-package', '1.0.0');
		const changed = quarantine.findChangedPackageVersions(
			{ packages: {} },
			{ packages: { 'node_modules/alpha/node_modules/old-package': alias } }
		);
		const fetch = mockRegistry(registryMetadata(alias, '2026-09-09T00:00:00Z'));
		const dates = await quarantine.getPublicationDates(changed);

		assert.strictEqual(fetch.firstCall.args[0], 'https://registry.npmjs.org/new-package');
		assert.strictEqual(quarantine.findQuarantineViolations(changed, dates, new Date('2026-09-10T00:00:00Z'), 7).length, 1);
	});

	it('rejects a substituted tarball even if the package name and version are unchanged', async () => {
		const original = artifact('alpha', '1.0.0');
		const replacement = artifact('alpha', '1.0.0', {
			resolved: 'https://registry.npmjs.org/attacker/-/attacker-1.0.0.tgz',
			integrity: `sha512-${Buffer.alloc(64, 2).toString('base64')}`,
		});
		const changed = quarantine.findChangedPackageVersions(
			{ packages: { 'node_modules/alpha': original } },
			{ packages: { 'node_modules/alpha': replacement } }
		);
		assert.deepStrictEqual(changed, [replacement]);
		mockRegistry(registryMetadata(original));

		await assert.rejects(quarantine.getPublicationDates(changed), /tarball does not match/);
	});

	it('rejects an integrity-only substitution at an unchanged name and version', async () => {
		const original = artifact('alpha', '1.0.0');
		const replacement = { ...original, integrity: `sha512-${Buffer.alloc(64, 2).toString('base64')}` };
		const changed = quarantine.findChangedPackageVersions(
			{ packages: { 'node_modules/alpha': original } },
			{ packages: { 'node_modules/alpha': replacement } }
		);
		assert.deepStrictEqual(changed, [replacement]);
		mockRegistry(registryMetadata(original));

		await assert.rejects(quarantine.getPublicationDates(changed), /integrity does not match/);
	});

	for (const field of ['resolved', 'integrity'] as const) {
		it(`rejects removal of ${field} instead of exempting the unchanged version`, async () => {
			const original = artifact('alpha', '1.0.0');
			const replacement = { ...original, [field]: undefined };
			const changed = quarantine.findChangedPackageVersions(
				{ packages: { 'node_modules/alpha': original } },
				{ packages: { 'node_modules/alpha': replacement } }
			);
			const fetch = sandbox.stub(globalThis, 'fetch');
			assert.deepStrictEqual(changed, [replacement]);

			await assert.rejects(quarantine.getPublicationDates(changed), /must have both resolved and integrity/);
			assert.strictEqual(fetch.callCount, 0);
		});
	}

	it('does not deduplicate a substituted artifact against a genuine copy elsewhere', async () => {
		const original = artifact('alpha', '1.0.0');
		const replacement = { ...original, resolved: 'https://registry.npmjs.org/attacker/-/attacker-1.0.0.tgz' };
		const changed = quarantine.findChangedPackageVersions(
			{ packages: {} },
			{
				packages: {
					'node_modules/alpha': original,
					'node_modules/bravo/node_modules/alpha': replacement,
				},
			}
		);
		assert.strictEqual(changed.length, 2);
		mockRegistry(registryMetadata(original));

		await assert.rejects(quarantine.getPublicationDates(changed), /tarball does not match/);
	});

	for (const resolved of [
		'https://example.invalid/alpha.tgz',
		'http://registry.npmjs.org/alpha/-/alpha-1.0.0.tgz',
		'file:../alpha.tgz',
		'git+https://example.invalid/alpha.git',
	]) {
		it(`rejects unsupported artifact source ${resolved} without a registry lookup`, async () => {
			const fetch = sandbox.stub(globalThis, 'fetch');

			await assert.rejects(quarantine.getPublicationDates([artifact('alpha', '1.0.0', { resolved })]), /only tarballs from/);
			assert.strictEqual(fetch.callCount, 0);
		});
	}

	for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
		it(`rejects manifest-only tarball substitutions in ${field} with an unchanged pinned lockfile`, () => {
			const lockfile = { packages: { 'node_modules/alpha': artifact('alpha', '1.0.0') } };
			assert.deepStrictEqual(quarantine.findChangedPackageVersions(lockfile, lockfile), []);

			assert.throws(() => quarantine.validateInstallationSources(
				{ [field]: { alpha: 'https://example.invalid/replacement.tgz' } },
				lockfile
			), /must use a registry selector or npm alias/);
		});
	}

	it('validates manifest sources before the CLI can take the unchanged-lockfile shortcut', async () => {
		const lockfile = { lockfileVersion: 3, packages: { 'node_modules/alpha': artifact('alpha', '1.0.0') } };
		const manifest = { dependencies: { alpha: 'https://example.invalid/replacement.tgz' } };
		sandbox.stub(directoryReader, 'readdirSync').returns(['package.json', 'package-lock.json']);
		const readFile = sandbox.stub(fs, 'readFileSync');
		readFile.onFirstCall().returns(JSON.stringify(lockfile));
		readFile.onSecondCall().returns(JSON.stringify(manifest));
		const git = sandbox.stub(childProcess, 'execFileSync');
		const fetch = sandbox.stub(globalThis, 'fetch');

		await assert.rejects(quarantine.main([]), /must use a registry selector or npm alias/);
		assert.strictEqual(git.callCount, 0);
		assert.strictEqual(fetch.callCount, 0);
	});

	for (const spec of [
		'https://registry.npmjs.org/attacker/-/attacker-1.0.0.tgz',
		'git+https://example.invalid/alpha.git',
		'owner/repository',
		'github:owner/repository',
		'file:../alpha',
		'../alpha',
		'replacement.tgz',
		'replacement.tar.gz',
		'npm:alpha@https://example.invalid/replacement.tgz',
	]) {
		it(`rejects dependency source ${spec} even inside lockfile dependency edges`, () => {
			assert.throws(() => quarantine.validateInstallationSources({}, {
				packages: { 'node_modules/parent': { ...artifact('parent', '1.0.0'), dependencies: { alpha: spec } } },
			}), /must use a registry selector or npm alias/);
		});
	}

	it('rejects a manifest alias whose locked package has a different canonical name', () => {
		assert.throws(() => quarantine.validateInstallationSources(
			{ dependencies: { alpha: 'npm:new-package@1.0.0' } },
			{ packages: { 'node_modules/alpha': artifact('alpha', '1.0.0') } }
		), /dependency source does not match its locked package identity/);
	});

	it('accepts registry selectors and aliases matching the installed canonical identities', () => {
		const manifest = {
			dependencies: { alpha: '^1.0.0', alias: 'npm:@scope/bravo@~2.0.0' },
			overrides: { alpha: { '.': '$alpha', charlie: '>=1 <2 || ^3' } },
		};
		const lockfile = {
			packages: {
				'node_modules/alpha': { ...artifact('alpha', '1.0.0'), dependencies: { charlie: '*' } },
				'node_modules/alias': artifact('@scope/bravo', '2.0.0'),
				'node_modules/charlie': artifact('charlie', '1.0.0'),
			},
		};

		assert.doesNotThrow(() => quarantine.validateInstallationSources(manifest, lockfile));
	});

	for (const overrides of [
		{ alpha: 'https://example.invalid/replacement.tgz' },
		{ parent: { alpha: { '.': 'https://example.invalid/replacement.tgz' } } },
		{ alpha: 'npm:new-package@1.0.0' },
		{ alpha: '$alias' },
		{ 'alpha@https://example.invalid/replacement.tgz': {} },
		{ parent: { 'alpha@file:../alpha': {} } },
		{ 'alpha@git+https://example.invalid/alpha.git': {} },
		{ 'alpha@npm:new-package@1.0.0': {} },
		{ '@scope/alpha@https://example.invalid/replacement.tgz': { '.': '1.0.0' } },
	]) {
		it(`rejects source-changing overrides ${JSON.stringify(overrides)}`, () => {
			assert.throws(() => quarantine.validateInstallationSources(
				{ dependencies: { alias: 'npm:new-package@1.0.0' }, overrides },
				{ packages: {} }
			), /Cannot verify/);
		});
	}

	it('rejects an implicit override-key replacement combined with a tag in a transitive edge', () => {
		const base = {
			packages: {
				'node_modules/markdown-it': { version: '14.1.0', dependencies: { mdurl: '^2.0.0' } },
				'node_modules/mdurl': { version: '2.0.0' },
			},
		};
		const current = {
			packages: {
				...base.packages,
				'node_modules/markdown-it': { version: '14.1.0', dependencies: { mdurl: 'latest' } },
			},
		};
		const manifest = { overrides: { 'mdurl@https://example.invalid/replacement.tgz': {} } };
		assert.deepStrictEqual(quarantine.findChangedPackageVersions(base, current), []);

		assert.throws(() => quarantine.validateInstallationSources(manifest, current), /override key.*must use a registry selector/);
	});

	it('accepts scoped and nested overrides with registry-only key selectors', () => {
		assert.doesNotThrow(() => quarantine.validateInstallationSources(
			{ overrides: { '@scope/alpha@^1.0.0': { '.': '1.0.1', 'bravo@>=1 <3': {} } } },
			{ packages: {} }
		));
	});

	it('rejects workspaces whose manifests are outside the root lockfile check', () => {
		assert.throws(() => quarantine.validateInstallationSources(
			{ workspaces: ['packages/*'] },
			{ packages: {} }
		), /without workspaces/);
	});

	it('verifies the registry record identity as well as the URL and integrity', async () => {
		const packageVersion = artifact('alpha', '1.0.0');
		const metadata = registryMetadata(packageVersion);
		metadata.versions['1.0.0'].name = 'different-package';
		mockRegistry(metadata);

		await assert.rejects(quarantine.getPublicationDates([packageVersion]), /identity or tarball does not match/);
	});

	it('accepts matching registry artifacts after seven days', async () => {
		const packageVersion = artifact('alpha', '1.0.0');
		const fetch = mockRegistry(registryMetadata(packageVersion));
		const dates = await quarantine.getPublicationDates([packageVersion]);

		assert.deepStrictEqual(quarantine.findQuarantineViolations([packageVersion], dates, new Date('2026-09-08T00:00:00Z'), 7), []);
		assert.strictEqual(fetch.firstCall.args[1]?.redirect, 'error');
	});

	it('supports legacy SHA-1 integrity but not mixed integrity containing an attacker hash', async () => {
		const packageVersion = artifact('alpha', '1.0.0');
		const shasum = '01'.repeat(20);
		const sha1 = `sha1-${Buffer.from(shasum, 'hex').toString('base64')}`;
		const metadata = registryMetadata(packageVersion);
		const response = {
			...metadata,
			versions: { '1.0.0': { ...metadata.versions['1.0.0'], dist: { ...metadata.versions['1.0.0'].dist, shasum } } },
		};
		const fetch = mockRegistry(response);
		const dates = await quarantine.getPublicationDates([{ ...packageVersion, integrity: sha1 }]);
		assert.strictEqual(dates.size, 1);
		fetch.resolves(new Response(JSON.stringify(response)));

		await assert.rejects(
			quarantine.getPublicationDates([{ ...packageVersion, integrity: `${sha1} sha512-${Buffer.alloc(64, 2).toString('base64')}` }]),
			/integrity does not match/
		);
	});

	it('fails closed if publication data is missing', async () => {
		const packageVersion = artifact('alpha', '1.0.0');
		mockRegistry({ ...registryMetadata(packageVersion), time: {} });

		await assert.rejects(quarantine.getPublicationDates([packageVersion]), /valid publication time/);
	});

	it('fails closed when the registry cannot find the package', async () => {
		sandbox.stub(globalThis, 'fetch').resolves(new Response('', { status: 404 }));

		await assert.rejects(quarantine.getPublicationDates([artifact('alpha', '1.0.0')]), /HTTP 404/);
	});

	for (const metadata of [
		{ version: '1.0.0', link: true, resolved: '../local-package' },
		{ version: '1.0.0', inBundle: true },
		{ version: 'git+https://example.invalid/alpha.git' },
		{ name: '../alpha', version: '1.0.0' },
		{},
	]) {
		it(`rejects uncheckable package metadata ${JSON.stringify(metadata)}`, () => {
			assert.throws(() => quarantine.extractPackageVersions({ packages: { 'node_modules/alpha': metadata } }), /Cannot verify/);
		});
	}

	for (const fileName of ['npm-shrinkwrap.json', 'NPM-SHRINKWRAP.JSON']) {
		it(`rejects ${fileName} before reading the otherwise unchanged package lock`, () => {
			sandbox.stub(directoryReader, 'readdirSync').returns([fileName, 'package-lock.json']);
			const readFile = sandbox.stub(fs, 'readFileSync');

			assert.throws(() => quarantine.readCurrentLockfile('workspace'), /npm-shrinkwrap.json takes precedence/);
			assert.strictEqual(readFile.callCount, 0);
		});
	}

	it('rejects a shrinkwrap in the base rather than trusting an unused package lock', () => {
		const git = sandbox.stub(childProcess, 'execFileSync').returns('npm-shrinkwrap.json\n');

		assert.throws(() => quarantine.readBaseLockfile('workspace', 'HEAD^1'), /npm-shrinkwrap.json at HEAD\^1 takes precedence/);
		assert.strictEqual(git.callCount, 1);
	});

	it('reads the package lock when there is no overriding shrinkwrap', () => {
		const lockfile = { lockfileVersion: 3, packages: { 'node_modules/alpha': artifact('alpha', '1.0.0') } };
		sandbox.stub(directoryReader, 'readdirSync').returns(['package-lock.json']);
		sandbox.stub(fs, 'readFileSync').returns(JSON.stringify(lockfile));

		assert.deepStrictEqual(quarantine.readCurrentLockfile('workspace'), lockfile);
	});

	for (const lockfile of [null, { packages: [] }, { lockfileVersion: 1, dependencies: {} }]) {
		it(`rejects unsupported lockfile structure ${JSON.stringify(lockfile)}`, () => {
			sandbox.stub(directoryReader, 'readdirSync').returns(['package-lock.json']);
			sandbox.stub(fs, 'readFileSync').returns(JSON.stringify(lockfile));

			assert.throws(() => quarantine.readCurrentLockfile('workspace'), /must be a version 2 or 3 lockfile/);
		});
	}

	it('rejects versions until the full quarantine period has elapsed', () => {
		const packageVersions = [
			{ name: 'alpha', version: '1.0.0' },
			{ name: 'bravo', version: '2.0.0' },
		];
		const publicationDates = new Map([
			[JSON.stringify(['alpha', '1.0.0']), new Date('2026-09-02T12:00:00Z')],
			[JSON.stringify(['bravo', '2.0.0']), new Date('2026-09-02T11:59:59Z')],
		]);

		const violations = quarantine.findQuarantineViolations(
			packageVersions,
			publicationDates,
			new Date('2026-09-09T11:59:59Z'),
			7
		);

		assert.deepStrictEqual(violations.map(({ name, version }) => ({ name, version })), [
			{ name: 'alpha', version: '1.0.0' },
		]);
	});

	it('uses a seven-day quarantine and the first parent by default', () => {
		assert.deepStrictEqual(quarantine.parseArguments([]), {
			baseRef: 'HEAD^1',
			quarantineDays: 7,
		});
	});
});
