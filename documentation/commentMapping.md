Problem:
When threads are fetched without specifying iterations, the `threadContext` filepath contains the file name of file that existed when that comment was created. This file can be renamed, moved or deleted in subsequent iterations, however the thread's `threadContext` still returns the old path. An example of this is - the PR contains change of renaming `foo.md` to `bar.md`. User enters comments on the PR which are now tagged to `bar.md`. A push is made that renames `bar.md` to `baz.md`. At this stage there is no `bar.md` in the PR. When getting changes between PR branches (or mergeBase), the API will only return `baz.md` as renamed and `foo.md` as deleted. There is no mention of `bar.md` as diff between HEADS of two branches does not know about this ephemeral file. However the threads API will still return the thread mapped to `bar.md`. This creates problem when mapping comments to respective files as `bar.md` does not exist in the file changes.

A workaround - TO BE TESTED
Threads are fetched between first iteration and last iteration. The API then returns correct filename/path in the `threadContext` however the `threadContext` now contains wrong comment position with respect to *left* or *right*. This is because when fetching comments via iterations the API treats iteration 1 as *left* and last iteration as *right*. The API additional property called `pullRequestThreadContext` that contains fileName at the time of comment including its position. We rely on this property's position to get the correct *left* or *right* positioning. But the filename/path is read from `threadContext`. The threads are then matched with the correct file using `threadContext?.filePath` and `filename` (based on URI query). The actual comment positions are determined by following logic -

```ts
export function getPositionFromThread(comment: GitPullRequestCommentThread) {
	if (comment.pullRequestThreadContext?.trackingCriteria !== undefined) {
		return comment.pullRequestThreadContext?.trackingCriteria?.origRightFileStart === undefined
			? comment.pullRequestThreadContext?.trackingCriteria?.origLeftFileStart?.line
			: comment.pullRequestThreadContext?.trackingCriteria?.origRightFileStart.line;
	}
	return comment.threadContext?.rightFileStart === undefined ? comment.threadContext?.leftFileStart?.line : comment.threadContext.rightFileStart.line;
```

An alternative to the above is to not do all those above and only display those comments which can be correctly mapped. Remaining comments will be displayed in Description webview. The reasoning behind this is that the ephemeral files are treated as transient files. For example -> create a file, add comments, delete the file. In this case there is no way to get the correct filename anyways as the file no longer exist.