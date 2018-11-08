const fs = require('fs');
const argv = require('minimist')(process.argv.slice(2));

const json = JSON.parse(fs.readFileSync('./package.json').toString());

// update name, publisher and description
// calculate version
let version = argv['v'];
if (typeof(version) !== 'string') {
	const date = new Date();
	const major = date.getFullYear() - 2018;
	const yearStart = new Date(date.getFullYear(), 0, 0);
	const diff = date - yearStart;
	const minor = Math.floor(diff / (1000 * 60 * 60 * 24));
	version = `${major}.${minor}.0`;
}

const id = argv['i'];
const displayName = argv['n'];
const description = argv['d'];
const publisher = argv['p'];
if (!id || !displayName || !description || !publisher) {
	return;
}

const insiderPackageJson = Object.assign(json, {
	name: id,
	version: version,
	displayName: displayName,
	description: description,
	publisher: publisher
});

fs.writeFileSync('./package.insiders.json', JSON.stringify(insiderPackageJson));
