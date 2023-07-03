# Suggest a Change

The "Suggest a Change" feature uses GitHub.com's mechanism for suggestion a change (as apposed to the old "Suggest an Edit" feature which used git patches to leave suggestsions).

## Making a suggestion

First, select the lines or place your cursor on the line you want to make a suggestion for. Then add a comment, either with the `+` in the editor or with the "Add Comment on Current Selection" command. From the comment, you can use the "Make a Suggestion" button, located below the comment input, to insert the suggestion template into the comment input. The "Make a Suggestion" button can be tabbed to in the comment widget. For example, if you want to leave a comment on this line:

```ts
console.log('hello world');
```

The following would be inserted into the comment input:

````
```suggestion
 console.log('hello world');
```
````

You can then modify the contents of the `suggestion` block such that the code within demonstrates your suggestion.

## Accepting a suggestion

If a comment has a `suggestion` block in it as described above, the comment actions will include an "Apply Suggestion" button. This action can be tabbed to when you focus an existing comment. The suggestion is applied by replacing the lines that the comment targets with the contents of the suggestion. When you accept a suggestion, only the file is modified. To have the suggestion pushed to the pull request, you'll need to commit the file change and push the change to the remote branch.

## Example

This gif shows an example of how to make a suggestion and then apply it.

![Example of how to suggest and accept a change in a PR](/documentation/changelog/0.58.0/suggest-a-change.gif)