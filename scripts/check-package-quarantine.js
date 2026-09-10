/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_BASE_REF = 'HEAD^1';
const DEFAULT_QUARANTINE_DAYS = 7;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const REGISTRY_URL = 'https://registry.npmjs.org';
const REQUEST_ATTEMPTS = 3;
const REQUEST_CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 30_000;

function parseArguments(args) {
	const options = {
		baseRef: DEFAULT_BASE_REF,
		quarantineDays: DEFAULT_QUARANTINE_DAYS,
	};

	for (let index = 0; index < args.length; index++) {
		switch (args[index]) {
			case '--base-ref':
				options.baseRef = args[++index];
				if (!options.baseRef) {
					throw new Error('Missing value for --base-ref.');
				}
				break;
			case '--days': {
				const value = args[++index];
				options.quarantineDays = Number(value);
				if (!Number.isInteger(options.quarantineDays) || options.quarantineDays < 0) {
					throw new Error(`Invalid value for --days: ${value}. Expected a non-negative integer.`);
				}
				break;
			}
			default:
				throw new Error(`Unknown argument: ${args[index]}`);
		}
	}

	return options;
}

function parseLockfile(contents, source) {
	let lockfile;
	try {
		lockfile = JSON.parse(contents);
	} catch (error) {
		throw new Error(`Failed to parse ${source}: ${error.message}`);
	}

	if (!lockfile || ![2, 3].includes(lockfile.lockfileVersion)
		|| !lockfile.packages || typeof lockfile.packages !== 'object' || Array.isArray(lockfile.packages)) {
		throw new Error(`${source} must be a version 2 or 3 lockfile with a packages object.`);
	}

	return lockfile;
}

function getPackageName(packagePath) {
	const segments = packagePath.split('/');
	let name;
	let index = 0;
	while (index < segments.length) {
		if (segments[index++] !== 'node_modules') {
			return undefined;
		}
		name = segments[index++];
		if (name?.startsWith('@')) {
			if (index >= segments.length) {
				return undefined;
			}
			name += `/${segments[index++]}`;
		}
		if (!isPackageName(name)) {
			return undefined;
		}
	}
	return name;
}

function isPackageName(name) {
	return typeof name === 'string' && /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/i.test(name);
}

function extractPackageVersions(lockfile) {
	const packageVersions = new Map();

	for (const [packagePath, metadata] of Object.entries(lockfile.packages)) {
		if (packagePath === '') {
			continue;
		}

		const installedName = getPackageName(packagePath);
		if (!installedName || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)
			|| metadata.link || metadata.inBundle) {
			throw new Error(`Cannot verify ${packagePath}: only registry packages are supported (no links or bundled packages).`);
		}

		// For npm aliases, the installation path is not the published package name.
		const name = metadata.name ?? installedName;
		if (!isPackageName(name)
			|| typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?$/i.test(metadata.version)) {
			throw new Error(`Cannot verify ${packagePath}: invalid registry package name or version.`);
		}

		for (const field of ['resolved', 'integrity']) {
			if (Object.hasOwn(metadata, `_${field}`)) {
				throw new Error(`Cannot verify ${packagePath}: npm's alternate _${field} field is not supported.`);
			}
			if (metadata[field] !== undefined && (typeof metadata[field] !== 'string' || !metadata[field])) {
				throw new Error(`Cannot verify ${packagePath}: invalid ${field}.`);
			}
		}

		const packageVersion = {
			name,
			version: metadata.version,
			resolved: metadata.resolved,
			integrity: metadata.integrity,
		};
		packageVersions.set(artifactKey(packageVersion), packageVersion);
	}

	return [...packageVersions.values()].sort(comparePackageVersions);
}

function comparePackageVersions(left, right) {
	return left.name.localeCompare(right.name) || left.version.localeCompare(right.version);
}

function artifactKey({ name, version, resolved, integrity }) {
	return JSON.stringify([name, version, resolved, integrity]);
}

