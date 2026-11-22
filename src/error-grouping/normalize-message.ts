import { redactIps } from "../redaction/redact-ip-addresses.js";

export const NORMALIZER_VERSION = 1;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const HEX_NUMBER = /(?<![0-9A-Za-z])(?:0x[0-9a-f]+|(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,})(?![0-9A-Za-z])/gi;

const QUERY = /\?[\w.%[\]-]+=[^\s"'#)]*/g;

const PATH_SEGMENT = /(?<=\/)[\w.~<>-]+(?=[/?#\s"'),;:\]]|$)/g;

const NUMBER = /(?<![A-Za-z\d.])\d+(?:\.\d+)?/g;

const PLACEHOLDER = /^<(?:uuid|hex|id|num|ip|email|token|card|query)>$/;

function maskPathSegment(segment: string): string {
  if (PLACEHOLDER.test(segment)) return segment;
  if (/^\d+$/.test(segment)) return "<id>";
  if (segment.length >= 6 && /\d|<\w+>/.test(segment) && !/\.\w{1,4}$/.test(segment)) return "<id>";
  return segment;
}

export function normalize(message: string): string {
  let text = message.replace(UUID, "<uuid>");
  text = text.replace(HEX_NUMBER,"<hex>");
  text = redactIps(text);
  text = text.replace(QUERY, "?<query>");
  text = text.replace(PATH_SEGMENT, maskPathSegment);
  text = text.replace(NUMBER, "<num>");
  return text;
}
