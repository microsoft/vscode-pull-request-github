const fs = require('fs');
const argv = require('minimist')(process.argv.slice(2));

const json = JSON.parse(fs.readFileSync('./package.json').toString());
const stableVersion = json.version.match(/(\d+)\.(\d+)\.(\d+)/);
const major = stableVersion[1];
const minor = stableVersion[2];

// update name, publisher and description
// calculate version
let patch = argv['v'];
if (typeof patch !== 'string') {
	const date = new Date();
	patch = `${date.getFullYear()}${date.getMonth() + 1}${date.getDate()}${date.getHours()}`;
}

// The stable version should always be <major>.<minor_even_number>.patch
// For the nightly build, we keep the major, make the minor an odd number with +1, and add the timestamp as a patch.
const insiderPackageJson = Object.assign(json, {
	version: `${major}.${Number(minor)+1}.${patch}`
});

fs.writeFileSync('./package.insiders.json', JSON.stringify(insiderPackageJson));