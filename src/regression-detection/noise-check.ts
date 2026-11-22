// Is this count clearly above what the baseline rate predicts? A simple
// Poisson-style test: more than expected + 3 standard deviations (the
// standard deviation of a Poisson count is the square root of its mean).
export function isAboveNoise(observed: number, expected: number): boolean {
  return observed > expected + 3 * Math.sqrt(expected);
}
