export const simpleDiff = `diff --git a/src/file.ts b/src/file.ts
index 1234567..abcdefg 100644
--- a/src/file.ts
+++ b/src/file.ts
@@ -1,4 +1,4 @@
 export function hello() {
-  console.log('hello');
+  console.log('hello world');
 }`

export const diffHeaders = `diff --git a/package.json b/package.json
index 1111111..2222222 100644
--- a/package.json
+++ b/package.json
@@ -1,5 +1,5 @@
 {
   "name": "test"
 }`;

export const diffNoAts = `diff --git a/file.txt b/file.txt
index 1234567..abcdefg 100644
--- a/file.txt
+++ b/file.txt`;