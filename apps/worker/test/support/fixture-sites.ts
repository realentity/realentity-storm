import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";

/** The test account on the fixture sites; the security tests grep everything the run produced for the password. */
export const USERNAME = "ana@aime.test";
export const PASSWORD = "fixture pass!Wq83zLp0";

export interface FixtureSites {
  port: number;
  /** http://<host>.localhost:<port><path> (Chromium resolves *.localhost to this machine). */
  url(host: string, path: string): string;
  /** Every sign-in form posted, by host. */
  posts: { host: string; path: string; body: string }[];
  /** Page requests, as "host path". */
  hits: string[];
  /** Session cookies the app handed out (the S4 test looks for them on disk). */
  sessions: Set<string>;
  solveCaptcha(): void;
  /** jobs.localhost redesigned: its cards get other classes, so a recipe taught before no longer matches. */
  redesignJobs(): void;
  /** ats.localhost's form asks for one more required field (a salary expectation) from now on. */
  addRequiredField(): void;
  /** Back to a fresh state between tests: no posts or hits, the CAPTCHA unsolved, the job board as first built. */
  reset(): void;
  stop(): Promise<void>;
}

/** Downloads (M8-S6): real ones, a disguised one, a disallowed type, and one over the test's size limit (2 KB). */
export const FILES: Record<string, { type: string; content: Buffer }> = {
  "report.pdf": { type: "application/pdf", content: Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n") },
  "notes.txt": { type: "text/plain", content: Buffer.from("Interview on Tuesday — бележки\n") },
  "invoice.pdf": { type: "application/pdf", content: Buffer.from("MZ\x90\x00 this is really an executable", "latin1") },
  "setup.exe": { type: "application/octet-stream", content: Buffer.from("MZ\x90\x00", "latin1") },
  "scan.pdf": { type: "application/pdf", content: Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(4096, 0x20)]) },
};

/** The job board's postings: 12 for "net" (pages of 5), none for anything else. */
export const JOBS = Array.from({ length: 12 }, (_, i) => ({
  id: 100 + i,
  title: i === 0 ? "Senior .NET Developer" : `${["Senior", "Mid", "Lead"][i % 3]} .NET Engineer ${i}`,
  company: i % 4 === 0 ? "Talent Hunters Recruitment" : `Company ${i}`,
  location: i % 2 === 0 ? "Sofia" : "Remote",
}));
const JOBS_PER_PAGE = 5;

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const loginForm = (action: string, error = "") =>
  page(
    "Sign in",
    `<h1>Sign in</h1>${error ? `<p class="error">${error}</p>` : ""}
     <form method="post" action="${action}">
       <label>Email <input type="email" name="email" autocomplete="username"></label>
       <label>Password <input type="password" name="password" autocomplete="current-password"></label>
       <button type="submit">Sign in</button>
     </form>`,
  );

/**
 * Local sites for the browser tests (README test strategy: no real site is ever hit), told apart by host:
 * - app.localhost: /account needs a session (else /login); /sso-account signs in through sso.localhost; /captcha
 *   shows a CAPTCHA until solveCaptcha(), without reloading; /slow never shows #ready; /files/* downloads.
 * - sso.localhost: the identity provider's sign-in.
 * - app.localhost.evil.localhost: a look-alike sign-in page (phishing).
 * - ats.localhost: an applicant tracking system: /jobs/7 links to the wizard form /apply/7; /jobs/8 has its form on the
 *   page, like dev.bg; /quick-apply uploads a file as soon as it is picked; addRequiredField() changes the form.
 * - jobs.localhost: a job board, /search?q=net in three pages (JOBS), an ad between the cards; redesignJobs() changes
 *   its markup.
 */
