// Small helpers for reading Python source lines.

// Replaces string literals (with any r/b/u/f prefix) by "" and drops "#"
// comments, so names, brackets and colons inside them are not read as code.
export function removePythonStringsAndComments(line: string): string {
  return line.replace(/\b[rRbBuUfF]{0,2}(["'])(?:\\.|(?!\1)[^\\])*\1/g, '""').replace(/#.*$/, "");
}

export function measureIndentation(line: string): number {
  return /^\s*/.exec(line)![0].length;
}
