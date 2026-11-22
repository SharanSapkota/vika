// Reads the exception class name ("TypeError", "java.io.IOException") from a message.

export function readExceptionType(message: string): string | undefined {
  const exceptionMatch = /^([\w$.]*(?:Error|Exception))(?::|$)/m.exec(message);
  return exceptionMatch?.[1];
}
