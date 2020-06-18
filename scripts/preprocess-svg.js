const util = require('util');
const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const svgLoader = require('svg-inline-loader');
const globCb = require('glob');
const mkdirpCb = require('mkdirp');

function printUsage(consoleFn, exitCode) {
	consoleFn(`Usage: bin/preprocess-svg --in [filename] --out [filename]

Preprocess a directory containing *.svg files into *.js modules consistently
with the way that Webpack will transpile them at build time.

Options:

  --help, -h			Display this message.
  --in, -i [dirname] 	Discover and convert SVG files beneath [dirname].
  --out, -o [dirname]	Emit JavaScript source to files beneath [dirname].
`);
	process.exit(exitCode);
}

const argv = minimist(process.argv.slice(2), {
	string: ['in', 'out'],
	boolean: ['help'],
	alias: {h: 'help', i: 'in', o: 'out'},
	unknown: param => {
		console.error(`Unrecognized command-line argument: ${param}\n`);
		printUsage(console.error, 1);
	}
});

if (argv.help) {
	printUsage(console.log, 0);
}

const inRoot = argv.in;
const outRoot = argv.out;

if (!inRoot || !outRoot) {
	console.error('Both --in and --out parameters are required.\n');
	printUsage(console.error, 1);
}

const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);

async function processFile(inFilename, outFilename) {
	const originalSource = await readFile(inFilename, {encoding: 'utf8'});
	const moduleSource = svgLoader(originalSource);
	await writeFile(outFilename, moduleSource, {encoding: 'utf8'});
}

const glob = util.promisify(globCb);
const mkdirp = util.promisify(mkdirpCb);

async function processDirectory(inDirectory, outDirectory) {
	const files = await glob('**/*.svg', {cwd: inDirectory});
	return Promise.all(
		files.map(async subPath => {
			const inFilename = path.join(inDirectory, subPath);
			const outFilename = path.join(outDirectory, subPath);
			await mkdirp(path.dirname(outFilename));
			await processFile(inFilename, outFilename);
		}),
	);
}

processDirectory(inRoot, outRoot).catch(error => {
	console.error(error.stack);
	process.exit(1);
});