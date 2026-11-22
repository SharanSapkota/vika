



export function removePythonStringsAndComments(line: string): string {
  return line.replace(/\b[rRbBuUfF]{0,2}(["'])(?:\\.|(?!\1)[^\\])*\1/g, '""').replace(/#.*$/, "");
}

export function measureIndentation(line: string): number {
  return /^\s*/.exec(line)![0].length;
}
