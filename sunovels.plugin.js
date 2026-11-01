// Harbor eBook source plugin: شمس الروايات (Sunovels) - https://sunovels.com
//
// The site is a server-rendered Next.js app, so every page already contains its
// data as HTML. Library cards lazy-load their covers, so cover URLs are read
// from the React payload embedded in the same page.

const BASE = "https://sunovels.com";
const LIBRARY_PAGE_SIZE = 24; // /library?page=N, zero-based
const CHAPTER_PAGE_SIZE = 50; // ?activeTab=chapters&page=N, zero-based
const TIMEOUT = 30000;

const STATUS = {
  ongoing: "ongoing",
  completed: "completed",
  hiatus: "hiatus",
  "مستمر": "ongoing",
  "مستمرة": "ongoing",
  "مكتمل": "completed",
  "مكتملة": "completed",
  "متوقف": "hiatus",
  "متوقفة": "hiatus",
};

async function getHtml(path) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await harbor.http(BASE + path, { responseType: "text", timeoutMs: TIMEOUT });
      if (!res.ok) throw new Error("http " + res.status + " for " + path);
      return res.body;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// Normalize to a single level of percent-encoding; malformed escapes are kept as-is.
function encodeOnce(url) {
  try {
    return encodeURI(decodeURI(url));
  } catch (e) {
    return url;
  }
}