function findChangedPackageVersions(baseLockfile, currentLockfile) {
	const baseVersions = new Set(
		extractPackageVersions(baseLockfile).map(artifactKey)
	);

	// Changing or removing the source or integrity requires revalidation even at the same version.
	return extractPackageVersions(currentLockfile)
		.filter(packageVersion => !baseVersions.has(artifactKey(packageVersion)));
}

function registryDependencyName(name, spec, source) {
	if (!isPackageName(name) || typeof spec !== 'string') {
		throw new Error(`Cannot verify ${source}: invalid dependency ${name}.`);
	}

	let selector = spec.trim();
	let target = name;
	if (selector.startsWith('npm:')) {
		const alias = selector.slice(4);
		const separator = alias.lastIndexOf('@');
		target = separator > 0 ? alias.slice(0, separator) : alias;
		selector = separator > 0 ? alias.slice(separator + 1).trim() : '*';
	}

	// Exclude URLs, git shortcuts, local paths, and bare tarball filenames.
	if (!isPackageName(target) || selector.startsWith('.') || !/^[a-z0-9*~^<>=|+.\s-]*$/i.test(selector)
		|| /\.(?:tgz|tar(?:\.gz)?)$/i.test(selector)) {
		throw new Error(`Cannot verify ${source}: ${name} must use a registry selector or npm alias, not ${spec}.`);
	}
	return target;
}

function findDependency(lockfile, packagePath, name) {
	let parent = packagePath;
	while (true) {
		const candidate = `${parent ? `${parent}/` : ''}node_modules/${name}`;
		if (Object.hasOwn(lockfile.packages, candidate)) {
			return { path: candidate, metadata: lockfile.packages[candidate] };
		}
		if (!parent) {
			return undefined;
		}
		const segments = parent.split('/');
		parent = segments.slice(0, segments.lastIndexOf('node_modules')).join('/');
	}
}

function validateInstallationSources(manifest, lockfile) {
	if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.workspaces) {
		throw new Error('The quarantine check requires a root package manifest without workspaces.');
	}

	const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
	for (const [packagePath, metadata] of [['', manifest], ...Object.entries(lockfile.packages)]) {
		const source = packagePath || 'root package manifest';
		for (const field of fields) {
			const dependencies = metadata?.[field];
			if (dependencies === undefined) {
				continue;
			}
			if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
				throw new Error(`Cannot verify ${source}: invalid ${field}.`);
			}
			for (const [name, spec] of Object.entries(dependencies)) {
				const target = registryDependencyName(name, spec, source);
				const installed = findDependency(lockfile, packagePath, name);
				if (installed && (installed.metadata.name ?? getPackageName(installed.path)) !== target) {
					throw new Error(`Cannot verify ${source}: ${name}'s dependency source does not match its locked package identity.`);
				}
			}
		}
	}

	function validateOverrides(overrides) {
		if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
			throw new Error('Cannot verify package.json: invalid overrides.');
		}
		for (const [key, value] of Object.entries(overrides)) {
			const separator = key.indexOf('@', 1);
			const name = key === '.' ? 'self' : separator > 0 ? key.slice(0, separator) : key;
			if (!isPackageName(name)) {
				throw new Error(`Cannot verify package.json: invalid override ${key}.`);
			}
			if (separator > 0) {
				const selector = key.slice(separator + 1);
				// npm also uses the key selector as a replacement when an object omits ".".
				if (selector.trim().startsWith('npm:')) {
					throw new Error(`Cannot verify package.json: override key ${key} must not select an alias.`);
				}
				registryDependencyName(name, selector, `override key ${key}`);
			}
			if (typeof value === 'string') {
				const spec = value.startsWith('$')
					? manifest.optionalDependencies?.[value.slice(1)] ?? manifest.dependencies?.[value.slice(1)] ?? manifest.devDependencies?.[value.slice(1)]
					: value;
				if (typeof spec !== 'string' || spec.trim().startsWith('npm:')) {
					throw new Error(`Cannot verify package.json: override ${key} must use a registry selector, not an alias or unresolved reference.`);
				}
				registryDependencyName(name, spec, `override ${key}`);
			} else {
				validateOverrides(value);
			}
		}
	}

	if (manifest.overrides !== undefined) {
		validateOverrides(manifest.overrides);
	}
}

