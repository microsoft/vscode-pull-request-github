> GitHub Enterprise Fix [Pull Request](https://github.com/microsoft/vscode-pull-request-github/pull/3564)

### I take no credit for this fix, that should go to [harshanarayana](https://github.com/microsoft/vscode-pull-request-github/issues/3371)

In the file src/github/credentials.ts

The following code block is required in the initialize function:

```
if (authProviderId === AuthProvider['github-enterprise']) {
	getAuthSessionOptions = { ...getAuthSessionOptions, ...{ createIfNone: true, silent: false } };
}
```

So

```
private async initialize(authProviderId: AuthProvider, getAuthSessionOptions?: vscode.AuthenticationGetSessionOptions): Promise<void> {
if (authProviderId === AuthProvider['github-enterprise']) {
	if (!hasEnterpriseUri()) {
		Logger.debug(`GitHub Enterprise provider selected without URI.`, 'Authentication');
		return;
	}
}
getAuthSessionOptions = { ...getAuthSessionOptions, ...{ createIfNone: false } };

let session;
```

Becomes

```
private async initialize(authProviderId: AuthProvider, getAuthSessionOptions?: vscode.AuthenticationGetSessionOptions): Promise<void> {
if (authProviderId === AuthProvider['github-enterprise']) {
	if (!hasEnterpriseUri()) {
		Logger.debug(`GitHub Enterprise provider selected without URI.`, 'Authentication');
		return;
	}
}
getAuthSessionOptions = { ...getAuthSessionOptions, ...{ createIfNone: false } };

if (authProviderId === AuthProvider['github-enterprise']) {
	getAuthSessionOptions = { ...getAuthSessionOptions, ...{ createIfNone: true, silent: false } };
}

let session;
```

> Requirements

- VSCode >=1.67

> Setup
> The official setup instructions are specified in the [wiki](https://github.com/microsoft/vscode-pull-request-github/issues/3371)

1. Create a GitHub Enterprise [Personal Access Token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/creating-a-personal-access-token) with the following scopes
   - repo
   - workflow
   - read:user
   - user:email
2. In VSCode Settings Set `Github-enterprise: Uri` to your company's github uri e.g: 'https://github3.abcd-comp.com'
3. Download the extension from [releases](https://github.com/jpspringall/vscode-pull-request-github/releases)
4. Install the extension via the `Install from VSIX` ... menu from the VSCode Extensions Panel
5. Restart VSCode
6. It should then ask "The extension 'GitHub Pull Requests and Issues' wants to sign in using **GitHub Enterprise.**"
   - Select Allow
   - It will then prompt for the Personal Access Token created in Step 1
7. Restart VSCode
8. GitHub Enterprise should now be sucessfully configured

> Build it yourself

While I believe I have been transparent with regards to changes made I understand you may wish to build the extension yourself

1. Follow the initial [Build and Run](https://github.com/Microsoft/vscode-pull-request-github/wiki/Contributing#build-and-run) instructions
   - Node version 14 is required to build the VSIX, rather than node >=10 as stated
2. Clone the microsoft repository
3. If you working from `main`
   - At the time of writing VSCode >=v1.68 is required
   - So you will need to use the VSCode Insiders build
   - So you may consider using a Node Version Manager
4. Make the code change described above
5. Run the following commands in your cloned repository root folder
   - yarn # Installation of node_modules
   - yarn bundle # Building of the extension
   - yarn package # Packaging of the extension as VSIX
6. If all goes well you should now have a .VSIX in the root of your repository
7. You can now carry on from step 4) of setup
