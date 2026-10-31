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
 * - jobs.localhost: a job board, /search?q=net in three pages (JOBS), an ad between the cards; redesignJobs() changes
 *   its markup.
 */
export async function startFixtureSites(): Promise<FixtureSites> {
  const posts: FixtureSites["posts"] = [];
  const hits: string[] = [];
  const sessions = new Set<string>();
  let solved = false;
  let redesigned = false;

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
    reset: () => {
      posts.length = 0;
      hits.length = 0;
      solved = false;
      redesigned = false;
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
