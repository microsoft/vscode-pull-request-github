# Local ESLint Rules

This directory contains custom ESLint rules specific to this repository.

## public-methods-well-defined-types

This rule enforces that public methods in exported classes return well-defined types (no inline types).

### Rule Details

- **Purpose**: Ensure public methods return named interfaces, types, or classes instead of inline object literals or anonymous types
- **Scope**: Applies only to `webviews/common/context.tsx`
- **Level**: Error

### Examples

**Incorrect** (will trigger the rule):
```typescript
export class MyClass {
	public badMethod(): { foo: string; bar: number } {
		return { foo: 'test', bar: 123 };
	}

	public badUnionMethod(): string | { error: string } {
		return 'test';
	}
}
```

**Correct** (will not trigger the rule):
```typescript
interface ResultType {
	foo: string;
	bar: number;
}

export class MyClass {
	public goodMethod(): ResultType {
		return { foo: 'test', bar: 123 };
	}

	public goodPromiseMethod(): Promise<string> {
		return Promise.resolve('test');
	}

	// Private methods are not checked
	private privateMethod(): { foo: string } {
		return { foo: 'test' };
	}
}
```

### Configuration

To use this rule, include it in your ESLint configuration:

```javascript
const RULES_DIR = require('eslint-plugin-rulesdir');
RULES_DIR.RULES_DIR = './build/eslint-rules';

module.exports = {
	plugins: ['rulesdir'],
	rules: {
		'rulesdir/public-methods-well-defined-types': 'error'
	}
};
```

### Testing

Use `.eslintrc.context.js` to test the rule on the target file:

```bash
npx eslint --config .eslintrc.context.js webviews/common/context.tsx
```