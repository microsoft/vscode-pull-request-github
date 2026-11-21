---
name: form-github-search-query
description: Forms a GitHub search query based on a natural language query and the type of search (issue or PR). This skill helps users create effective search queries to find relevant issues or pull requests on GitHub.
---

# Form GitHub Search Query

## Purpose

GitHub has a specific syntax for searching issues and pull requests. This skill takes a natural language query from the user and the type of search they want to perform (issue or PR) and converts it into a properly formatted GitHub search query. This allows users to leverage GitHub's powerful search capabilities without needing to know the specific syntax.

## Usage

To use this skill, provide a natural language query and specify whether you want to search for issues or pull requests. The skill will then analyze the input and generate a GitHub search query that can be used to find relevant results on GitHub.

## Converting Natural Language to GitHub Search Syntax

### Steps

1. Identify if there's a repo mention in the query.
2. Fetch labels for the repo if mentioned.
3. Follow the "Tips for Forming Effective Search Queries" to convert the natural language query into GitHub search syntax.

### Search Syntax Overview

- is: { possibleValues: ['issue', 'pr', 'draft', 'public', 'private', 'locked', 'unlocked'] }
- assignee: { valueDescription: 'A GitHub user name or @me' }
- author: { valueDescription: 'A GitHub user name or @me' }
- mentions: { valueDescription: 'A GitHub user name or @me' }
- team: { valueDescription: 'A GitHub user name' }
- commenter: { valueDescription: 'A GitHub user name or @me' }
- involves: { valueDescription: 'A GitHub user name or @me' }
- label: { valueDescription: 'A GitHub issue/pr label' }
- type: { possibleValues: ['pr', 'issue'] }
- state: { possibleValues: ['open', 'closed', 'merged'] }
- in: { possibleValues: ['title', 'body', 'comments'] }
- user: { valueDescription: 'A GitHub user name or @me' }
- org: { valueDescription: 'A GitHub org, without the repo name' }
- repo: { valueDescription: 'A GitHub repo, without the org name' }
- linked: { possibleValues: ['pr', 'issue'] }
- milestone: { valueDescription: 'A GitHub milestone' }
- project: { valueDescription: 'A GitHub project' }
- status: { possibleValues: ['success', 'failure', 'pending'] }
- head: { valueDescription: 'A git commit sha or branch name' }
- base: { valueDescription: 'A git commit sha or branch name' }
- comments: { valueDescription: 'A number' }
- interactions: { valueDescription: 'A number' }
- reactions: { valueDescription: 'A number' }
- draft: { possibleValues: ['true', 'false'] }
- review: { possibleValues: ['none', 'required', 'approved', 'changes_requested'] }
- reviewedBy: { valueDescription: 'A GitHub user name or @me' }
- reviewRequested: { valueDescription: 'A GitHub user name or @me' }
- userReviewRequested: { valueDescription: 'A GitHub user name or @me' }
- teamReviewRequested: { valueDescription: 'A GitHub user name' }
- created: { valueDescription: 'A date, with an optional < >' }
- updated: { valueDescription: 'A date, with an optional < >' }
- closed: { valueDescription: 'A date, with an optional < >' }
- no: { possibleValues: ['label', 'milestone', 'assignee', 'project'] }
- sort: { possibleValues: ['updated', 'updated-asc', 'interactions', 'interactions-asc', 'author-date', 'author-date-asc', 'committer-date', 'committer-date-asc', 'reactions', 'reactions-asc', 'reactions-(+1, -1, smile, tada, heart)'] }

### Example Queries

- repo:microsoft/vscode is:issue state:open sort:updated-asc
- mentions:@me org:microsoft is:issue state:open sort:updated
- assignee:@me milestone:"October 2024" is:open is:issue sort:reactions
- comments:>5 org:contoso is:issue state:closed mentions:@me label:bug
- interactions:>5 repo:contoso/cli is:issue state:open
- repo:microsoft/vscode-python is:issue sort:updated -assignee:@me
- repo:contoso/cli is:issue sort:updated no:milestone

### Tips for Forming Effective Search Queries

- Always try to include "repo:" or "org:" in your response.
- "repo" is often formated as "owner/name".
- If the user specifies a repo, ALWAYS fetch the labels for that repo and try to match any words in the natural language query to the label names to include them in the search query (See "Adding Labels to the Search Query" section).
- Words in inline codeblocks are likely to refer to labels. Try to match them to labels in the repo and include them in the search query.
- Always include a "sort:" parameter. If multiple sorts are possible, choose the one that the user requested.
- Always include a property with the @me value if the query includes "me" or "my".
- Go through each word of the natural language query and try to match it to a syntax component.
- Use a "-" in front of a syntax component to indicate that it should be "not-ed".
- Use the "no" syntax component to indicate that a property should be empty.

### Adding Labels to the Search Query

- Choose labels based on what the user wants to search for, not based on the actual words in the query.
- The user might include info on how they want their search results to be displayed. Ignore all of that.
- Labels will be and-ed together, so don't pick a bunch of super specific labels.
- Try to pick just one label.
- Only choose labels that you're sure are relevant. Having no labels is preferable than labels that aren't relevant.
- Don't choose labels that the user has explicitly excluded.
