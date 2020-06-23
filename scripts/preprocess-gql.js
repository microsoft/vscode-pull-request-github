const fs = require('fs');
const minimist = require('minimist');
const gqlLoader = require('graphql-tag/loader');

function printUsage(consoleFn, exitCode) {
	consoleFn(`Usage: bin/preprocess-gql --in [filename] --out [filename]

Preprocess a file containing GraphQL queries into a *.js module consistently
with the way that Webpack will transpile it at build time.

Options:

  --help, -h			Display this message.
  --in, -i [filename] 	Read GraphQL queries from the file at [filename].
  --out, -o [filename]	Emit JavaScript source to the file at [filename].
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

const inFilename = argv.in;
const outFilename = argv.out;

if (!inFilename || !outFilename) {
	console.error('Both --in and --out parameters are required.\n');
	printUsage(console.error, 1);
}

const querySource = fs.readFileSync(inFilename, {encoding: 'utf8'});
const jsSource = gqlLoader.call({ cacheable() {} }, querySource);
fs.writeFileSync(outFilename, jsSource, {encoding: 'utf8'});