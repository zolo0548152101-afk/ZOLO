import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/http.ts", import.meta.url), "utf8");

test("every admin clear-all UI request sends the exact server confirmation", () => {
  assert.doesNotMatch(source, /database\/clear-all[\s\S]{0,300}confirm:true/);
  assert.match(source, /database\/clear-all[\s\S]{0,300}confirm:phrase/);
  assert.match(source, /database\/clear-all[\s\S]{0,300}confirm:'מחק הכל'/);
});
