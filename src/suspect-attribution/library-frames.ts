// Python frames from installed packages (site-packages, dist-packages), the
// standard library (/lib/python3.12/...) or Python itself (<frozen ...>,
// <string>). They stay in the stack trace and the fingerprint, but are
// never used as suspect evidence: that code is not in the customer's repo.
const PYTHON_LIBRARY_PATH = /(?:^|\/)(?:site-packages|dist-packages)\/|(?:^|\/)lib\/python\d+(?:\.\d+)?\/|^<[^>]*>$/;

export function isPythonLibraryFrame(framePath: string): boolean {
  return PYTHON_LIBRARY_PATH.test(framePath);
}
