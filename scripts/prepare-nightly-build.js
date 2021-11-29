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

const readme = fs.readFileSync('./README.md');
const previewReadme = `
> **This pre-release version now uses VS Code's pre-release extension support. If you used the old nightly build of this extension you have been automatically updated to this version and the old extension state was not migrated. Thank you for helping make GitHub Pull Requests and Issues better!**

# GitHub Pull Request Pre-release Build

This is the nightly build of [GitHub Pull Request extension](https://marketplace.visualstudio.com/items?itemName=GitHub.vscode-pull-request-github) for early feedback and testing.

${readme}
`;

fs.writeFileSync('./README.insiders.md', previewReadme);
