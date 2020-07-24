/**
 * Metaprogramming-fu to implement a type-checked, recursive version of the builder pattern. See the README file in this directory for
 * documentation about usage. The comments in here are intended to provide guidance in understanding the implementation.
 *
 * This file is divided into two major sections. The first is devoted to defining types that are sufficiently expressive to capture the
 * shape of the dynamically generated {@link Builder} classes at compile time, and to lean on type inference to allow builder behavior
 * to be specified concisely and consistently. The second section is used to construct the {@link BuilderClass} prototypes at run-time
 * to match those types.
 *
 * Type parameter glossary:
 *
 * * `R`: Record. Type of the top-level object being constructed by the builder.
 * * `T`: Template. Type of an object whose structure reflects that of its corresponding Record. That is, for each property within a Record,
 *    its Template will have a FieldTemplate describing the behavior of that field.
 * * `F`: Field. Type of a single property within a Record. Note that the type of a field in one record is the record type of a sub-builder.
 * * `FT`: Field template. Type of a single property within a Template.
 * * `N`: Field name, usually acquired from a `keyof` expression. `F = R[N]` and `FT = T[N]` for some `N`.
 */

/**
 * {@link FieldTemplate} that describes a _scalar_ value; one that is initialized directly by a setter rather than constructed by a sub-builder.
 * The default value provided is used by the builder if this field's value is not explicitly set. The default value's type must be
 * assignable to the corresponding field in the buider's record type.
 *
 * @example
 * interface Example {
 *   prop0: number;
 *   prop1: string[];
 * }
 *
 * const ExampleBuilder = createBuilderClass<Example>()({
 *   prop0: {default: 123},
 *   prop1: {default: []},
 * });
 */
export interface ScalarFieldTemplate<F> {
	default: F;
}

/**
 * {@link FieldTemplate} that describes a _linked_ value; one that is constructed by a sub-builder. The builder class' record type must be
 * assignable to the corresponding field in this builder's record type. The default value of this linked field is the one described by
 * the default fields in its sub-builder's template.
 *
 * @example
 * interface Child {
 *   attr: number;
 * }
 *
 * const ChildBuilder = createBuilderClass<Child>()({
 *   attr: {default: 0},
 * });
 *
 * interface Example {
 *   child: Child;
 * }
 *
 * const ExampleBuilder = createBuilderClass<Example>()({
 *   child: {linked: ChildBuilder},
 * });
 */
export interface LinkedFieldTemplate<F, T extends Template<F>> {
	linked: BuilderClass<F, T>;
}

/**
 * Type union covering all available field template varieties.
 */
type FieldTemplate<F, T extends Template<F>> = ScalarFieldTemplate<F> | LinkedFieldTemplate<F, T>;

/**
 * User-defined type guard to statically distinguish between {@link FieldTemplate} varieties.
 *
 * @param fieldTemplate Instance of a field template from some template object.
 */
function isLinked<F, T extends Template<F>>(fieldTemplate: FieldTemplate<F, T>): fieldTemplate is LinkedFieldTemplate<F, T> {
	return (fieldTemplate as LinkedFieldTemplate<F, T>).linked !== undefined;
}

/**
 * Description of the way the generated builder should treat each property of a Record type `R`. For each property in the original
 * record type, its template contains a {@link FieldTemplate} of a matching type signature that indicates if this property
 * is a _scalar_ (and if so, its default value,) or a _linked_ field (and if so, the Builder class that should be used to construct
 * its value).
 *
 * Note that actual, useful Templates types are _subtypes_ of this one with either {@link ScalarFieldTemplate} or {@link LinkedFieldTemplate}
 * properties. That's important because otherwise, the TypeScript compiler can't identify which kind of {@link FieldTemplate} a specific
 * property is at compile time. Most type parameters that expect to operate on Templates are declared as `T extends Template<F>` to
 * preserve this information.
 */
