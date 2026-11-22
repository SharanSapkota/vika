// Replaces IP addresses (v4 and v6) with <ip>. Used by redaction and by the
// error-grouping normalizer, so two messages that differ only by IP match.

// One IPv4 number: 0 to 255.
const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4_PATTERN = `${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}`;
const IPV4_ADDRESS = new RegExp(`(?<![\\d.])${IPV4_PATTERN}(?!\\d|\\.\\d)`, "g");

// One IPv6 group: 1 to 4 hex digits.
const HEX_GROUP = "[0-9A-Fa-f]{1,4}";
// Every way an IPv6 address can be written, with and without "::".
const IPV6_PATTERNS = [
  `::ffff:${IPV4_PATTERN}`,
  `(?:${HEX_GROUP}:){7}${HEX_GROUP}`,
  `(?:${HEX_GROUP}:){1,7}:`,
  `(?:${HEX_GROUP}:){1,6}:${HEX_GROUP}`,
  `(?:${HEX_GROUP}:){1,5}(?::${HEX_GROUP}){1,2}`,
  `(?:${HEX_GROUP}:){1,4}(?::${HEX_GROUP}){1,3}`,
  `(?:${HEX_GROUP}:){1,3}(?::${HEX_GROUP}){1,4}`,
  `(?:${HEX_GROUP}:){1,2}(?::${HEX_GROUP}){1,5}`,
  `${HEX_GROUP}:(?::${HEX_GROUP}){1,6}`,
  `:(?::${HEX_GROUP}){1,7}`,
].join("|");
const IPV6_ADDRESS = new RegExp(`(?<![0-9A-Za-z:])(?:${IPV6_PATTERNS})(?![0-9A-Za-z:])`, "g");

export function redactIps(text: string): string {
  return text.replace(IPV6_ADDRESS, "<ip>").replace(IPV4_ADDRESS, "<ip>");
}
