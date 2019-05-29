#!/bin/bash
tsc -p .
scripts/preprocess-gql --in src/github/queries.gql --out out/github/queries.gql
node ./node_modules/vscode/bin/test