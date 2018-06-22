const gulp = require('gulp');
const ts = require('gulp-typescript');
const typescript = require('typescript');
const del = require('del');
const mocha = require('gulp-mocha');
const gutil = require('gulp-util');

const tsProject = ts.createProject('tsconfig.json', { typescript });

gulp.task('build', ['clean'], () => {
	const result = gulp.src("src/**/*.ts")
		.pipe(tsProject());

	return result.js.pipe(gulp.dest('out'));
});

gulp.task('clean', () => {
	return del(['out']);
});

gulp.task('mocha', ['build'], () => {
	return gulp.src(['out/test/**/*.js'], { read: false })
		.pipe(mocha({ reporter: 'list' }))
		.on('error', gutil.log);
});

gulp.task('default', ['mocha']);