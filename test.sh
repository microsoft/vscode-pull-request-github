#!/bin/bash

printf "Transpiling src/\n"
tsc -p .
scripts/preprocess-gql --in src/github/queries.gql --out out/github/queries.gql

printf "\nTranspiling preview-src/\n"
tsc -p preview-src/
scripts/preprocess-svg --in resources/ --out preview-src/dist/resources/

printf "\nLaunching test runner\n"
node ./node_modules/vscode/bin/test