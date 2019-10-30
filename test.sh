#!/bin/bash

if [ ! -f media/extension.js ]; then
	printf "Running webpack\n"
	webpack --env.development
fi

printf "Transpiling src/\n"
tsc -p .
scripts/preprocess-gql --in src/github/queries.gql --out out/github/queries.gql
scripts/preprocess-gql --in src/github/enterprise.gql --out out/github/enterprise.gql

printf "\nTranspiling preview-src/\n"
tsc -p preview-src/
scripts/preprocess-svg --in resources/ --out preview-src/dist/resources/

printf "\nLaunching test runner\n"
CODE_VERSION=insiders node ./node_modules/vscode/bin/test
