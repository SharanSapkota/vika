// Replaces secrets and personal data in a log message with placeholders,
// so raw values are never stored.
import { redactIps } from "./redact-ip-addresses.js";
import { ALL_REDACTION_KINDS, type RedactionKind } from "./redaction-kinds.js";

const JSON_WEB_TOKEN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

const BEARER_TOKEN = /\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi;

const EMAIL_ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

const CARD_NUMBER = /(?<!\d)(?:\d{4}([ -])\d{4}\1\d{4}\1\d{4}|\d{4}([ -])\d{6}\2\d{5}|\d{13,19})(?!\d)/g;

// The Luhn checksum real card numbers pass. Checking it keeps ordinary long
// numbers (order ids, timestamps) from being hidden as cards.
function passesLuhnCheck(digits: string): boolean {
  let sum = 0;
  for (let positionFromRight = 0; positionFromRight < digits.length; positionFromRight++) {
    let digit = Number(digits[digits.length - 1 - positionFromRight]);
    if (positionFromRight % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

// Redacts the given kinds (default: all four, the safe choice). The order
// matters: tokens and emails go before IPs and card numbers, so digits
// inside them are never mistaken for an IP or a card.
export function redact(text: string, kinds: readonly RedactionKind[] = ALL_REDACTION_KINDS): string {
  let redactedText = text;
  if (kinds.includes("jwt")) redactedText = redactedText.replace(JSON_WEB_TOKEN, "<token>").replace(BEARER_TOKEN, "$1 <token>");
  if (kinds.includes("email")) redactedText = redactedText.replace(EMAIL_ADDRESS, "<email>");
  if (kinds.includes("ip")) redactedText = redactIps(redactedText);
  if (kinds.includes("cardlike")) {
    redactedText = redactedText.replace(CARD_NUMBER, (match) => (passesLuhnCheck(match.replace(/[ -]/g, "")) ? "<card>" : match));
  }
  return redactedText;
}
