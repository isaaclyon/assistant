import { describe, expect, it } from "vitest";
import { validatePrivateLoginRequest, validLoginValues } from "../src/private-login.js";
const request = { session: "test", pageUrl: "https://example.com/signin?challenge=public", resumeUrl: "https://example.com/" };
describe("private login contract", () => {
  it("requires an exact HTTPS origin and clean resume URL", () => {
    expect(() => validatePrivateLoginRequest(request)).not.toThrow();
    for (const patch of [{ pageUrl: "http://example.com/" }, { resumeUrl: "https://other.example/" }, { resumeUrl: "https://example.com/?secret=x" }, { pageUrl: "https://user:password@example.com/" }, { session: "../test" }, { credentialItem: "--flag" }]) {
      expect(() => validatePrivateLoginRequest({ ...request, ...patch })).toThrow();
    }
  });
  it("bounds private values and rejects unknown shapes", () => {
    expect(validLoginValues(["username", "password"], ["user", "synthetic"])).toBe(true);
    expect(validLoginValues(["code"], ["123456"])).toBe(true);
    expect(validLoginValues(["password"], { value: "synthetic" })).toBe(false);
    expect(validLoginValues(["password"], ["x".repeat(1025)])).toBe(false);
    expect(validLoginValues(["password"], [""])).toBe(false);
    expect(validLoginValues(["code"], ["<script>123</script>"])).toBe(false);
  });
});
