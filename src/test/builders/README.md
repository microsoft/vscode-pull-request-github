# Builders

Writing tests that rely on API results is painful, repetitive, and noisy. Both the GraphQL and REST APIs return objects with many properties that must be populated, but which have no impact on the behavior of a given test case. Needing to specify _everything_ by hand for each result makes the test difficult to read and obscures the bits of the API responses that are actually relevant. Furthermore, if a field is ever added to an API response, updating every copy-and-pasted occurrence of that response within the test suite is tedious and error-prone.

To address this, we use an implementation of [the builder pattern](https://en.wikipedia.org/wiki/Builder_pattern) to construct mock responses. This includes type safety to ensure that the mock objects we construct are consistent with the response types of the real API, recursive construction to operate on deeply nested object structures (like GraphQL responses), and a metaprogramming framework to concisely specify builder classes.

The guts of the builder implementation lives in [this directory](base.ts). Specifications for individual builders may be found in modules within the [`rest/`](rest) and [`graphql`](graphql) subdirectories.

## Using builders

Let's say we have responses with types that match these interfaces:

```ts
interface User {
	login: string;
	avatarUrl: string;
}

interface Repository {
	owner: User;
	name: string;
	viewerCanAdmin: boolean;
}

interface PullRequest {
	number: number;
	title: string;
	description: string;
	author: User;
	head: Repository; // Yeah, these are Refs in the real schema.
	base: Repository;
}
```

Say the builders for these types already existing in `src/test/builders/example/{user,repository,pullRequest}Builder.ts` modules. We may construct mocked responses for tests using the builders like so:

```ts
import { PullRequestBuilder } from '../builders/example/pullRequestBuilder';

describe('Some model that uses PullRequest responses', function () {
	it('does something based on the PR number and title', function () {
		// PullRequestBuilder has a fluent interface with a setter method corresponding to each
		// property of the PullRequest interface. Its .build() method returns a fully-constructed
		// PullRequest object.
		const pr = new PullRequestBuilder().number(1234).title('This is the title').build();

		// The fields we populated directly will be set to the values we gave them.
		assert.strictEqual(pr.number, 1234);
		assert.strictEqual(pr.title, 'This is the title');

		// Fields we didn't specify will be set to *some* valid value. This is guaranteed to be
		// the correct type, but we shouldn't rely on its value!
		assert(pr.description instanceof string);

		// This is true recursively within nested objects as well.
		assert(pr.author);
		assert(pr.author.login instanceof string);
	});

	it('needs to specify some deep property, like the owner of the base repository', function () {
		// Setter methods that construct other objects that have builders work a little differently.
		//
		// The "setter" for each instead accepts a function that will be called with an instance of
		// that type's builder. You can call setters on that builder to populate any fields that you
		// care about on that object. Then, the parent setter function will call "build()" for you
		// and set the field to the constructed instance.
		//
		// The type of the builder argument can be inferred from the setter function's signature,
		// which saves you from needing to import a builder for every nested type.
		const pr = new PullRequestBuilder()
			.base(b => {
				b.owner(o => o.login('someone'));
			})
			.build();

		assert.strictEqual(pr.base.owner.login, 'someone');

		// Unspecified fields within nested types are also constructed to some valid default value.
		assert(pr.base.owner.avatarUrl instanceof string);
	});
});
```

## Defining builders

To define new builder classes, or maintain existing ones, use the `createBuilderClass()` metaprogramming helper.

By convention, builder classes should be created within subdirectories of this one. Each subdirectory contains builders for one "category" of related, interdependent types, like GraphQL or REST API responses. Each builder class that is expected to be used independently is defined and exported by a separate module with a corresponding name (for ease of discovery).

Here's how we would specify builder classes for the example response types declared above:

```ts
// src/test/builders/example/userBuilder.ts

import { createBuilderClass } from '../base';
import { User } from '../../../../src/common/interfaces';

// "UserBuilder" is a dynamically generated JavaScript class that will construct "User" objects.
// The convention is to name a builder that constructs X instances as "XBuilder".
//
// Note that TypeScript will generate a compile-time error if:
// * The "User" type contains any properties not provided in the template object.
// * The type of a default value is not assignable to the corresponding "User" property.
//
// The odd double-function-call usage here is done so that the type of the template object may be
// inferred while explicitly specifying the <User> type parameter.
export const UserBuilder = createBuilderClass<User>()({
	login: { default: 'me' },
	avatarUrl: { default: 'https://avatars-r-us.com/me.jpg' },
});

// Exporting the instance type is useful in cases when you wish to create custom builders that reference
// generated ones in their type signatures, or refactor out functions that operate on a builder to set
// common fields.
export type UserBuilder = InstanceType<typeof UserBuilder>;
```

```ts
// src/test/builders/example/repositoryBuilder.ts

import { createBuilderClass } from '../base';
import { Repository } from '../../../../src/common/interfaces';

import { UserBuilder } from './userBuilder';

export const RepositoryBuilder = createBuilderClass<Repository>()({
	// A field that should be constructed by a different builder is specified as "{linked: BuilderClass}".
	//
	// The type constructed by UserBuilder is checked against the type of the "owner" field on Repository
	// at compile time. The template used to define UserBuilder in user.ts is used to construct a default
	// value for this field if unspecified.
	owner: { linked: UserBuilder },

	name: { default: 'some-default' },
	viewerCanAdmin: { default: false },
});

export type RepositoryBuilder = InstanceType<typeof RepositoryBuilder>;
```

```ts
// src/test/builders/example/pullRequestBuilder.ts

import { createBuilderClass } from '../base';
import { PullRequest } from '../../../../src/common/interfaces';

import { UserBuilder } from './userBuilder';
import { RepositoryBuilder } from './repositoryBuilder';

export const PullRequestBuilder = createBuilderClass<PullRequest>()({
	number: { default: 100 },
	title: { default: 'default title' },
	description: { default: 'default description' },
	author: { linked: UserBuilder },
	head: { linked: RepositoryBuilder },
	base: { linked: RepositoryBuilder },
});

export type PullRequestBuilder = InstanceType<typeof PullRequestBuilder>;
```

### createLink

Creating separate builder classes for each level of a deeply nested structure can still be tedious. In these situations, the `createLink()` function may be used to expedite the creation of intermediate builder classes for linked fields.

```ts
interface DeeplyNested {
	stepOne: {
		stepTwo: {
			stepThree: {
				attr: number;
			}
		}
	};
}

import { createBuilderClass, createLink } from '../base';

// You still need to name the intermediate types, unfortunately. I use type aliases to make this somewhat more concise.
type StepOne = DeeplyNested["stepOne"];
type StepTwo = StepOne["stepTwo"];
type StepThree = StepTwo["stepThree"];

// createLink() uses the same double-function-call signature to infer the type of its template correctly.
export const DeeplyNestedBuilder = createBuilderClass<DeeplyNested>()({
	stepOne: createLink<StepOne>()({
		stepTwo: createLink<StepTwo>()({
			stepTwo: createLink<StepThree>(){
				attr: {default: 10},
			},
		}),
	});
});
```
