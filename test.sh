#!/bin/bash
tsc -p .
echo -n > out/github/queries.gql
node ./node_modules/vscode/bin/test