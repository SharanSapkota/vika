export function isAboveNoise(observed: number, expected: number): boolean {
  return observed > expected + 3 * Math.sqrt(expected);
}
