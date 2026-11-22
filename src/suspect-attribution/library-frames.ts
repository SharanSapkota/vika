



const PYTHON_LIBRARY_PATH = /(?:^|\/)(?:site-packages|dist-packages)\/|(?:^|\/)lib\/python\d+(?:\.\d+)?\/|^<[^>]*>$/;

export function isPythonLibraryFrame(framePath: string): boolean {
  return PYTHON_LIBRARY_PATH.test(framePath);
}
