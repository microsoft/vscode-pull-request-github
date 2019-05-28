export interface ScalarFieldTemplate<F> {
	default: F;
}

export interface LinkedFieldTemplate<F, T extends Template<F>> {
	linked: BuilderClass<F, T>;
}

type FieldTemplate<F, T extends Template<F>> = ScalarFieldTemplate<F> | LinkedFieldTemplate<F, T>;

function isLinked<F, T extends Template<F>>(fieldTemplate: FieldTemplate<F, T>): fieldTemplate is LinkedFieldTemplate<F, T> {
	return (fieldTemplate as LinkedFieldTemplate<F, T>).linked !== undefined;
}

export type Template<R> = {
	[P in keyof R]: FieldTemplate<R[P], Template<R[P]>>;
};

type LinkedSetterFn<F, T extends Template<F>, Self> = (block: (builder: Builder<F, T>) => any) => Self;

type ScalarSetterFn<F, Self> = (value: F) => Self;

type SetterFn<RF, TF, Self> = TF extends LinkedFieldTemplate<any, infer ST> ? LinkedSetterFn<RF, ST, Self> : ScalarSetterFn<RF, Self>;

export type Builder<R, T extends Template<R>> = {
	[P in keyof R]: SetterFn<R[P], T[P], Builder<R, T>>;
} & {
	build: () => R;
};

type BuilderClass<R, T extends Template<R>> = {
	new(): Builder<R, T>;
};

abstract class BaseBuilder<R> {
	private _underConstruction: Partial<R>;

	constructor(private _template: Template<R>) {
		this._underConstruction = {};
	}

	build(): R {
		// Populate any missing fields
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

		return this._underConstruction as R;
	}
}

export function createBuilderClass<R>() {
	return <T extends Template<R>>(template: T): BuilderClass<R, T> => {
		// This <any> cast is safe because the template loop below is guaranteed to populate setter and sub-builder methods
		// for each keyof R.
		const DynamicBuilder: BuilderClass<R, T> = class extends BaseBuilder<R> {
			constructor() {
				super(template);
			}
		} as any;

		function defineScalarSetter<F, N extends keyof T>(fieldName: N) {
			DynamicBuilder.prototype[fieldName] = function (value: F) {
				this._underConstruction[fieldName] = value;
				return this;
			};
		}

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

export function createLink<R>(): <T extends Template<R>>(template: T) => LinkedFieldTemplate<R, T> {
	return <T extends Template<R>>(template: T) => ({linked: createBuilderClass<R>()(template)});
}