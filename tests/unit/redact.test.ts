import { describe, expect, it } from "vitest";
import { base, redact, trunc } from "@/lib/bridge/redact";

describe("redact (prd.md §8.4)", () => {
  const cases: [string, string][] = [
    // The authorization: rule eats the word "Bearer" first; the secret is still hidden (prototype behavior).
    ["curl -H 'Authorization: Bearer abc.def-123' x", "curl -H 'Authorization: *** ***' x"],
    ["bearer eyJhbGciOi.J9.x+y/z=", "bearer ***"],
    ["https://x.io/?token=abc123&x=1", "https://x.io/?token=***"],
    ["export API_KEY=sk-live-123", "export API_KEY=***"],
    ["api-key: 'quoted secret here'", "api-key: ***"],
    ['password="hunter 2" next', "password=*** next"],
    ["passwd=pw pwd=pw2", "passwd=*** pwd=***"],
    ["SECRET: s3cr3t", "SECRET: ***"],
    ["use sk-ant-REDACTEDREDACTED01 now", "use *** now"],
    ["ghp_abcdefghijklmnop1234", "***"],
    ["xoxb-1234567890-abc", "***"],
    ["gho_shortkey", "gho_shortkey"],
    ["nothing secret here", "nothing secret here"],
  ];
  it.each(cases)("%s", (input, want) => {
    expect(redact(input)).toBe(want);
  });
  it("mysql -p only when mysql follows on the line", () => {
    expect(redact("mysqldump -pXYZ db | mysql x")).toBe("mysqldump -p*** db | mysql x");
    expect(redact("grep -pfoo file")).toBe("grep -pfoo file");
  });
  // KNOWN GAP in the prototype regex: `-p<pw>` is only hidden when the word mysql comes AFTER it.
  // Kept for M1 parity; fix proposed to the user (plan-m1.md, "Usulan perbaikan").
  it.fails("mysql -p<password> after the mysql word is hidden", () => {
    expect(redact("mysql -u root -pS3cret db")).toBe("mysql -u root -p*** db");
  });
  it("tricky: several secrets in one command", () => {
    const out = redact("TOKEN=a1 curl -H 'authorization: Bearer zz9' https://h/?api_key=k&secret=s ghp_0123456789abcdef");
    expect(out).not.toMatch(/a1|zz9|=k|=s\b|ghp_0123/);
  });
  it("null-ish input", () => {
    expect(redact(undefined)).toBe("");
    expect(redact(null)).toBe("");
  });
});

describe("trunc / base", () => {
  it("collapses whitespace and truncates with ellipsis", () => {
    expect(trunc("  a \n  b  ", 10)).toBe("a b");
    expect(trunc("abcdefghij", 5)).toBe("abcd…");
    expect(trunc(null, 5)).toBe("");
  });
  it("basename", () => {
    expect(base("/home/u/repo/src/auth.go")).toBe("auth.go");
    expect(base("")).toBe("");
    expect(base(undefined)).toBe("");
  });
});
