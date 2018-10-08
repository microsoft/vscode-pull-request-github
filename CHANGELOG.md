0.1.2
- Fix for [#395](https://github.com/Microsoft/vscode-pull-request-github/issues/395), tree view not shown when the extension failed to parse a remote
- [#399](https://github.com/Microsoft/vscode-pull-request-github/issues/399), use `badge.foreground` color for PR status badge
- Fix for [#380](https://github.com/Microsoft/vscode-pull-request-github/issues/380), HTML content in diff on the overview was unescaped
- Fix for [#375](https://github.com/Microsoft/vscode-pull-request-github/issues/375), appropriately fetch more changed files in the tree view

0.1.3
- Fix for [#382](https://github.com/Microsoft/vscode-pull-request-github/issues/382), authentication on enterprise servers without a `/rate_limit` path
- Fix for [#419](https://github.com/Microsoft/vscode-pull-request-github/issues/419), improve parsing of git remotes and show a warning if parse fails

0.1.4
- Do not ship `.vscode-test/**` files

0.1.5
- Fix for [#449](https://github.com/Microsoft/vscode-pull-request-github/issues/449), authentication blocked when `docs-article-templates` extension is installed
- Fix for [#429](https://github.com/Microsoft/vscode-pull-request-github/issues/429), avoid unneccessary refreshes of the tree view

0.1.6
- Fix for [#500](https://github.com/Microsoft/vscode-pull-request-github/issues/500) and [#440](https://github.com/Microsoft/vscode-pull-request-github/issues/440), more lenient remote parsing
- Fix for [#383](https://github.com/Microsoft/vscode-pull-request-github/issues/383), move to github.com domain for the authentication server
- Fix for [#498](https://github.com/Microsoft/vscode-pull-request-github/issues/498), make sure comments gets updated on refresh event
- Fix for [#496](https://github.com/Microsoft/vscode-pull-request-github/issues/496), linkify urls on the description page
- FIx for [#507](https://github.com/Microsoft/vscode-pull-request-github/issues/507), loosen scope restrictions for older version of GitHub Enterprise

0.1.7
- Fix for native promise polyfill removal from VSCode extension host in Insiders 1.29
