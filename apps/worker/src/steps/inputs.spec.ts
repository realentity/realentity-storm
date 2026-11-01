import { numberIn } from "./history-step";
import { pageText, privateAddresses } from "./http-steps";

describe("numberIn: prices as shops write them", () => {
  it.each([
    [1299, 1299],
    ["1 299,00 лв.", 1299],
    ["1 299,99 лв.", 1299.99],
    ["€1,299.99", 1299.99],
    ["1.299,99 €", 1299.99],
    ["12.50", 12.5],
    ["12,50 лв", 12.5],
    ["1.299", 1299],
    ["0.125", 0.125],
    ["1,234,567", 1234567],
    ["Цена: 349 лв.", 349],
    ["-3,5", -3.5],
  ])("%p → %p", (text, expected) => {
    expect(numberIn(text)).toBe(expected);
  });

  it("is null for what holds no number", () => {
    expect(numberIn("out of stock")).toBeNull();
    expect(numberIn(null)).toBeNull();
    expect(numberIn(Number.NaN)).toBeNull();
  });
});

describe("pageText", () => {
  it("drops scripts, styles and tags, decodes entities, keeps lines", () => {
    const html = `<html><head><style>p{}</style><script>alert(1)</script></head>
      <body><h1>Release&nbsp;5.0</h1><p>Fixes &amp; changes &#8212; see <a href="/x">notes</a>.</p><!-- hidden --></body></html>`;
    expect(pageText(html)).toBe("Release 5.0\nFixes & changes — see notes .");
  });
});

describe("privateAddresses (M13-S1)", () => {
  const blocked = privateAddresses();
  it.each([
    ["127.0.0.1", "ipv4"],
    ["10.1.2.3", "ipv4"],
    ["172.20.0.5", "ipv4"],
    ["192.168.1.10", "ipv4"],
    ["169.254.169.254", "ipv4"],
    ["100.101.102.103", "ipv4"],
    ["0.0.0.0", "ipv4"],
    ["::1", "ipv6"],
    ["fe80::1", "ipv6"],
    ["fd00::5", "ipv6"],
    ["fd7a:115c:a1e0::1", "ipv6"],
  ] as const)("blocks %s", (address, family) => {
    expect(blocked.check(address, family)).toBe(true);
  });

  it.each([
    ["140.82.112.3", "ipv4"],
    ["104.16.1.1", "ipv4"],
    ["2606:4700::1111", "ipv6"],
  ] as const)("lets %s through", (address, family) => {
    expect(blocked.check(address, family)).toBe(false);
  });
});
