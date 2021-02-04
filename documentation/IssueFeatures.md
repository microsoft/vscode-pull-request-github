We've added some experimental GitHub issue features.

# Code actions

Wherever there is a `TODO` comment in your code, the **Create Issue from Comment** code action will show. This takes your text selection, and creates a GitHub issue with the selection as a permalink in the issue body. It also inserts the issue number after the `TODO`.

![Create Issue from Comment](images/createIssueFromComment.gif)

The code action trigger defaults are `TODO`, `todo`, `BUG`, `FIXME`, `ISSUE`, and `HACK`. You can modify these with the `githubIssues.createIssueTriggers` setting.
You can also create an issue from a text selection by running the **Create Issue from Selection** command.

# Commands

There are two new commands for easily creating GitHub permalinks. The **Copy GitHub Permalink** command will take the text you have selected and make a git hub permalink. The **Open Permalink on GitHub** command creates the same permalink, but also opens the link in your browser.

# Inline Completion Suggestions

## Issues

The issue completion is triggered by typing `#` or by running the **Trigger Suggest** command after a `#`. By default, only issues assigned to you will be in the suggestions, but you can change this by [customizing the query](#customize-query). The initial sorting of the issues should be by milestone due date, with the "current" milestone first. If your repository doesn't use milestone due dates, then the milestone date will be guessed by the name of the milestone. Within each milestone, issues are sorted by most recently modified. If there are milestones you want to ignore, you can configure them with the `githubIssues.ignoreMilestones` setting. Issue completions work in the editor and in the Source Control commit message.

![Issue Completion Editor](images/issueCompletionEditor.png)

![Issue Completion SCM](images/issueCompletionSCM.png)

In the Source Control commit message and in most other files, the completion will insert the issue number. In markdown files, it will insert a markdown link to the issue such as `[#1234](https://github.com/Microsoft/vscode-pull-request-github/issues/1234)`. For the SCM input box you can configure what is inserted for the completion using `"githubIssues.issueCompletionFormatScm": "${issueNumberLabel}"`.

If triggering issue completion on `#` is too noisy for you, you can configure that trigger character to be ignored with the `"githubIssues.ignoreCompletionTrigger"` setting.

## Users

The user completion is triggered by `@` or by running the **Trigger Suggest** command after a `@`. All users that can have issues assigned to them will be suggested.

![User Completion](images/userCompletion.png)

Selecting a completion item will insert the username, such as @alexr00

# Hovers

## Issues

When you hover over an issue (`#1234` or a full GitHub url) a card similar to the hover card from GitHub will show.

![Issue Hover](images/issueHover.png)

## Users

Similarly, there is also a hover for users such as `@alexr00`.

![User Hover](images/userHover.png)

# View

You can see issues listed in the Issues view. The default query shows the issues for the repository you currently have opened that are assigned to you, ordered by milestone. The view is enabled with the setting `"githubIssues.show": true`.

![Issue View](images/issueView.png)

## Customize Query

If the default query doesn't suit you, you can use a custom query to change the issues that are shown in the issues view.

```json
"githubIssues.queries": [
		{
			"label": "My Issues",
			"query": "default"
		},
		{
			"label": "Remote Release",
			"query": "assignee:alexr00 state:open repo:Microsoft/vscode-remote-release sort:updated-desc"
		}
	]
```

## Working on an issue

From the issues view you can start working on an issue. This creates a branch, populates the commit message, and gives you new actions to take on the issue. When you're done working on the issue, you can Stop Working on it or create a pull request.

![Start Working](images/startWorking.gif)

**Start Working** is customizable. If you don't want a branch to be created, use `"githubIssues.useBranchForIssues": "off"`. If you always want to be prompted to enter the name of the branch use the `"prompt"` option of the setting. If you have a different naming scheme for your branches you can use `"githubIssues.issueBranchTitle": "${user}/issue${issueNumber}"` to configure it.