export type Template<R> = {
	[P in keyof R]: FieldTemplate<R[P], Template<R[P]>>;
};

/**
 * {@link SetterFn|Setter function} used by a {@link Builder} to construct the value of a linked field with another kind of
 * {@link Builder}. Call these setter functions with a block that accepts the sub-builder as its first argument.
 *
 * @example
 * const parent = new ParentBuilder()
 *   .child((b) => {
 *     b.childProperty(123);
 *   })
 *   .build();
 */
type LinkedSetterFn<F, T extends Template<F>, Self> = (block: (builder: Builder<F, T>) => any) => Self;

/**
 * {@link SetterFn|Setter function} used by a {@link Builder} to populate a scalar field directly.
 *
 * @example
 * const example = new ExampleBuilder()
 *   .someProperty('abc')
 *   .build();
 */
type ScalarSetterFn<F, Self> = (value: F) => Self;

/**
 * Conditional type used to infer the call signature of a single setter function on a generated {@link Builder} type based on
 * the (compile-time) type of a {@link Template} property.
 */
type SetterFn<F, FT, Self> = FT extends LinkedFieldTemplate<any, infer T> ? LinkedSetterFn<F, T, Self> : ScalarSetterFn<F, Self>;

/**
 * Instance that progressively assembles an object of record type `R` as you call a sequence of {@link SetterFn|setter functions}.
 * When {@link #build} is called, any properties on the record that have not been explicitly initialized will be initialized to
 * their default values, as specified by the Builder's template type, and the completed record will be returned.
 *
 * Setter functions are implemented as a {@link https://en.wikipedia.org/wiki/Fluent_interface|fluent interface}.
 */
export type Builder<R, T extends Template<R>> = {
	/**
	 * Setter function used to explicitly populate a single property of the constructed record.
	 */
	[P in keyof R]: SetterFn<R[P], T[P], Builder<R, T>>;
} & {
	build: () => R;
};

/**
 * Class that constructs {@link Builder} instances for a specific record type `R`, according to a specific template `T`.
 */
type BuilderClass<R, T extends Template<R>> = {
	new(): Builder<R, T>;
};

/**
 * Abstract superclass containing behavior common to all {@link Builder|Builders} generated using {@link #createBuilderClass}.
 */
abstract class BaseBuilder<R> {
	private _underConstruction: Partial<R>;

	constructor(private _template: Template<R>) {
		this._underConstruction = {};
	}

	/**
	 * Complete the record under construction by populating any missing fields with the default values specified by this builder's
	 * {@link Template}, then return it.
	 */
	build(): R {
		// Populate any missing fields.
		for (const fieldName in this._template) {
			if (!(fieldName in this._underConstruction)) {
				const fieldTemplate: FieldTemplate<any, any> = this._template[fieldName];
				if (isLinked(fieldTemplate)) {
					const builder = new fieldTemplate.linked();
					this._underConstruction[fieldName] = builder.build();
				} else {
					this._underConstruction[fieldName] = fieldTemplate.default;
				}
			}
		}

		// This is the cast that binds the *compile-time* work up above to the *run-time* work done by `createBuilderClass` below.
		// TypeScript can't infer that it's safe; we need a cast to assert that, yes, `this_underConstruction` must be a complete
		// R record now.
		//
		// We can be certain that this cast is safe at runtime because:
		// * `this._template` is assignable to the type Template<R>.
		// * Template<R> contains (at least!) a FieldTemplate for each property within R.
		// * Each FieldTemplate is type-checked for consistency against its corresponding property in R. Scalar fields must have a
		//   default value that's assignable to the property type; linked fields must name a Builder class whose `build()` method
		//   returns a type that's assignable to the property type.
		// * The "for" loop above ensures that a property on `this._underConstruction` is populated for each property in
		//   `this._template`.
		// Thus, `this._underConstruction` must be assignable to type R after the loop completes.
		return this._underConstruction as R;
	}
}

