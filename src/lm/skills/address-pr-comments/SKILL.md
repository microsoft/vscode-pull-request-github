---
name: address-pr-comments
description: "Address review comments (including Copilot comments) on the active pull request. Use when: responding to PR feedback, fixing review comments, resolving PR threads, implementing requested changes from reviewers, addressing code review, fixing PR issues."
argument-hint: "Optionally specify a reviewer name or file to focus on"
---

# Address PR Review Comments

Read the active pull request, identify unresolved review comments and feedback, implement the requested changes, and resolve the threads.

## When to Use

- A reviewer has left comments or change requests on the active PR
- You need to systematically work through all open review threads
- You want to respond to or implement reviewer feedback

## Procedure

### 1. Read the Active PR

Call the `github-pull-request_activePullRequest` tool.

**Refresh logic**: Check whether a refresh is needed before reading:
- Call the tool once *without* `refresh` to get the cached state
- Inspect the `lastUpdatedAt` field in the result
- If the timestamp is **less than 3 minutes ago**, the PR is actively changing - call the tool again with `refresh: true` to ensure you have the latest comments and state
- If the timestamp is older than 3 minutes, proceed with the cached data

### 2. Identify Unresolved Comments

From the tool result, collect all feedback that needs action:

- **`comments`** array: inline review thread comments where `commentState` is `"unresolved"`
- **`timelineComments`** array: general PR comments and reviews where `commentType` is `"CHANGES_REQUESTED"` or `"COMMENTED"`

Group related comments by file (`file` field) to handle them efficiently.

### 3. Plan Changes

Before modifying any files:
1. Read each unresolved comment carefully
2. Identify the file and location each comment refers to
3. Determine the minimal correct fix for each, if a fix is needed (not all comments are worthy of a change)
4. Note dependencies between comments (e.g., a rename that affects multiple files)

### 4. Implement Changes

Work through the grouped comments file by file:
- Read the relevant file section before editing
- Apply the requested change
- Do not refactor or modify code outside the scope of each comment
- If a comment is unclear or contradictory, note it for a follow-up reply rather than guessing

### 5. Verify

After all changes are made:
- Review that each originally unresolved comment has a corresponding code change or a note about why no code change was needed.
- Ensure no unrelated code was modified

### 6. Summarize

Provide a concise summary of:
- Which comments were addressed and what changes were made
- Any comments that were intentionally skipped (with reasoning)
- Any follow-up questions for the reviewer
