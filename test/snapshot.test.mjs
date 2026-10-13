import { test } from "node:test";
import assert from "node:assert/strict";
import { diffSnapshots } from "../dist/snapshot.js";

const before = `- generic [ref=e1]:
  - list [ref=e3]:
    - listitem [ref=e4]:
      - text: Alice
      - button "删除" [ref=e5]
    - listitem [ref=e6]:
      - text: Bob
      - button "删除" [ref=e7]
  - button "Save" [ref=e8]
  - paragraph [ref=e9]: idle`;

test("identical snapshots produce an empty diff", () => {
  assert.equal(diffSnapshots(before, before), "");
});

test("removed subtree is reported once with its content", () => {
  const after = before.replace(/    - listitem \[ref=e6\]:\n.*\n.*\n/, "");
  const diff = diffSnapshots(before, after);
  assert.match(diff, /Removed:\n- listitem \[ref=e6\]: Bob \| button "删除" \[ref=e7\]$/);
  assert.doesNotMatch(diff, /Removed:[\s\S]*ref=e7\]\n/, "descendants of a removed node are not listed separately");
});

test("changed node is shown with its ancestors, unchanged siblings are omitted", () => {
  const after = before.replace("paragraph [ref=e9]: idle", "paragraph [ref=e9]: Loaded 42 rows");
  assert.equal(diffSnapshots(before, after), `- generic [ref=e1]:\n  - paragraph [ref=e9]: Loaded 42 rows`);
});

test("new node is shown with its whole subtree", () => {
  const after = before.replace(
    '  - button "Save" [ref=e8]',
    '  - dialog "Saved" [ref=e10]:\n    - button "OK" [ref=e11]\n  - button "Save" [ref=e8]'
  );
  assert.equal(diffSnapshots(before, after), `- generic [ref=e1]:\n  - dialog "Saved" [ref=e10]:\n    - button "OK" [ref=e11]`);
});
