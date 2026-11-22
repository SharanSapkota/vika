

import type { BodySection } from "../ticketing/ticket-types.js";

interface AdfTextNode {
  type: "text";
  text: string;
}
type AdfNode =
  | { type: "heading"; attrs: { level: number }; content: AdfTextNode[] }
  | { type: "paragraph"; content: AdfTextNode[] }
  | { type: "bulletList"; content: { type: "listItem"; content: AdfNode[] }[] };

export interface AdfDocument {
  type: "doc";
  version: 1;
  content: AdfNode[];
}


const toTextNodes = (text: string): AdfTextNode[] => (text === "" ? [] : [{ type: "text", text }]);


function linesToNodes(lines: string[]): AdfNode[] {
  const nodes: AdfNode[] = [];
  for (const line of lines) {
    if (line.startsWith("- ")) {
      const item = { type: "listItem" as const, content: [{ type: "paragraph" as const, content: toTextNodes(line.slice(2)) }] };
      const lastNode = nodes.at(-1);
      if (lastNode?.type === "bulletList") lastNode.content.push(item);
      else nodes.push({ type: "bulletList", content: [item] });
    } else if (line !== "") {
      nodes.push({ type: "paragraph", content: toTextNodes(line) });
    }
  }
  return nodes;
}

export function sectionsToAdf(sections: BodySection[]): AdfDocument {
  return {
    type: "doc",
    version: 1,
    content: sections.flatMap((section) => [
      { type: "heading" as const, attrs: { level: 3 }, content: toTextNodes(section.heading) },
      ...linesToNodes(section.lines),
    ]),
  };
}

export function textToAdf(text: string): AdfDocument {
  return { type: "doc", version: 1, content: linesToNodes(text.split("\n")) };
}
