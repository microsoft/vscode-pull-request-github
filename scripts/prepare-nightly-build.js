const fs = require('fs');
const argv = require('minimist')(process.argv.slice(2));

const json = JSON.parse(fs.readFileSync('./package.json').toString());

// update name, publisher and description
// calculate version
let version = argv['v'];
if (typeof(version) !== 'string') {
	const date = new Date();
	const monthMinutes = (date.getDate() - 1) * 24 * 60 + date.getHours() * 60 + date.getMinutes();
	version = `${date.getFullYear()}.${date.getMonth() + 1}.${monthMinutes}`;
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

const readme = fs.readFileSync('./README.md');
const previewReadme = `
# GitHub Pull Request Nightly Build

This is the nightly build of [GitHub Pull Request extension](https://marketplace.visualstudio.com/items?itemName=GitHub.vscode-pull-request-github) for early feedback and testing.

The extension can be installed side-by-side with the current GitHub Pull Request extension, use the Extensions Viewlet to disable this version of the extension you do not want to use.

${readme}
`;

fs.writeFileSync('./README.insiders.md', previewReadme);

const constants = fs.readFileSync('./src/constants.ts').toString();
const insiderConstants = constants.replace(`export const EXTENSION_ID = 'GitHub.vscode-pull-request-github';`, `export const EXTENSION_ID = 'GitHub.vscode-pull-request-github-insiders';`);
fs.writeFileSync('./src/constants.insiders.ts', insiderConstants);