/**
 * Create a {@link BuilderClass} that may be used to create {@link Builder|Builders} that progressively construct instances of
 * a record type `R` with a fluent interface.
 *
 * This function returns another function that should be called with a {@link Template|template object} that contains a
 * {@link FieldTemplate} for each property in the record type `R`. Each field template dictates the style of setter function
 * generated to populate that field's value on records under construction: {@link ScalarFieldTemplate|scalar fields}, specified
 * with `{ default: 'value' }`, create direct setter functions that accept the field's value directly;
 * {@link LinkedFieldTemplate|linked fields}, specified with `{ linked: SubBuilderClass }`, create functions that accept a
 * function to be called with an instance of the named sub-builder class.
 *
 * The function-returning-a-function style is used so that the record type parameter `R` may be specified explicitly, but the template
 * type parameter `T` may be inferred from its argument. If TypeScript supports
 * {@link https://github.com/Microsoft/TypeScript/issues/26242|partial type argument inference} we can simplify this to be a single
 * function call.
 *
 * @example
 * const ExampleBuilder = createBuilderClass<Example>()({
 *   someProperty: {default: 'the-default'},
 *   anotherProperty: {default: true},
 *   child: {linked: ChildBuilder},
 *   secondChild: {linked: ChildBuilder},
 * });
 *
 * const example = new ExampleBuilder()
 *   .someProperty('different')
 *   .build();
 */
export function createBuilderClass<R>() {
	return <T extends Template<R>>(template: T): BuilderClass<R, T> => {
		// This <any> cast is safe because the template loop below is guaranteed to populate setter and sub-builder methods
		// for each keyof R.
		const DynamicBuilder: BuilderClass<R, T> = class extends BaseBuilder<R> {
			constructor() {
				super(template);
			}
		} as any;

		// Dynamically construct a scalar setter function for a named field. This setter method's signature must match that
		// of ScalarSetterFn<F>.
		function defineScalarSetter<F, N extends keyof T>(fieldName: N) {
			DynamicBuilder.prototype[fieldName] = function (value: F) {
				this._underConstruction[fieldName] = value;
				return this;
			};
		}

		// Dynamically construct a linked setter function for a named field. This setter method's signature must match that
		// of LinkedSetterFn<F, T>.
		function defineLinkedSetter<F, N extends keyof T>(fieldName: N, builderClass: BuilderClass<F, Template<F>>) {
			DynamicBuilder.prototype[fieldName] = function (block: (builder: Builder<F, Template<F>>) => void) {
				const builder = new builderClass();
				block(builder);
				this._underConstruction[fieldName] = builder.build();
				return this;
			};
		}

		for (const fieldName in template) {
			const fieldTemplate = template[fieldName];
			if (isLinked(fieldTemplate)) {
				defineLinkedSetter(fieldName, fieldTemplate.linked);
			} else {
				defineScalarSetter(fieldName);
			}
		}

		return DynamicBuilder;
	};
}

/**
 * Concisely create a sub-builder class directly within the template provided to a parent builder. This is useful when dealing with
 * types that nest deeply and are only used once or are anonymous (for example: GraphQL responses).
 *
 * The function-returning-a-function style is used so that the record type parameter `R` may be specified explicitly, but the template
 * type parameter `T` may be inferred from its argument.
 *
 * @example
 *
 * interface Compound {
 *   attr: number;
 *   child: {
 *     subAttr: boolean;
 *   };
 * }
 *
 * const CompoundBuilder = createBuilderClass<Compound>()({
 *   attr: {default: 0},
 *   child: createLink<Compound["child"]>()({
 *     subAttr: {default: true},
 *   }),
 * });
 */
export function createLink<R>(): <T extends Template<R>>(template: T) => LinkedFieldTemplate<R, T> {
	return <T extends Template<R>>(template: T) => ({ linked: createBuilderClass<R>()(template) });
}