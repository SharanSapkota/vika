// Tests redact(): each kind of secret is replaced, everything else is left alone.
import { describe, expect, it } from "vitest";
import { redact } from "../src/redaction/redact-sensitive-text.js";

const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

describe("redact", () => {
  it("replaces emails", () => {
    expect(redact("sent receipt to jane.doe+shop@mail.example.co.uk ok")).toBe("sent receipt to <email> ok");
  });

  it("replaces JWTs and bearer tokens", () => {
    expect(redact(`token=${JWT}`)).toBe("token=<token>");
    expect(redact("Authorization: Bearer abc123.def-456_ghi")).toBe("Authorization: Bearer <token>");
    expect(redact(`authorization: bearer ${JWT}`)).toBe("authorization: bearer <token>");
  });

  it("replaces IPv4 addresses", () => {
    expect(redact("client 203.0.113.9, upstream 10.0.0.12:8080")).toBe("client <ip>, upstream <ip>:8080");
  });

  it("replaces IPv6 addresses", () => {
    expect(redact("from 2001:0db8:85a3:0000:0000:8a2e:0370:7334 x")).toBe("from <ip> x");
    expect(redact("from 2001:db8::1 x")).toBe("from <ip> x");
    expect(redact("ip=::1 mapped=::ffff:192.0.2.128")).toBe("ip=<ip> mapped=<ip>");
    expect(redact("peer fe80::1ff:fe23:4567:890a closed")).toBe("peer <ip> closed");
  });

  it("replaces card-like numbers", () => {
    expect(redact("card 4111 1111 1111 1111 declined")).toBe("card <card> declined");
    expect(redact("card 4111-1111-1111-1111")).toBe("card <card>");
    expect(redact("card 4111111111111111.")).toBe("card <card>.");
    expect(redact("amex 3782 822463 10005")).toBe("amex <card>");
  });

  it("leaves text with no secrets unchanged", () => {
    const clean = [
      "2026-03-06T14:04:07.312Z ERROR [api] POST /api/orders failed user=u_48818",
      "TypeError: Cannot read properties of undefined (reading 'amount')",
      "    at createOrder (/app/src/orders/service.ts:20:22)",
      "request_id=b6f3dd1a-9f2e-48fc-b778-86bda6a59506 took 1234ms at 14:04:07",
      "DB timeout after 5000ms, version 1.2.3, order 1234567890123 (not a card)",
      "std::vector<int> and a @mention",
    ].join("\n");
    expect(redact(clean)).toBe(clean);
  });
});

describe("redact with a chosen list of kinds", () => {
  const MESSAGE = `user jane@example.com from 203.0.113.9 paid with 4111 1111 1111 1111 using ${JWT}`;
  const FULLY_REDACTED = "user <email> from <ip> paid with <card> using <token>";

  it("redacts all four kinds by default", () => {
    expect(redact(MESSAGE)).toBe(FULLY_REDACTED);
    expect(redact(MESSAGE, ["email", "jwt", "ip", "cardlike"])).toBe(FULLY_REDACTED);
  });

  it("turns each kind on and off on its own", () => {
    expect(redact(MESSAGE, ["jwt", "ip", "cardlike"])).toBe("user jane@example.com from <ip> paid with <card> using <token>");
    expect(redact(MESSAGE, ["email", "ip", "cardlike"])).toBe(`user <email> from <ip> paid with <card> using ${JWT}`);
    expect(redact(MESSAGE, ["email", "jwt", "cardlike"])).toBe("user <email> from 203.0.113.9 paid with <card> using <token>");
    expect(redact(MESSAGE, ["email", "jwt", "ip"])).toBe("user <email> from <ip> paid with 4111 1111 1111 1111 using <token>");
    expect(redact(MESSAGE, ["email"])).toBe(`user <email> from 203.0.113.9 paid with 4111 1111 1111 1111 using ${JWT}`);
  });

  it('counts bearer tokens as "jwt"', () => {
    expect(redact("Authorization: Bearer abc123.def-456_ghi", ["email"])).toBe("Authorization: Bearer abc123.def-456_ghi");
    expect(redact("Authorization: Bearer abc123.def-456_ghi", ["jwt"])).toBe("Authorization: Bearer <token>");
  });
});