function abs(url) {
  if (!url || /placeholder/.test(url)) return undefined;
  if (/^https?:\/\//i.test(url)) return encodeOnce(url);
  if (url.startsWith("//")) return "https:" + url;
  return BASE + (url.startsWith("/") ? "" : "/") + encodeOnce(url);
}

function num(text) {
  if (text === undefined || text === null) return undefined;
  const latin = String(text).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  if (!/\d/.test(latin)) return undefined;
  const n = Number(latin.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function clean(text) {
  return (text || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

function mapStatus(text) {
  const t = clean(text);
  return STATUS[t.toLowerCase()] || STATUS[t] || undefined;
}

// Harbor discards entries flagged isFanMade.
function fanMade(title) {
  return /(?:fan[ -]?made|fan edition|نسخة\s*ال?فان|نسخة\s*المعجبين)/iu.test(title || "");
}

function slugOf(href) {
  return ((href || "").match(/^\/novel\/([^/?#]+)\/?$/) || [])[1];
}

// Cover URLs per novel slug, read from the embedded React payload.
function coverMap(html) {
  const flat = html.replace(/\\"/g, '"');
  const map = {};
  for (const m of flat.matchAll(/"href":"\/novel\/([^"/]+)"[^]{0,200}?"src":"([^"]+)"/g)) {
    if (!map[m[1]]) map[m[1]] = m[2];
  }
  return map;
}

// harbor.parseHtml is asynchronous in Harbor (it parses on the host).
async function cards(html) {
  const doc = await harbor.parseHtml(html);
  const covers = coverMap(html);
  return doc
    .querySelectorAll("li.list-item")
    .map((li) => {
      const a = li.querySelector("a");
      const id = slugOf(a?.attr("href"));
      if (!id) return null;
      const title = clean(li.querySelector("h4")?.text()).replace(/\.\.\.$/, "");
      const badge = li.querySelector(".top");
      return {
        id,
        title,
        cover: abs(covers[id] || li.querySelector("img")?.attr("src")),
        status: mapStatus((badge?.attr("class") || "").replace(/\btop\b/, "")) || mapStatus(badge?.text()),
        siteUrl: BASE + "/novel/" + id,
        isFanMade: fanMade(title),
      };
    })
    .filter(Boolean);
}

// Some pages hide decoy paragraphs with inline stylesheet rules.
function hiddenClasses(html) {
  const hidden = new Set(["d-none"]); // Bootstrap's display:none utility
  const HIDES =
    /display\s*:\s*none|visibility\s*:\s*hidden|text-indent\s*:\s*-\d{3,}|opacity\s*:\s*0(?![.\d])|(?:left|top|bottom|right)\s*:\s*-\d{3,}/i;
  for (const style of html.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || []) {
    for (const rule of style.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!HIDES.test(rule[2])) continue;
      for (const cls of rule[1].matchAll(/\.([A-Za-z_][\w-]*)/g)) hidden.add(cls[1]);
    }
  }
  return hidden;
}

function chapterRows(doc, id) {
  return doc
    .querySelectorAll("ul.chaptersList a")
    .map((a) => {
      const m = (a.attr("href") || "").match(/^\/novel\/[^/]+\/(\d+(?:\.\d+)?)$/);
      if (!m) return null;
      return {
        id: id + "/" + m[1],
        chapter: m[1],
        title: clean(a.querySelector(".chapter-title")?.text() || a.attr("title")) || undefined,
        publishAt: a.querySelector("time")?.attr("datetime") || a.querySelector("time")?.attr("dateTime") || undefined,
        views: num(a.querySelector(".view")?.text()),
      };
    })
    .filter(Boolean);
}

const plugin = {
  id: "sunovels",
  name: "شمس الروايات (Sunovels)",

  async popular(offset, tagId) {
    const page = Math.floor(offset / LIBRARY_PAGE_SIZE);
    const status = tagId && tagId.startsWith("status:") ? "&status=" + (tagId === "status:completed" ? "Completed" : "Ongoing") : "";
    return await cards(await getHtml("/library?page=" + page + status));
  },

  // The search page returns every match at once. A blank query (Harbor's browse
  // view) lists the library instead, since the site's search returns nothing for it.
  async search(query, offset, tagId) {
    if (!clean(query)) return plugin.popular(offset, tagId);
    if (offset > 0) return [];
    return await cards(await getHtml("/search/?title=" + encodeURIComponent(query)));
  },

  async detail(id) {
    const html = await getHtml("/novel/" + id);
    const doc = await harbor.parseHtml(html);
    const head = doc.querySelector(".novel-header");
    if (!head) return null;
    const english = clean(head.querySelector("h1")?.text());
    const arabic = clean(head.querySelector("h3")?.text());
    const title = arabic || english;
    const stats = {};
    head.querySelectorAll(".header-stats span").forEach((s) => {
      stats[clean(s.querySelector("small")?.text())] = clean(s.querySelector("strong")?.text());
    });
    const description = doc
      .querySelectorAll(".info-section p")
      .map((p) => clean(p.text()))
      .filter(Boolean)
      .join("\n\n");
    return {
      id,
      title,
      altTitle: arabic && english && english !== arabic ? english : undefined,
      altTitles: arabic && english && english !== arabic ? [english] : [],
      cover: abs(head.querySelector("figure.cover img")?.attr("src")),
      description: description || clean(doc.querySelector(".info-section")?.text()) || undefined,
      status: mapStatus(stats["الحالة"]),
      genres: head.querySelectorAll("li.tag a").map((a) => clean(a.text())).filter(Boolean),
      chapters: num(stats["الفصول"]),
      score: num(head.querySelector(".rating strong.ms-2")?.text()),
      siteUrl: BASE + "/novel/" + id,
      isFanMade: fanMade(title),
    };
  },

  // The chapter tab is paged server-side: 50 per page, zero-based, oldest first.
  async chapters(id) {
    const path = (page) => "/novel/" + id + "?activeTab=chapters&sort=asc&page=" + page;
    const first = await harbor.parseHtml(await getHtml(path(0)));
    const pages = Math.max(
      1,
      ...first.querySelectorAll(".pagination a[aria-label^=Page]").map((a) => num(a.attr("aria-label")) || 0),
    );
    const out = chapterRows(first, id);
    for (let p = 1; p < pages; p += 5) {
      const batch = [];
      for (let k = p; k < p + 5 && k < pages; k++) batch.push(k);
      const docs = await Promise.all(batch.map(async (k) => await harbor.parseHtml(await getHtml(path(k)))));
      for (const doc of docs) out.push(...chapterRows(doc, id));
    }
    const seen = new Set();
    return out
      .filter((c) => !seen.has(c.id) && seen.add(c.id))
      .map((c, position) => ({ ...c, position }));
  },

  // Chapter text is one <p> per paragraph inside div.chapter-content. Keep DOM order.
  async content(chapterId) {
    const html = await getHtml("/novel/" + chapterId);
    const doc = await harbor.parseHtml(html);
    const hidden = hiddenClasses(html);
    return doc
      .querySelectorAll("div.chapter-content > p, div.chapter-content > blockquote")
      .filter((n) => !(n.attr("class") || "").split(/\s+/).some((c) => hidden.has(c)))
      .map((n) => clean(n.text()))
      .filter(Boolean)
      .join("\n\n");
  },

  async tags() {
    return [
      { id: "status:ongoing", name: "مستمرة", group: "الحالة" },
      { id: "status:completed", name: "مكتملة", group: "الحالة" },
    ];
  },
};
