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
  describe("B2 extensions (approved 2026-11-03)", () => {
    const hidden: [string, string][] = [
      // mysql family, password after the command word
      ["mysql -u root -pS3cret db", "mysql -u root -p*** db"],
      ["mysql -h db.staging -u root -pS3cretPass -e 'show databases'", "mysql -h db.staging -u root -p*** -e 'show databases'"],
      ["mysqldump -uroot -p'my pass' shop > dump.sql", "mysqldump -uroot -p*** shop > dump.sql"],
      ["mysqladmin -u root -ph0rse status", "mysqladmin -u root -p*** status"],
      ["mariadb -u app -pApp_2024 -e 'select 1'", "mariadb -u app -p*** -e 'select 1'"],
      ["mariadb-dump -u app -pX9 db", "mariadb-dump -u app -p*** db"],
      // The prototype rule (-p before a later "mysql") also eats the ";" — both secrets are still hidden.
      ["mysql -pA; mysql -pB", "mysql -p*** mysql -p***"],
      // curl user:pass
      ["curl -u admin:hunter2 https://h/api", "curl -u admin:*** https://h/api"],
      ["curl -s --user admin:hunter2 https://h", "curl -s --user admin:*** https://h"],
      ["curl --user=admin:hunter2 https://h", "curl --user=admin:*** https://h"],
      ["curl -uadmin:pw https://h", "curl -uadmin:*** https://h"],
      ["curl -u 'admin:p w' https://h", "curl -u 'admin:***' https://h"],
      ["curl -x proxy:3128 -U bob:pr0xy https://h", "curl -x proxy:3128 -U bob:*** https://h"],
      ["curl --proxy-user bob:pr0xy https://h", "curl --proxy-user bob:*** https://h"],
      // credentials in URLs
      ["git clone https://bob:ghs_tok3n@github.com/x/y.git", "git clone https://bob:***@github.com/x/y.git"],
      ["psql postgres://admin:s3cr3t@db:5432/app", "psql postgres://admin:***@db:5432/app"],
      ["redis-cli -u redis://default:pw@cache:6379", "redis-cli -u redis://default:***@cache:6379"],
      // sshpass
      ["sshpass -p 'S3cret' ssh root@10.0.0.5", "sshpass -p *** ssh root@10.0.0.5"],
      ["sshpass -pS3cret scp a b:/tmp", "sshpass -p*** scp a b:/tmp"],
      ["sshpass -p pw ssh -p 2222 u@h", "sshpass -p *** ssh -p 2222 u@h"],
    ];
    it.each(hidden)("%s", (input, want) => {
      expect(redact(input)).toBe(want);
    });
    const untouched = [
      "mysql -u root -p shop", // bare -p prompts for the password
      "mysql -h db -P 3306 -u app shop", // -P is the port
      "curl -A 'x' --user-agent Mozilla https://h",
      "curl -u alice https://h", // no password, curl prompts
      "curl https://example.com/a?b=c",
      "git push https://github.com/x/y.git",
      "ssh -p 2222 user@host",
      "sshpass -f ~/.pw ssh host",
      "echo user@example.com",
    ];
    it.each(untouched)("leaves %s alone", (input) => {
      expect(redact(input)).toBe(input);
    });
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
