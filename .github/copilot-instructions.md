## General Guidelines
- **Follow the existing code style**: Use single quotes, semicolons, and 2-space indentation. See `.eslintrc.base.json` for detailed linting rules.
- **TypeScript**: Use modern TypeScript features. Prefer explicit types where clarity is needed, but do not over-annotate.
- **React/JSX**: Webviews use React-style JSX with custom factories (`vscpp`, `vscppf`).
- **Strictness**: Some strictness is disabled in `tsconfig.base.json` (e.g., `strictNullChecks: false`), but new code should avoid unsafe patterns.
- **Testing**: Place tests under `src/test`. Do not include test code in production files.
- **Localization**: Use `%key%` syntax for strings that require localization. See `package.nls.json`.

## Extension-Specific Practices
- **VS Code API**: Use the official VS Code API for all extension points. Register commands, views, and menus via `package.json`.
- **Configuration**: All user-facing settings must be declared in `package.json` under `contributes.configuration`.
- **Activation Events**: Only add new activation events if absolutely necessary.
- **Webviews**: Place webview code in the `webviews/` directory. Use the shared `common/` code where possible.
- **Commands**: Register new commands in `package.json` and implement them in `src/commands.ts` or a relevant module.
- **Logging**: Use the `Logger` utility for all logging purposes. Don't use console.log or similar methods directly.

## Specific Feature Practices
- **Commands**: When adding a new command, consider whether it should be available in the command palette, context menus, or both. Add the appropriate menu entries in `package.json` to ensure the command is properly included, or excluded (command palette), from menus.

## Pull Request Guidelines
- Never touch the yarn.lock file.
- Run `yarn run lint` and also `npm run hygiene` and fix any errors or warnings before submitting a PR.

---
_Last updated: 2025-06-20_
