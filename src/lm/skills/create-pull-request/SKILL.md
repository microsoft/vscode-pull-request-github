---
name: create-pull-request
description: "Create a GitHub Pull Request from the current or specified branch. Use when: opening a PR, submitting code for review, creating a draft PR, publishing a branch as a pull request, proposing changes to a repository."
argument-hint: "Optionally specify a title, base branch, or whether to create as a draft"
---

# Create a GitHub Pull Request

Gather the necessary information, prepare a clear title and description, then call the tool to open the pull request.

## When to Use

- The user wants to open a PR for their current or a specified branch
- The user has finished a feature or fix and wants to submit it for review
- The user wants to create a draft PR to share work in progress
- The user asks to "open a PR", "create a pull request", or "submit for review"

## Procedure

### 1. Gather Information

Determine the required parameters before calling the tool:

- **Head branch**: If the user has not specified a branch, use workspace or git context to find the current branch name. Do not use `owner:branch` format - pass just the branch name (e.g. `my-feature`).
- **Base branch**: If the user has not specified a base branch, omit it and let the tool use the repository's default branch.
- **Title**: If the user has not provided a title, derive one from the branch name, recent commits, or the user's description of their work (see Best Practices below).
- **Body**: If the user has not provided a description, prepare a concise summary of what changed and why (see Best Practices below).
- **Draft**: Ask or infer whether the PR should be a draft. Default to non-draft unless the user indicates the work is not ready for review.

### 2. Check for Uncommitted or Unpushed Changes

Before creating the PR, inspect the working tree state. If you need to run git commands, give an explanation for why the command needs to be run.

1. **Check for uncommitted changes**: Use the git tool or VS Code SCM context to determine whether there are staged or unstaged file changes. If yes:
	 - Ask the user if they want to commit these changes before opening the PR.
	 - If they do, help them write a commit message and commit the changes (`git add -A && git commit -m "<message>"`).
	 - If they decline, proceed only if there are already commits on the branch that are ahead of the base - otherwise there is nothing to put in the PR.

2. **Check for unpushed commits**: Determine whether the local branch has commits that have not been pushed to the remote (i.e. the branch is ahead of its upstream). If yes:
	 - Ask the user if they want to push before opening the PR, or let them know the tool will attempt to push automatically if needed.
	 - If pushing manually is preferred, run `git push` (or `git push --set-upstream origin <branch>` if no upstream is set yet) before calling the tool.

3. **Confirm the branch is on the remote**: The `create_pull_request` tool requires the head branch to be present on the remote. If it is not, push it first.

If all changes are already committed and pushed, proceed directly to the next step.

### 3. Prepare PR Details

Write a good title and description if the user has not provided them:

**Title**: Use imperative mood, keep it under 72 characters, and describe *what* the PR does (e.g. `Add retry logic for failed API requests`).

**Body**: Include:
- A short summary of what changed and why
- Any relevant issue references (e.g. `Fixes #123`)
- Notable implementation decisions, if useful for the reviewer

### 4. Call the Tool

Use the `github-pull-request_create_pull_request` tool with the gathered parameters:

```
github-pull-request_create_pull_request({
	title: '<descriptive title>',
	head: '<branch-name>',        // branch name only, not owner:branch
	body: '<description>',        // optional but recommended
	base: '<base-branch>',        // optional; omit to use repo default
	draft: false,                 // set true for work-in-progress
	headOwner: '<owner>',         // optional; omit if same as repo owner
	repo: { owner: '<owner>', name: '<repo>' }  // optional
})
```

### 5. Confirm Result

After the tool returns successfully:

- Report the PR number and URL to the user as a markdown link. The link should be a VS Code URI like `vscode-insiders://github.vscode-pull-request-github/open-pull-request-webview?uri=https://github.com/microsoft/vscode-css-languageservice/pull/460` or `vscode://github.vscode-pull-request-github/open-pull-request-webview?uri=https://github.com/microsoft/vscode-css-languageservice/pull/460`.
- Mention the base branch the PR targets.
- If the PR was created as a draft, remind the user to mark it ready for review when appropriate.

## Best Practices

### Titles
- Use the imperative mood: `Fix`, `Add`, `Update`, `Remove`, `Refactor` - not `Fixed`, `Adding`, etc.
- Be specific: `Fix null pointer in user login flow` beats `Fix bug`.
- Keep it under 72 characters so it displays cleanly in GitHub and email notifications.

### Descriptions
- Start with a one-sentence summary.
- Explain *why* the change is needed, not just *what* it does - reviewers benefit from context.
- Reference related issues with `Fixes #<number>` or `Closes #<number>` to auto-close them on merge.
- If the change is large, add a brief list of the main files or components touched.

### Draft PRs
- Use `draft: true` when the code is not yet ready for formal review (e.g. work in progress, awaiting feedback on approach, CI not yet passing).
- Draft PRs are visible to collaborators but will not show as review-requested until marked ready.
- Suggest using a draft when the user mentions they are still working on it or just want early feedback.
