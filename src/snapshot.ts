// Incremental diffing of AI-mode ARIA snapshots.
//
// Playwright keeps an element's ref stable across snapshots of the same document, so a
// ref identifies "the same node" between two snapshots. A node is omitted from the diff
// when its whole subtree text (refs included) is identical to the previous snapshot, which
// means anything omitted is exactly what the model already saw.

interface SnapshotNode {
  raw: string;
  indent: number;
  ref?: string;
  children: SnapshotNode[];
  text: string;
}

const REF_RE = /\[ref=([^\]\s]+)\]/;
const MAX_REMOVED_LISTED = 20;
const MAX_REMOVED_SUMMARY = 120;

function parseSnapshot(yaml: string): SnapshotNode[] {
  const root: SnapshotNode = { raw: "", indent: -1, children: [], text: "" };
  const stack: SnapshotNode[] = [root];

  for (const raw of yaml.split("\n")) {
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    const node: SnapshotNode = { raw, indent, ref: REF_RE.exec(raw)?.[1], children: [], text: "" };
    while (stack[stack.length - 1].indent >= indent) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }

  const fillText = (node: SnapshotNode): string => {
    node.text = [node.raw.trimStart(), ...node.children.map(fillText)].join("\n");
    return node.text;
  };
  root.children.forEach(fillText);
  return root.children;
}

function indexByRef(
  nodes: SnapshotNode[],
  parentRef: string | undefined,
  index: Map<string, { node: SnapshotNode; parentRef?: string }>
): void {
  for (const node of nodes) {
    if (node.ref) index.set(node.ref, { node, parentRef });
    indexByRef(node.children, node.ref ?? parentRef, index);
  }
}

/** One-line description of a removed subtree, e.g. `- listitem [ref=e6]: Bob | button "删除" [ref=e7]`. */
function summarize(node: SnapshotNode): string {
  const parts = node.text
    .split("\n")
    .map((line) => line.trim().replace(/^- /, "").replace(/:$/, "").replace(/^text: /, ""));
  const summary = `- ${parts[0]}${parts.length > 1 ? `: ${parts.slice(1).join(" | ")}` : ""}`;
  return summary.length > MAX_REMOVED_SUMMARY ? `${summary.slice(0, MAX_REMOVED_SUMMARY)}…` : summary;
}

function pushSubtree(node: SnapshotNode, out: string[]): void {
  out.push(node.raw);
  for (const child of node.children) pushSubtree(child, out);
}

/**
 * Returns the lines of `next` that differ from `prev`: new or changed nodes, plus the
 * header lines of their ancestors so the hierarchy stays readable. Removed nodes are
 * listed separately. Returns an empty string when nothing changed.
 */
export function diffSnapshots(prev: string, next: string): string {
  const prevIndex = new Map<string, { node: SnapshotNode; parentRef?: string }>();
  indexByRef(parseSnapshot(prev), undefined, prevIndex);

  const nextRoots = parseSnapshot(next);
  const nextIndex = new Map<string, { node: SnapshotNode; parentRef?: string }>();
  indexByRef(nextRoots, undefined, nextIndex);

  const out: string[] = [];
  const emit = (node: SnapshotNode): void => {
    const before = node.ref ? prevIndex.get(node.ref)?.node : undefined;
    if (node.ref && !before) {
      pushSubtree(node, out);
      return;
    }
    if (before && before.text === node.text) return;

    out.push(node.raw);
    // Ref-less children (text, options, /url props) can't be matched by identity, so
    // compare them by content and only print the ones that weren't there before.
    const previousLeaves = new Map<string, number>();
    for (const child of before?.children ?? []) {
      if (!child.ref) previousLeaves.set(child.text, (previousLeaves.get(child.text) ?? 0) + 1);
    }
    for (const child of node.children) {
      if (child.ref) {
        emit(child);
        continue;
      }
      const remaining = previousLeaves.get(child.text) ?? 0;
      if (remaining > 0) previousLeaves.set(child.text, remaining - 1);
      else pushSubtree(child, out);
    }
  };
  nextRoots.forEach(emit);

  // Only report the top-most removed node of each removed subtree.
  const removed: string[] = [];
  for (const [ref, { node, parentRef }] of prevIndex) {
    if (nextIndex.has(ref)) continue;
    if (parentRef && !nextIndex.has(parentRef)) continue;
    removed.push(summarize(node));
  }
  if (removed.length > 0) {
    const listed = removed.slice(0, MAX_REMOVED_LISTED);
    const more = removed.length - listed.length;
    out.push("", "Removed:", ...listed, ...(more > 0 ? [`... and ${more} more`] : []));
  }

  return out.join("\n");
}
