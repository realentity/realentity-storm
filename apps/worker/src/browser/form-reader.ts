import { type FormField } from "@ai-me/steps";
import { type Page } from "playwright";

/** A field as the page has it now (no value to type yet). */
export type PageField = Omit<FormField, "value" | "source">;

export interface PageForm {
  fields: PageField[];
  /** The final button's label ("" when the form has none). */
  submit: string;
}

/** An Apply button or link that leads to the form (never a submit button: following it must not send anything). */
const APPLY = /^\s*(apply|apply now|apply for this job|easy apply|кандидатствай|кандидатствайте)\b/i;
/** A wizard's next-step button. */
export const NEXT = /^\s*(next|continue|next step|напред|продължи|следваща|следващ)\b/i;

/**
 * Runs in the page (a string: the worker has no DOM types): every field of the form with the most fields, hidden
 * wizard steps included, with a selector to find it again, its label, type, whether it is required and its choices.
 * Passwords and hidden inputs are never fields: nothing fills them.
 */
const READ_FORM = `() => {
  const clean = (text) => (text || "").replace(/\\s+/g, " ").trim();
  const forms = [...document.querySelectorAll("form")];
  const count = (root) => root.querySelectorAll("input, select, textarea").length;
  const root = forms.sort((a, b) => count(b) - count(a))[0] || document.body;
  const css = (value) => (window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/["\\\\]/g, "\\\\$&"));
  const labelOf = (el) => {
    if (el.id) {
      const label = document.querySelector('label[for="' + css(el.id) + '"]');
      if (label) return clean(label.innerText || label.textContent);
    }
    const wrapping = el.closest("label");
    const wrapped = wrapping ? clean(wrapping.innerText || wrapping.textContent) : "";
    if (wrapped) return wrapped;
    const by = el.getAttribute("aria-labelledby");
    if (by) return clean(by.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" "));
    const own = clean(el.getAttribute("aria-label") || el.getAttribute("placeholder") || "");
    if (own) return own;
    // A checkbox whose text sits next to it, not in its label (Contact Form 7, many consent boxes): the nearest text
    // around it, up to six levels up.
    let node = el.parentElement;
    for (let level = 0; level < 6 && node && node !== root; level++, node = node.parentElement) {
      const text = clean(node.innerText || node.textContent);
      if (text) return text.length <= 300 ? text : "";
    }
    return clean(el.getAttribute("name") || "");
  };
  const keyOf = (el, withValue) => {
    if (el.id && document.querySelectorAll("#" + css(el.id)).length === 1) return "#" + css(el.id);
    const name = el.getAttribute("name");
    if (!name) return null;
    return '[name="' + css(name) + '"]' + (withValue ? '[value="' + css(el.value) + '"]' : "");
  };
  const TYPES = { email: "email", tel: "tel", url: "url", number: "number", date: "date", file: "file", checkbox: "checkbox", radio: "radio" };
  const fields = [];
  const radios = new Map();
  for (const el of root.querySelectorAll("input, select, textarea")) {
    const tag = el.tagName.toLowerCase();
    const inputType = (el.getAttribute("type") || "text").toLowerCase();
    if (tag === "input" && ["hidden", "password", "submit", "button", "image", "reset"].includes(inputType)) continue;
    const required = el.required || el.getAttribute("aria-required") === "true";
    if (tag === "input" && inputType === "radio") {
      const name = el.getAttribute("name");
      if (!name) continue;
      const group = radios.get(name) || { key: '[name="' + css(name) + '"]', label: "", type: "radio", required: false, options: [] };
      const legend = el.closest("fieldset")?.querySelector("legend");
      group.label = group.label || clean(legend?.textContent) || name;
      group.required = group.required || required;
      group.options.push(labelOf(el) || el.value);
      if (!radios.has(name)) {
        radios.set(name, group);
        fields.push(group);
      }
      continue;
    }
    const key = keyOf(el, inputType === "checkbox" && root.querySelectorAll('[name="' + css(el.getAttribute("name") || "") + '"]').length > 1);
    if (!key) continue;
    const field = { key, label: labelOf(el), type: tag === "select" ? "select" : tag === "textarea" ? "textarea" : TYPES[inputType] || "text", required };
    if (tag === "select") field.options = [...el.options].filter((o) => o.value !== "").map((o) => clean(o.textContent));
    fields.push(field);
  }
  const buttons = [...root.querySelectorAll('button, input[type="submit"]')].filter((b) => (b.getAttribute("type") || "submit").toLowerCase() === "submit");
  const submit = buttons.length ? clean(buttons[buttons.length - 1].innerText || buttons[buttons.length - 1].value) : "";
  return { fields: fields.slice(0, 100), submit };
}`;

/** "104-43=", "What is 3 + 4?", a CAPTCHA: a check that I'm a person, which only I answer. */
export const HUMAN_CHECK = /^\s*(what is\s+|колко (е|прави)\s+)?\d+\s*[-+*x×]\s*\d+\s*=?\s*\??\s*$|captcha|are you (a )?human|not a robot|не съм робот/i;
/** A trap for bots ("Please leave this field empty"): never filled, so never shown. */
export const HONEYPOT = /leave (this field )?(blank|empty)|do not fill|don't fill|оставете (това поле )?празно/i;

export async function readForm(page: Page): Promise<PageForm> {
  const form = await page.evaluate<PageForm>(`(${READ_FORM})()`);
  return {
    submit: form.submit,
    fields: form.fields
      .filter((field) => !HONEYPOT.test(field.label))
      .map((field) => (HUMAN_CHECK.test(field.label) ? { ...field, human: true } : field)),
  };
}

/**
 * The form, read where it is: on the page, or behind the page's Apply link or button (followed once). Null: no form.
 */
export async function findForm(page: Page, settle: () => Promise<void>): Promise<PageForm | null> {
  let form = await readForm(page);
  if (form.fields.length > 0) return form;
  const candidates = page.locator("a, button");
  const total = Math.min(await candidates.count(), 200);
  for (let i = 0; i < total; i++) {
    const candidate = candidates.nth(i);
    const [text, type, visible] = await Promise.all([
      candidate.innerText().catch(() => ""),
      candidate.getAttribute("type").catch(() => null),
      candidate.isVisible().catch(() => false),
    ]);
    // A submit button inside a form would send that form: never followed.
    const submits = await candidate
      .evaluate((el: { tagName: string; closest(selector: string): unknown }) => el.tagName === "BUTTON" && el.closest("form") !== null)
      .then((inForm) => inForm && (type ?? "submit") === "submit")
      .catch(() => true);
    if (!visible || !APPLY.test(text) || submits) continue;
    await candidate.click();
    await settle();
    form = await readForm(page);
    return form.fields.length > 0 ? form : null;
  }
  return null;
}