function delay(milliseconds) {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function fetchPackageMetadata(packageName) {
	const url = `${REGISTRY_URL}/${encodeURIComponent(packageName)}`;
	let lastError;

	for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt++) {
		let response;
		try {
			response = await fetch(url, {
				redirect: 'error',
				headers: {
					Accept: 'application/json',
					'User-Agent': 'vscode-pull-request-github-package-quarantine',
				},
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			lastError = error;
		}

		if (response?.ok) {
			try {
				return await response.json();
			} catch (error) {
				lastError = new Error(`npm registry returned invalid JSON for ${packageName}: ${error.message}`);
			}
		} else if (response) {
			lastError = new Error(`npm registry returned HTTP ${response.status} for ${packageName}.`);
			if (response.status !== 429 && response.status < 500) {
				throw lastError;
			}
		}

		if (attempt < REQUEST_ATTEMPTS) {
			console.warn(`Registry lookup for ${packageName} failed (attempt ${attempt}); retrying.`);
			await delay(attempt * 1000);
		}
	}

	throw new Error(`Failed to query publication data for ${packageName}: ${lastError.message}`);
}

async function getPublicationDates(packageVersions) {
	for (const { name, version, resolved, integrity } of packageVersions) {
		if (!resolved || !integrity) {
			throw new Error(`Cannot verify ${name}@${version}: new or changed packages must have both resolved and integrity in package-lock.json.`);
		}
		const url = new URL(resolved);
		if (url.origin !== REGISTRY_URL || url.username || url.password || url.search || url.hash) {
			throw new Error(`Cannot verify ${name}@${version}: only tarballs from ${REGISTRY_URL} are supported.`);
		}
	}

	const packageNames = [...new Set(packageVersions.map(packageVersion => packageVersion.name))];
	const metadataByPackage = new Map();
	let nextIndex = 0;

	async function worker() {
		while (nextIndex < packageNames.length) {
			const packageName = packageNames[nextIndex++];
			metadataByPackage.set(packageName, await fetchPackageMetadata(packageName));
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(REQUEST_CONCURRENCY, packageNames.length) }, () => worker())
	);

	const publicationDates = new Map();
	for (const { name, version, resolved, integrity } of packageVersions) {
		const metadata = metadataByPackage.get(name);
		const registryVersion = metadata?.versions?.[version];
		const dist = registryVersion?.dist;
		if (registryVersion?.name !== name || registryVersion?.version !== version || dist?.tarball !== resolved) {
			throw new Error(`Cannot verify ${name}@${version}: lockfile identity or tarball does not match the npm registry.`);
		}

		const sha1Integrity = typeof dist.shasum === 'string' && /^[a-f0-9]{40}$/i.test(dist.shasum)
			? `sha1-${Buffer.from(dist.shasum, 'hex').toString('base64')}` : undefined;
		if (integrity !== dist.integrity && integrity !== sha1Integrity) {
			throw new Error(`Cannot verify ${name}@${version}: lockfile integrity does not match the npm registry.`);
		}

		const publishedAt = metadata?.time?.[version];
		if (typeof publishedAt !== 'string' || Number.isNaN(Date.parse(publishedAt))) {
			throw new Error(`The npm registry did not provide a valid publication time for ${name}@${version}.`);
		}
		publicationDates.set(JSON.stringify([name, version]), new Date(publishedAt));
	}

	return publicationDates;
}

function findQuarantineViolations(packageVersions, publicationDates, now, quarantineDays) {
	const quarantineMilliseconds = quarantineDays * MILLISECONDS_PER_DAY;
	const violations = [];

	for (const packageVersion of packageVersions) {
		const key = JSON.stringify([packageVersion.name, packageVersion.version]);
		const publishedAt = publicationDates.get(key);
		if (!(publishedAt instanceof Date) || Number.isNaN(publishedAt.getTime())) {
			throw new Error(`Missing publication time for ${packageVersion.name}@${packageVersion.version}.`);
		}

		const eligibleAt = new Date(publishedAt.getTime() + quarantineMilliseconds);
		if (now < eligibleAt) {
			violations.push({ ...packageVersion, publishedAt, eligibleAt });
		}
	}

	return violations.sort((left, right) => left.eligibleAt.getTime() - right.eligibleAt.getTime());
}

function readBaseLockfile(workspaceRoot, baseRef) {
	const shrinkwrap = childProcess.execFileSync(
		'git',
		['ls-tree', '--name-only', baseRef, '--', 'npm-shrinkwrap.json'],
		{ cwd: workspaceRoot, encoding: 'utf8' }
	);
	if (shrinkwrap.trim()) {
		throw new Error(`Cannot verify the base: npm-shrinkwrap.json at ${baseRef} takes precedence over package-lock.json and is not supported.`);
	}

	let contents;
	try {
		contents = childProcess.execFileSync(
			'git',
			['show', `${baseRef}:package-lock.json`],
			{
				cwd: workspaceRoot,
				encoding: 'utf8',
				maxBuffer: 10 * 1024 * 1024,
			}
		);
	} catch (error) {
		throw new Error(`Failed to read package-lock.json from ${baseRef}: ${error.message}`);
	}

	return parseLockfile(contents, `package-lock.json at ${baseRef}`);
}

function readCurrentLockfile(workspaceRoot) {
	if (fs.readdirSync(workspaceRoot).some(name => name.toLowerCase() === 'npm-shrinkwrap.json')) {
		throw new Error('npm-shrinkwrap.json takes precedence over package-lock.json and is not supported by the quarantine check.');
	}

	const currentLockfilePath = path.join(workspaceRoot, 'package-lock.json');
	return parseLockfile(fs.readFileSync(currentLockfilePath, 'utf8'), currentLockfilePath);
}

async function main(args = process.argv.slice(2)) {
	const options = parseArguments(args);
	const workspaceRoot = path.resolve(__dirname, '..');
	const currentLockfile = readCurrentLockfile(workspaceRoot);
	const manifest = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'));
	validateInstallationSources(manifest, currentLockfile);
	const baseLockfile = readBaseLockfile(workspaceRoot, options.baseRef);
	const changedPackageVersions = findChangedPackageVersions(baseLockfile, currentLockfile);

	if (!changedPackageVersions.length) {
		console.log('Package quarantine check passed: no new or changed npm package artifacts were introduced.');
		return;
	}

	console.log(`Checking ${changedPackageVersions.length} new or changed npm package artifact(s) against the ${options.quarantineDays}-day quarantine.`);
	const publicationDates = await getPublicationDates(changedPackageVersions);
	const violations = findQuarantineViolations(
		changedPackageVersions,
		publicationDates,
		new Date(),
		options.quarantineDays
	);

	if (violations.length) {
		console.error(`Package quarantine check failed: ${violations.length} package version(s) are less than ${options.quarantineDays} days old.`);
		for (const violation of violations) {
			console.error(
				`  - ${violation.name}@${violation.version} was published ${violation.publishedAt.toISOString()} and is quarantined until ${violation.eligibleAt.toISOString()}.`
			);
		}
		process.exitCode = 1;
		return;
	}

	console.log(`Package quarantine check passed: all ${changedPackageVersions.length} new or changed package artifact(s) are verified and at least ${options.quarantineDays} days old.`);
}

module.exports = {
	extractPackageVersions,
	findChangedPackageVersions,
	findQuarantineViolations,
	getPublicationDates,
	getPackageName,
	parseArguments,
	readBaseLockfile,
	readCurrentLockfile,
	validateInstallationSources,
	main,
};

if (require.main === module) {
	main().catch(error => {
		console.error(`Package quarantine check failed: ${error.message}`);
		process.exitCode = 1;
	});
}
