import { describe, expect, it } from "vitest";

import {
  buildSmsUrl,
  initializeMessagePage,
  normalizePhoneNumber,
  parseMessageFragment,
} from "../web/messages/messages-link.js";
import { buildMessageLink } from "../.pi/skills/message-link/scripts/messages-link.mjs";

describe("editable Messages links", () => {
  it("parses percent-encoded recipient, label, and body from the fragment", () => {
    expect(
      parseMessageFragment(
        "#to=%2B1%20(801)%20885-1827&label=Emma%20Lyon&body=Hi%20%26%20hello%0A%E2%98%95",
      ),
    ).toEqual({
      to: "+1 (801) 885-1827",
      label: "Emma Lyon",
      body: "Hi & hello\n☕",
    });
  });

  it.each([
    ["+1 (801) 885-1827", "+18018851827"],
    ["801.885.1827", "8018851827"],
    [" 44 20 7946 0958 ", "442079460958"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizePhoneNumber(input)).toBe(expected);
  });

  it.each(["", "123456", "+01234567", "+1+8018851827", "801-ABC-1827", "1234567890123456"])(
    "rejects invalid recipient %j",
    (input) => {
      expect(normalizePhoneNumber(input)).toBeNull();
    },
  );

  it("encodes the current edited body in the generated iPhone Messages URL", () => {
    expect(buildSmsUrl("+18018851827", "Changed my mind & added ☕\nThanks")).toBe(
      "sms:+18018851827&body=Changed%20my%20mind%20%26%20added%20%E2%98%95%0AThanks",
    );
  });

  it("uses the edited textarea value only after the user clicks", () => {
    const handlers = new Map();
    const elements = {
      "#message": { value: "" },
      "#open": {
        hidden: true,
        disabled: true,
        textContent: "",
        addEventListener(event, handler) {
          handlers.set(event, handler);
        },
      },
      "#error": { hidden: true },
    };
    const document = { querySelector: (selector) => elements[selector] };
    const previousWindow = globalThis.window;
    globalThis.window = { location: { href: "https://example.test/unchanged" } };
    try {
      initializeMessagePage(
        document,
        "#to=%2B18018851827&label=Emma&body=Original+draft",
      );
      expect(globalThis.window.location.href).toBe("https://example.test/unchanged");
      elements["#message"].value = "Edited draft & ☕";
      handlers.get("click")();
      expect(globalThis.window.location.href).toBe(
        "sms:+18018851827&body=Edited%20draft%20%26%20%E2%98%95",
      );
    } finally {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    }
  });

  it("does not register an opening action for an invalid recipient", () => {
    const open = {
      hidden: false,
      disabled: false,
      addEventListener() {
        throw new Error("invalid recipients must not receive a click handler");
      },
    };
    const elements = {
      "#message": { value: "" },
      "#open": open,
      "#error": { hidden: true },
    };

    initializeMessagePage(
      { querySelector: (selector) => elements[selector] },
      "#to=not-a-number&body=Draft",
    );

    expect(open).toMatchObject({ hidden: true, disabled: true });
    expect(elements["#error"].hidden).toBe(false);
  });

  it("builds a Telegram-safe HTTPS link with private values only in the fragment", () => {
    const link = buildMessageLink("https://lyon-server.example.ts.net:8443/", {
      to: "+1 (801) 885-1827",
      label: "Emma",
      body: "Want dinner? #idea",
    });
    const url = new URL(link);

    expect(`${url.origin}${url.pathname}${url.search}`).toBe(
      "https://lyon-server.example.ts.net:8443/",
    );
    expect(url.hash).toBe(
      "#to=%2B18018851827&label=Emma&body=Want+dinner%3F+%23idea",
    );
  });

  it.each([
    "http://lyon-server.example.ts.net:8443/",
    "https://example.com/path?to=leak",
    "https://user:secret@example.com/",
  ])("rejects unsafe base URL %s", (baseUrl) => {
    expect(() =>
      buildMessageLink(baseUrl, { to: "+18018851827", label: "Emma", body: "Hi" }),
    ).toThrow();
  });
});
