0.3.1
- Add status check information on PR description page [#713](https://github.com/Microsoft/vscode-pull-request-github/pull/713)
- Add button for creating a pull request on PR tree view [#709](https://github.com/Microsoft/vscode-pull-request-github/pull/709)
- Add "Suggest Edit" command [#688](https://github.com/Microsoft/vscode-pull-request-github/pull/688)
- Fix [#689](https://github.com/Microsoft/vscode-pull-request-github/issues/689), by [@JefferyCA], do not render markdown block comments
- Fix [#553](https://github.com/Microsoft/vscode-pull-request-github/issues/553), don't prevent checkout when there are unrelated working tree changes
- Fix [#576](https://github.com/Microsoft/vscode-pull-request-github/issues/576), handle GitHub enterprise behind a SSO wall

0.3.0

**Breaking Changes**ß

- From 0.3.0, you at least need VSCode 1.30 (including Insiders) to install and run the extension.

**Thank You**

* [Jeffrey (@JeffreyCA)](https://github.com/JeffreyCA)
  * Correct timestamp format [PR #686](https://github.com/Microsoft/vscode-pull-request-github/pull/686)
  * Render Markdown line breaks as <br> [PR #679](https://github.com/Microsoft/vscode-pull-request-github/pull/679)
  * Support absolute and relative timestamps [PR #644](https://github.com/Microsoft/vscode-pull-request-github/pull/644)

0.2.3
- Fix [#607], read `~/.ssh/config` to resolve hosts
- Fix [#572], by [@yoh1496], add support for GitHub Enterprise behind a proxy
- Fix [#658], ensure correct button enablement when reloading pending comment from cache
- Fix [#649], make sure selecting a different folder is responsive after adding it to the workspace

0.2.2

- Add support for editing and deleting comments [#107](https://github.com/Microsoft/vscode-pull-request-github/issues/107)
- Fix [#110](https://github.com/Microsoft/vscode-pull-request-github/issues/110), by [@JeffreyCA], add hyperlinks to timestamps
- Fix [#624](https://github.com/Microsoft/vscode-pull-request-github/issues/624), by [@JeffreyCA], improve comment header wording
- Fix [#568](https://github.com/Microsoft/vscode-pull-request-github/issues/568), by [@jerrymajewski], show author information in PR tooltip
- Fix [#543](https://github.com/Microsoft/vscode-pull-request-github/issues/543), by [@malwilley], preserve description page scroll position when focus changes
- Fix [#587](https://github.com/Microsoft/vscode-pull-request-github/issues/587), by [@mmanela], show correct error message for empty comment case
- Migrate hosts setting to `githubPullRequests` namespace, by [@wyze]
- Fix [#573](https://github.com/Microsoft/vscode-pull-request-github/issues/573), provide auth fallback when protocol handler fails

**Breaking Changes**

- From 0.2.0, you at least need VSCode 1.28 to install and run the extension.

**Fixes**

- Fix [#565](https://github.com/Microsoft/vscode-pull-request-github/issues/565), inline links in description page.
- Fix [#531](https://github.com/Microsoft/vscode-pull-request-github/issues/531) by [@wyze](https://github.com/wyze), state is incorrectly shown as Closed when it should be Merged
- Fix [#273](https://github.com/Microsoft/vscode-pull-request-github/issues/273), support ssh remotes.
- Fix [#537](https://github.com/Microsoft/vscode-pull-request-github/issues/537) by [@justinliew](https://github.com/justinliew), show pull request id in title.
- Fix [#491](https://github.com/Microsoft/vscode-pull-request-github/issues#491) by [@shatgupt](https://github.com/shatgupt), allow vertical resizing of comment box.
- Fix [#319](https://github.com/Microsoft/vscode-pull-request-github/issues#319), improve keyboard focus.
- Fix [#352](https://github.com/Microsoft/vscode-pull-request-github/issues/352) by [@Ikuyadeu](https://github.com/Ikuyadeu), support merging pull request
- Fix [#464](https://github.com/Microsoft/vscode-pull-request-github/issues/464) by [@wyze](https://github.com/wyze), show labels on PR description
- Fix [#562](https://github.com/Microsoft/vscode-pull-request-github/issues/562) by [@emtei](https://github.com/emtei), prevent PR creation date collision with subtitle

0.1.7

- Fix for native promise polyfill removal from VSCode extension host in Insiders 1.29

0.1.6
- Fix for [#500](https://github.com/Microsoft/vscode-pull-request-github/issues/500) and [#440](https://github.com/Microsoft/vscode-pull-request-github/issues/440), more lenient remote parsing
- Fix for [#383](https://github.com/Microsoft/vscode-pull-request-github/issues/383), move to github.com domain for the authentication server
- Fix for [#498](https://github.com/Microsoft/vscode-pull-request-github/issues/498), make sure comments gets updated on refresh event
- Fix for [#496](https://github.com/Microsoft/vscode-pull-request-github/issues/496), linkify urls on the description page
- FIx for [#507](https://github.com/Microsoft/vscode-pull-request-github/issues/507), loosen scope restrictions for older version of GitHub Enterprise

0.1.5
- Fix for [#449](https://github.com/Microsoft/vscode-pull-request-github/issues/449), authentication blocked when `docs-article-templates` extension is installed
- Fix for [#429](https://github.com/Microsoft/vscode-pull-request-github/issues/429), avoid unneccessary refreshes of the tree view

0.1.4
- Do not ship `.vscode-test/**` files

0.1.3
- Fix for [#382](https://github.com/Microsoft/vscode-pull-request-github/issues/382), authentication on enterprise servers without a `/rate_limit` path
- Fix for [#419](https://github.com/Microsoft/vscode-pull-request-github/issues/419), improve parsing of git remotes and show a warning if parse fails

0.1.2
- Fix for [#395](https://github.com/Microsoft/vscode-pull-request-github/issues/395), tree view not shown when the extension failed to parse a remote
- [#399](https://github.com/Microsoft/vscode-pull-request-github/issues/399), use `badge.foreground` color for PR status badge
- Fix for [#380](https://github.com/Microsoft/vscode-pull-request-github/issues/380), HTML content in diff on the overview was unescaped
- Fix for [#375](https://github.com/Microsoft/vscode-pull-request-github/issues/375), appropriately fetch more changed files in the tree view
