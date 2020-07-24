import { createBuilderClass, createLink } from './builders/base';
import assert = require('assert');

interface IGrandChild {
	attr: number;
}

const GrandChildBuilder = createBuilderClass<IGrandChild>()({
	attr: { default: 10 },
});

interface IChild {
	name: string;
	grandchild: IGrandChild;
}

const ChildBuilder = createBuilderClass<IChild>()({
	name: { default: '' },
	grandchild: { linked: GrandChildBuilder },
});

const b = new ChildBuilder();
b.grandchild((gc) => gc.attr(20));

interface IParent {
	aStringProp: string;
	aNumberProp: number;
	aBooleanProp: boolean;
	aChildProp: IChild;
}

const ParentBuilder = createBuilderClass<IParent>()({
	aStringProp: { default: 'abc' },
	aNumberProp: { default: 123 },
	aBooleanProp: { default: true },
	aChildProp: { linked: ChildBuilder },
});

describe('Builders', function () {
	it('creates setter methods for each field', function () {
		const parent = new ParentBuilder()
			.aStringProp('def')
			.aNumberProp(456)
			.aBooleanProp(false)
			.aChildProp((child) => {
				child.name('non-default');
				child.grandchild((gc) => {
					gc.attr(5);
				});
			})
			.build();

		assert.strictEqual(parent.aStringProp, 'def');
		assert.strictEqual(parent.aNumberProp, 456);
		assert.strictEqual(parent.aBooleanProp, false);
		assert.strictEqual(parent.aChildProp.name, 'non-default');
		assert.strictEqual(parent.aChildProp.grandchild.attr, 5);
	});

	it('uses default values for unspecified fields', function () {
		const parent = new ParentBuilder()
			.aNumberProp(1000)
			.build();

		assert.strictEqual(parent.aStringProp, 'abc');
		assert.strictEqual(parent.aNumberProp, 1000);
		assert.strictEqual(parent.aBooleanProp, true);
		assert.strictEqual(parent.aChildProp.name, '');
		assert.strictEqual(parent.aChildProp.grandchild.attr, 10);
	});

	it('generates inline child builders with createLink()', function () {
		interface IInline {
			stringProp: string;
			child: {
				numberProp: number;
				grandchild: {
					boolProp: boolean;
				}
			};
		}

		const InlineBuilder = createBuilderClass<IInline>()({
			stringProp: { default: 'abc' },
			child: createLink<IInline['child']>()({
				numberProp: { default: 123 },
				grandchild: createLink<IInline['child']['grandchild']>()({
					boolProp: { default: true }
				})
			})
		});

		const inline = new InlineBuilder()
			.stringProp('def')
			.child(c => {
				c.numberProp(123);
				c.grandchild(g => g.boolProp(false));
			})
			.build();

		assert.strictEqual(inline.stringProp, 'def');
		assert.strictEqual(inline.child.numberProp, 123);
		assert.strictEqual(inline.child.grandchild.boolProp, false);
	});
});