export async function startFixtureSites(): Promise<FixtureSites> {
  const posts: FixtureSites["posts"] = [];
  const hits: string[] = [];
  const sessions = new Set<string>();
  let solved = false;
  let redesigned = false;
  let extraField = false;
  let quiz = 0;

  /**
   * ats.localhost/jobs/8, like dev.bg's postings (Contact Form 7): the form on the posting page, a person check that
   * changes on every load, a honeypot, a consent box with its text beside it, sent by fetch; on success the form is
   * cleared and a thank-you shown, on the same page.
   */
  const inlineForm = () => {
    quiz++;
    const [a, b] = [100 + quiz, 40 + quiz];
    return page(
      "Senior .NET Developer at Acme",
      `<h1>Senior .NET Developer</h1><p>Acme · Sofia</p>
       <form class="wpcf7-form" action="/apply/8" method="post" enctype="multipart/form-data" novalidate>
         <p><input name="your-name" placeholder="Име и Фамилия*" aria-required="true" required></p>
         <p><input name="your-email" type="email" placeholder="Email*" aria-required="true" required></p>
         <p><textarea name="your-message" placeholder="Започни да пишеш тук..."></textarea></p>
         <p><input id="files-8" name="files" type="file" required></p>
         <p><label>${a}-${b}=<input name="short-question" required></label></p>
         <p><label>Please leave this field empty.<input id="trap" name="trap"></label></p>
         <span class="wpcf7-list-item"><input type="checkbox" name="privacy[]" value="1"><span>Съгласен съм с политиката за поверителност</span></span>
         <button type="submit">Кандидатствай</button>
         <div class="wpcf7-response-output"></div>
       </form>
       <script>
         const form = document.querySelector("form");
         form.addEventListener("submit", async (event) => {
           event.preventDefault();
           await fetch(form.action, { method: "POST", body: new FormData(form) });
           form.reset();
           form.querySelector(".wpcf7-response-output").textContent = "Thank you for your message. It has been sent.";
         });
       </script>`,
    );
  };

  /**
   * ats.localhost/apply/7: a wizard in one form (three fieldsets shown in turn by Next), files on the second step,
   * a select, a free-text answer and a required consent on the third; posts multipart to /apply/7.
   */
  const applyForm = () =>
    page(
      "Apply: Senior .NET Developer",
      `<h1>Apply: Senior .NET Developer at Acme</h1>
       <form method="post" action="/apply/7" enctype="multipart/form-data">
         <fieldset data-step="1"><legend>You</legend>
           <label for="name">Full name</label><input id="name" name="name" required>
           <label for="email">Email</label><input id="email" name="email" type="email" required>
           <label for="phone">Phone</label><input id="phone" name="phone" type="tel">
           <button type="button" class="next">Next</button>
         </fieldset>
         <fieldset data-step="2" hidden><legend>Documents</legend>
           <label for="cv">CV / Résumé</label><input id="cv" name="cv" type="file" required>
           <label for="letter">Cover letter</label><input id="letter" name="letter" type="file">
           <button type="button" class="next">Next</button>
         </fieldset>
         <fieldset data-step="3" hidden><legend>Questions</legend>
           <label for="notice">Notice period</label>
           <select id="notice" name="notice" required><option value="">Choose</option><option>Immediately</option><option>1 month</option><option>3 months</option></select>
           <label for="message">Why Acme?</label><textarea id="message" name="message"></textarea>
           ${extraField ? '<label for="salary">Salary expectation</label><input id="salary" name="salary" required>' : ""}
           <label><input type="checkbox" name="consent" required> I agree to Acme processing my data for this application</label>
           <label><input type="checkbox" name="newsletter"> Send me Acme's newsletter</label>
           <button type="submit">Send application</button>
         </fieldset>
       </form>
       <script>
         for (const button of document.querySelectorAll("button.next")) {
           button.addEventListener("click", () => {
             const step = button.closest("fieldset");
             for (const field of step.querySelectorAll("[required]")) if (!field.checkValidity()) return field.reportValidity();
             step.hidden = true;
             step.nextElementSibling.hidden = false;
           });
         }
       </script>`,
    );

  /** jobs.localhost/search?q=…&page=N: a filter form, an ad between the cards, a pager with page numbers and Next. */
  const jobBoard = (url: URL): string => {
    const query = url.searchParams.get("q") ?? "";
    const pageNo = Number(url.searchParams.get("page") ?? "1");
    const all = query === "net" ? JOBS : [];
    const shown = all.slice((pageNo - 1) * JOBS_PER_PAGE, pageNo * JOBS_PER_PAGE);
    const card = (job: (typeof JOBS)[number]) =>
      redesigned
        ? `<li class="posting-card"><h3><a href="/jobs/${job.id}">${job.title}</a></h3><p>${job.company} · ${job.location}</p></li>`
        : `<article class="job" data-id="${job.id}">
             <a class="job-title" href="/jobs/${job.id}">${job.title}</a>
             <span class="company">${job.company}</span><span class="location">${job.location}</span><time>29 Oct</time>
           </article>`;
    const cards = shown.map(card);
    if (cards.length > 2) cards.splice(2, 0, `<div class="ad"><a href="/promo">Promoted: learn Rust</a></div>`);
    const pages = Math.ceil(all.length / JOBS_PER_PAGE);
    const pager =
      pages > 1
        ? `<nav class="pager">${Array.from({ length: pages }, (_, i) => `<a class="page" href="/search?q=${query}&page=${i + 1}">${i + 1}</a>`).join("")}${
            pageNo < pages ? `<a class="next" rel="next" href="/search?q=${query}&page=${pageNo + 1}">Next</a>` : ""
          }</nav>`
        : "";
    return page(
      "Jobs",
      `<header><a href="/">Job board</a><form action="/search"><input name="q" value="${query}"><button>Search</button></form></header>
       <main><h1>${all.length} jobs</h1>${shown.length === 0 ? '<p class="no-results">No jobs match your search</p>' : ""}
       ${redesigned ? `<ul class="results">${cards.join("")}</ul>` : `<section class="results">${cards.join("")}</section>`}${pager}</main>`,
    );
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const host = (req.headers.host ?? "").split(":")[0];
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const body = req.method === "POST" ? await read(req) : "";
    if (req.method === "POST") posts.push({ host, path: url.pathname, body });
    else hits.push(`${host} ${url.pathname}`);
    const cookie = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    const signedIn = cookie !== undefined && sessions.has(cookie);
    const html = (status: number, content: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers }).end(content);
    };
    const redirect = (to: string, headers: Record<string, string> = {}) => {
      res.writeHead(302, { location: to, ...headers }).end();
    };
    const credentialsOk = () => {
      const form = new URLSearchParams(body);
      return form.get("email") === USERNAME && form.get("password") === PASSWORD;
    };
    const newSession = () => {
      const sid = randomBytes(16).toString("hex");
      sessions.add(sid);
      return `sid=${sid}; HttpOnly; Path=/`;
    };

    if (host === "sso.localhost") {
      const back = url.searchParams.get("return") ?? "";
      if (url.pathname === "/authorize" && req.method === "GET")
        return html(200, loginForm(`/authorize?return=${encodeURIComponent(back)}`));
      if (url.pathname === "/authorize" && credentialsOk()) return redirect(`${back}?code=granted`);
      return html(200, loginForm(`/authorize?return=${encodeURIComponent(back)}`, "Wrong email or password"));
    }
    if (host === "app.localhost.evil.localhost") return html(200, loginForm("/login"));
    if (host === "ats.localhost") {
      if (url.pathname === "/jobs/7")
        return html(200, page("Senior .NET Developer", `<h1>Senior .NET Developer</h1><p>Acme · Sofia</p><a class="apply" href="/apply/7">Apply now</a>`));
      if (url.pathname === "/apply/7" && req.method === "GET") return html(200, applyForm());
      if (url.pathname === "/jobs/8") return html(200, inlineForm());
      if (url.pathname === "/apply/8") {
        res.writeHead(200, { "content-type": "application/json" }).end('{"status":"mail_sent"}');
        return;
      }
      if (url.pathname === "/apply/7") return html(200, page("Thanks", "<h1>Thank you!</h1><p>Your application was received.</p>"));
      // M10-S1: a form that uploads the file the moment it is picked.
      if (url.pathname === "/quick-apply")
        return html(
          200,
          page(
            "Quick apply",
            `<form action="/quick-apply" method="post"><label for="qname">Name</label><input id="qname" name="name" required>
             <label for="resume">Résumé</label><input id="resume" name="resume" type="file">
             <button type="submit">Apply</button></form>
             <script>document.getElementById("resume").addEventListener("change", (e) => {
               const data = new FormData(); data.append("file", e.target.files[0]); fetch("/uploads", { method: "POST", body: data });
             });</script>`,
          ),
        );
      return html(404, page("Not found", "No such page"));
    }
    if (host === "jobs.localhost") {
      if (url.pathname === "/search") return html(200, jobBoard(url));
      const job = JOBS.find((j) => url.pathname === `/jobs/${j.id}`);
      return job ? html(200, page(job.title, `<h1>${job.title}</h1><p>${job.company}</p>`)) : html(404, page("Not found", "No such job"));
    }
    if (host !== "app.localhost") return html(404, page("Not found", "No such site"));

    switch (url.pathname) {
      case "/account":
        return signedIn ? html(200, page("Account", `<h1 id="ready">Welcome back, Ana</h1><p>3 new job matches</p>`)) : redirect("/login");
      case "/login":
        if (req.method === "GET") return html(200, loginForm("/login"));
        return credentialsOk()
          ? redirect("/account", { "set-cookie": newSession() })
          : html(200, loginForm("/login", "Wrong email or password"));
      case "/sso-account":
        if (signedIn) return redirect("/account");
        return redirect(`http://sso.localhost:${port}/authorize?return=${encodeURIComponent(`http://app.localhost:${port}/sso-callback`)}`);
      case "/sso-callback":
        return url.searchParams.get("code") === "granted"
          ? redirect("/account", { "set-cookie": newSession() })
          : html(403, page("No", "denied"));
      case "/captcha":
        return html(
          200,
          page(
            "Check",
            `<div id="challenge"><div class="g-recaptcha" data-sitekey="test-key">I'm not a robot</div></div>
             <script>
               const timer = setInterval(async () => {
                 const state = await (await fetch("/captcha/state")).text();
                 if (state === "solved") {
                   clearInterval(timer);
                   document.getElementById("challenge").outerHTML = '<p id="ready">Solved content</p>';
                 }
               }, 200);
             </script>`,
          ),
        );
      case "/captcha/state":
        res.writeHead(200, { "content-type": "text/plain" }).end(solved ? "solved" : "open");
        return;
      case "/slow":
        return html(200, page("Slow", "<p>Still loading…</p>"));
      case "/downloads":
        return html(
          200,
          page(
            "Files",
            Object.keys(FILES)
              .map((name) => `<a href="/files/${name}" download>${name}</a>`)
              .join("<br>"),
          ),
        );
      default: {
        const file = url.pathname.startsWith("/files/") ? FILES[url.pathname.slice("/files/".length)] : undefined;
        if (file) {
          res.writeHead(200, { "content-type": file.type, "content-disposition": "attachment" }).end(file.content);
          return;
        }
        return html(404, page("Not found", "No such page"));
      }
    }
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => res.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    url: (host, path) => `http://${host}.localhost:${port}${path}`,
    posts,
    hits,
    sessions,
    solveCaptcha: () => (solved = true),
    redesignJobs: () => (redesigned = true),
    addRequiredField: () => (extraField = true),
    reset: () => {
      posts.length = 0;
      hits.length = 0;
      solved = false;
      redesigned = false;
      extraField = false;
      quiz = 0;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function read(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
