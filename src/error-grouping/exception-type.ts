
export function readExceptionType(message: string): string | undefined {
  const exceptionMatch = /^([\w$.]*(?:Error|Exception))(?::|$)/m.exec(message);
  return exceptionMatch?.[1];
}
