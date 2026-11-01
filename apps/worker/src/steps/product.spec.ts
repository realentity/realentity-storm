import { itemOf, productOf } from "./product-step";

const URL = "https://shop.test/p/jacket";
const ld = (...blocks: unknown[]) =>
  `<html><head><title>Jacket | Shop</title>${blocks.map((b) => `<script type="application/ld+json">${typeof b === "string" ? b : JSON.stringify(b)}</script>`).join("")}</head><body></body></html>`;

const variant = (color: string, size: string, price: number | string, availability = "https://schema.org/InStock") => ({
  "@type": "Product",
  sku: `J-${color}-${size}`,
  name: `Jacket - ${color} | ${size}`,
  color,
  size,
  offers: { "@type": "Offer", price, priceCurrency: "EUR", availability },
});

const GROUP = ld(
  { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [] },
  {
    "@context": "https://schema.org/",
    "@type": "ProductGroup",
    name: "Fjällräven - Skogsö Padded Jacket",
    brand: { "@type": "Brand", name: "Fjällräven" },
    variesBy: ["https://schema.org/size", "https://schema.org/color"],
    hasVariant: [
      variant("Black", "M", 343.16),
      variant("Black", "L", 299.9),
      variant("Autumn Leaf", "M", 259, "https://schema.org/OutOfStock"),
      variant("Autumn Leaf", "L", "279,00"),
    ],
  },
  // The reviews' Product, without offers.
  { "@context": "https://schema.org/", "@type": "Product", name: "Fjällräven - Skogsö Padded Jacket", aggregateRating: { ratingValue: 4.8 } },
);

describe("shop.product: reading a product page (M13 follow-up)", () => {
  it("reads a ProductGroup's variants and picks the one asked for", () => {
    const data = productOf(GROUP)!;
    expect(data).toMatchObject({ title: "Fjällräven - Skogsö Padded Jacket", brand: "Fjällräven", source: "schema.org" });
    expect(data.offers).toHaveLength(4);
    expect(itemOf(URL, { size: "m", color: "black" }, data)).toMatchObject({
      id: `${URL}#color=black&size=m`,
      price: 343.16,
      currency: "EUR",
      availability: "InStock",
      inStock: true,
      sku: "J-Black-M",
      variant: { color: "Black", size: "M" },
      matches: 1,
      problem: null,
    });
    // "colour" is color; a price written as text is a number.
    expect(itemOf(URL, { colour: "Autumn Leaf", size: "L" }, data)).toMatchObject({ price: 279, sku: "J-Autumn Leaf-L" });
  });

  it("with several matching variants, takes the cheapest in stock; out of stock only when nothing else is", () => {
    const data = productOf(GROUP)!;
    // Autumn Leaf M is cheaper (259) but sold out.
    expect(itemOf(URL, { size: "M" }, data)).toMatchObject({ price: 343.16, inStock: true, matches: 2 });
    expect(itemOf(URL, { size: "M", color: "Autumn Leaf" }, data)).toMatchObject({ price: 259, inStock: false, availability: "OutOfStock" });
    expect(itemOf(URL, {}, data)).toMatchObject({ id: URL, price: 279, note: "the cheapest of 4 variants in stock: choose one with select" });
  });

  it("names what exists when the variant asked for doesn't", () => {
    expect(itemOf(URL, { size: "XXL", color: "Black" }, productOf(GROUP)!)).toMatchObject({
      price: null,
      matches: 0,
      problem: "no variant with size XXL, color Black (size: M, L; color: Black, Autumn Leaf)",
    });
    // The same product and variant, however select is written: the same key for data.history.
    expect(itemOf(URL, { color: "Black", size: "XXL" }, productOf(GROUP)!).id).toBe(`${URL}#color=Black&size=XXL`);
  });

  it("reads a Product's offers: an AggregateOffer, offers per variant in @graph with additionalProperty, a name to match", () => {
    expect(productOf(ld({ "@type": "Product", name: "Disk", offers: { "@type": "AggregateOffer", lowPrice: "1.299,00", priceCurrency: "BGN" } }))).toMatchObject({
      title: "Disk",
      offers: [{ price: 1299, currency: "BGN" }],
    });
    const graph = ld({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebPage", name: "Shoe" },
        {
          "@type": ["Product"],
          name: "Shoe",
          sku: "S-43",
          additionalProperty: [{ "@type": "PropertyValue", name: "Shoe size", value: "43" }],
          offers: [{ "@type": "Offer", price: "120.50", priceCurrency: "EUR", availability: "InStock" }],
        },
        { "@type": "Product", name: "Shoe - 44", sku: "S-44", offers: { "@type": "Offer", price: 99, priceCurrency: "EUR" } },
      ],
    });
    const data = productOf(graph)!;
    expect(data.offers.map((o) => o.price)).toEqual([120.5, 99]);
    expect(itemOf(URL, { "shoe size": "43" }, data)).toMatchObject({ price: 120.5, sku: "S-43", inStock: true });
    // No such attribute: the variant's name ("Shoe - 44").
    expect(itemOf(URL, { size: "44" }, data)).toMatchObject({ price: 99, sku: "S-44" });
  });

  it("falls back to price meta tags, and says when a page with one price has no variants to choose from", () => {
    const html =
      `<html><head><title>Kettle &amp; lid</title><meta property="og:title" content="Kettle &amp; lid">` +
      `<meta property="product:price:amount" content="49.99"><meta property="product:price:currency" content="EUR">` +
      `<meta property="product:availability" content="in stock"></head></html>`;
    const data = productOf(html)!;
    expect(data).toMatchObject({ title: "Kettle & lid", source: "meta tags", offers: [{ price: 49.99, currency: "EUR", availability: "InStock" }] });
    expect(itemOf(URL, {}, data)).toMatchObject({ price: 49.99, note: null });
    expect(productOf(`<div itemprop="offers"><span itemprop="price" content="12.50"></span><meta itemprop="priceCurrency" content="USD"></div>`)).toMatchObject({
      offers: [{ price: 12.5, currency: "USD" }],
    });
  });

  it("has nothing for a page without product data, and skips a broken JSON-LD block", () => {
    expect(productOf("<html><body><h1>Jacket</h1><p>€ 129,95</p></body></html>")).toBeNull();
    expect(productOf(ld("{ not json", { "@type": "Organization", name: "Shop" }))).toBeNull();
    const raw = `{"@type":"Product","name":"Line\nbreak","offers":{"price":5,"priceCurrency":"EUR"}}`;
    expect(productOf(ld("{ not json", raw))).toMatchObject({ title: "Line break", offers: [{ price: 5 }] });
  });
});
