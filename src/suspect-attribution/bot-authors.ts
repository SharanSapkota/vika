
const BOT_MARKERS = ["dependabot", "renovate", "github-actions", "[bot]"];

export function isBotAuthor(name: string, email: string): boolean {
  const nameAndEmail = `${name} ${email}`.toLowerCase();
  return BOT_MARKERS.some((marker) => nameAndEmail.includes(marker));
}
