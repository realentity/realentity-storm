import { type RunDetailView } from "@realentity/storm-shared";
import { expect, test } from "@playwright/test";
import { createPipeline, startRun, unique } from "./support";

const pdf = (text: string) => ({ name: `${text}.pdf`, mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`) });

// M10-T6: an application form at its gate, field by field, with the stored documents; Act sends exactly what is shown
test("an application form at its gate: a field edited, a cover letter attached, and Act sends exactly that", async ({ page }) => {
  // Profile → the profile and documents.
  await page.goto("/profile");
  await page.getByLabel("About you").fill("Ana Petrova · ana@storm.test · Sofia");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Profile saved")).toBeVisible();
  for (const [name, file] of [
    ["cv-main", pdf("Ana Petrova CV")],
    ["letter-acme", pdf("Cover letter Acme")],
  ] as const) {
    await page.getByLabel("Document name").fill(name);
    await page.getByLabel("File").setInputFiles(file);
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByTestId("documents")).toContainText(file.name);
  }
  const documents = (await (await page.request.get("/api/documents")).json()) as { documentId: string; name: string; sha256: string }[];
  const cv = documents.find((d) => d.name === "cv-main")!;

  // A form payload as browser.mapForm would make it (the step itself is covered in the worker's tests).
  const name = unique("Apply e2e");
  const pipeline = await createPipeline(
    page,
    JSON.stringify({
      name,
      policy: { allowedDomains: ["ats.example.org"] },
      steps: [
        {
          id: "apply",
          type: "browser.fillAndSubmit",
          with: {
            url: "https://ats.example.org/apply/7",
            fields: [
              { key: "#name", label: "Full name", type: "text", required: true, value: "Ana Petrova", source: "profile" },
              { key: "#phone", label: "Phone", type: "tel", required: false, value: "+359 88 123 4567", source: "profile" },
              { key: "#notice", label: "Notice period", type: "select", required: true, options: ["Immediately", "1 month"], value: "1 month", source: "profile" },
              { key: "#cv", label: "CV", type: "file", required: true, value: null, source: "none" },
              { key: "#letter", label: "Cover letter", type: "file", required: false, value: null, source: "none" },
              { key: '[name="consent"]', label: "I agree to the processing of my data", type: "checkbox", required: true, value: true, source: "profile" },
            ],
            files: [{ key: "#cv", document: "cv-main", documentId: cv.documentId, sha256: cv.sha256, filename: "Ana Petrova CV.pdf" }],
          },
        },
      ],
    }),
  );
  const run = await startRun(page, pipeline.pipelineId);

  await page.goto("/inbox");
  await page.getByRole("link", { name: new RegExp(`${name} · apply`) }).click();
  const form = page.getByTestId("form-proposal");
  await expect(form).toContainText("https://ats.example.org/apply/7");
  await expect(form.getByLabel("Full name")).toHaveValue("Ana Petrova");
  await expect(form.getByTestId("form-field-Full name")).toContainText("from your profile");
  await expect(form.getByLabel("CV")).toHaveValue(cv.documentId);
  await expect(page.getByTestId("targets")).toContainText("ats.example.org");

  await form.getByLabel("Phone").fill("+359 88 765 4321");
  await form.getByLabel("Cover letter").selectOption({ label: "letter-acme: Cover letter Acme.pdf" });
  await form.getByRole("button", { name: "Act with edits" }).click();
  await page.getByTestId("act-confirm").click();
  await expect(page.getByTestId("decision")).toContainText("Approved with edits");

  // The run sent exactly that: the edited phone, both files.
  await expect
    .poll(async () => ((await (await page.request.get(`/api/runs/${run.runId}`)).json()) as RunDetailView).status, { timeout: 15_000 })
    .toBe("DONE");
  const detail = (await (await page.request.get(`/api/runs/${run.runId}`)).json()) as RunDetailView;
  const input = detail.steps.find((s) => s.stepKey === "apply")!.input as { fields: { key: string; value: unknown }[]; files: { document: string }[] };
  expect(input.fields.find((f) => f.key === "#phone")?.value).toBe("+359 88 765 4321");
  expect(input.files.map((f) => f.document).sort()).toEqual(["cv-main", "letter-acme"]);
});

// M11-T2: what browser.agent did, at browser.submit's gate: every action in order, typed values editable
test("the agent's actions at the gate: a typed value edited, and Act repeats exactly that", async ({ page }) => {
  await page.goto("/profile");
  await page.getByLabel("Document name").fill("cv-agent");
  await page.getByLabel("File").setInputFiles(pdf("Ana Petrova CV agent"));
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByTestId("documents")).toContainText("Ana Petrova CV agent.pdf");
  const documents = (await (await page.request.get("/api/documents")).json()) as { documentId: string; name: string; sha256: string }[];
  const cv = documents.find((d) => d.name === "cv-agent")!;

  // A payload as browser.agent would make it (the agent itself is covered in the worker's tests).
  const target = (css: string, role: string, name: string) => ({ css, role, name });
  const name = unique("Agent e2e");
  const pipeline = await createPipeline(
    page,
    JSON.stringify({
      name,
      policy: { allowedDomains: ["careers.example.org"] },
      steps: [
        {
          id: "send",
          type: "browser.submit",
          with: {
            url: "https://careers.example.org/jobs/3",
            actions: [
              { kind: "click", target: target("#open", "button", "Apply for this role") },
              { kind: "type", target: target("#fullName", "textbox", "Full name"), value: "Ana Petrova", source: "profile" },
              { kind: "click", target: target("#city", "combobox", "Where are you based?") },
              { kind: "click", target: target("#cities > li:nth-of-type(1)", "option", "Sofia") },
              { kind: "attach", target: target("#cvFile", "file", "Upload CV"), document: "cv-agent" },
              { kind: "check", target: target('input[name="consent"]', "checkbox", "I agree"), value: true },
            ],
            files: [{ key: "#cvFile", document: "cv-agent", documentId: cv.documentId, sha256: cv.sha256, filename: "Ana Petrova CV agent.pdf" }],
            submit: target("#send", "button", "Submit application"),
          },
        },
      ],
    }),
  );
  const run = await startRun(page, pipeline.pipelineId);

  await page.goto("/inbox");
  await page.getByRole("link", { name: new RegExp(`${name} · send`) }).click();
  const gate = page.getByTestId("agent-proposal");
  await expect(gate.getByTestId("agent-action-0")).toContainText("Click button Apply for this role");
  await expect(gate.getByTestId("agent-action-3")).toContainText("Click option Sofia");
  await expect(gate.getByTestId("agent-action-4")).toContainText("Attach Ana Petrova CV agent.pdf to Upload CV");
  await expect(gate).toContainText("Then press Submit application");
  await expect(gate.getByTestId("agent-action-1")).toContainText("from your profile");

  await gate.getByLabel("Type into Full name").fill("Ana P. Petrova");
  await gate.getByRole("button", { name: "Act with edits" }).click();
  await page.getByTestId("act-confirm").click();
  await expect(page.getByTestId("decision")).toContainText("Approved with edits");

  await expect
    .poll(async () => ((await (await page.request.get(`/api/runs/${run.runId}`)).json()) as RunDetailView).status, { timeout: 15_000 })
    .toBe("DONE");
  const detail = (await (await page.request.get(`/api/runs/${run.runId}`)).json()) as RunDetailView;
  const input = detail.steps.find((s) => s.stepKey === "send")!.input as { actions: { kind: string; value?: unknown }[] };
  expect(input.actions.find((a) => a.kind === "type")?.value).toBe("Ana P. Petrova");
});
