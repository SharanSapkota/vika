import { open } from "node:fs/promises";

export interface FileBookmark {
  offset: number;
  inode: number;
}

export interface FileReadResult {
  lines: string[];
  next: FileBookmark;
}

export async function readFile(path: string, bookmark?: FileBookmark): Promise<FileReadResult> {
  const handle = await open(path, "r");
  try {
    const fileStats = await handle.stat();
    const isSameFile = bookmark !== undefined && bookmark.inode === fileStats.ino && bookmark.offset <= fileStats.size;
    const startOffset = isSameFile ? bookmark.offset : 0;
    const byteCount = fileStats.size - startOffset;
    if (byteCount <= 0) return { lines: [], next: { offset: startOffset, inode: fileStats.ino } };

    const buffer = Buffer.alloc(byteCount);
    const { bytesRead } = await handle.read(buffer, 0, byteCount, startOffset);
    const newBytes = buffer.subarray(0, bytesRead);

    const lastNewline = newBytes.lastIndexOf(0x0a);
    if (lastNewline === -1) return { lines: [], next: { offset: startOffset, inode: fileStats.ino } };

    const lines = newBytes
      .subarray(0, lastNewline)
      .toString("utf8")
      .split("\n")
      .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
    return { lines, next: { offset: startOffset + lastNewline + 1, inode: fileStats.ino } };
  } finally {
    await handle.close();
  }
}
