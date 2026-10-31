// Harbor eBook source plugin: ملوك الروايات (Kol Novel) - https://kolnovel.com
//
// Primary path: the site's public JSON API (wp-json/app/v2, the one its own
// reader uses). It answers in about a second and lists 100 chapters per call.
// Fallback: the rendered HTML pages, used whenever the API errors. The site
// switches between two themes, so every HTML parser understands both:
//   new "starless" theme  (kol-series-editorial, kol-series-chapter, paged lists)
//   classic theme         (maindet cards, sertoinfo, eplister with every chapter)

const BASE = "https://kolnovel.com";
const API = BASE + "/wp-json/app/v2";
const ARCHIVE_PAGE_SIZE = 20;
const TIMEOUT = 45000;

const STATUS = {
  "مستمرة": "ongoing",
  "متوقفة": "hiatus",
  "متوقفة مؤقتًا": "hiatus",
  "مكتملة": "completed",
  ongoing: "ongoing",
  completed: "completed",
  hiatus: "hiatus",
  dropped: "hiatus",
};

const ORDINALS = {
  "الأول": 1, "الاول": 1, "الحادي": 1, "الثاني": 2, "الثالث": 3, "الرابع": 4, "الخامس": 5,
  "السادس": 6, "السابع": 7, "الثامن": 8, "التاسع": 9, "العاشر": 10, "العشرون": 20,
};

// ---- helpers ---------------------------------------------------------------

async function request(url, responseType) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await harbor.http(url, { responseType, timeoutMs: TIMEOUT });
      if (!res.ok) throw new Error("http " + res.status + " for " + url);
      return res.body;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function getJson(path) {
  const body = await request(API + path, "json");
  return typeof body === "string" ? JSON.parse(body) : body;
}

async function getDoc(path) {
  return harbor.parseHtml(await request(BASE + path, "text"));
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
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return encodeOnce(url);
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return BASE + url;
  return BASE + "/" + url;
}

// Arabic-Indic digits and the Arabic thousands separator -> plain number.
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

// The site marks fan editions in the title. Harbor discards entries flagged isFanMade.
function fanMade(title) {
  return /(?:fan[ -]?made|fan edition|نسخة\s*ال?فان|نسخة\s*المعجبين)/iu.test(title || "");
}

function mapStatus(text) {
  const t = clean(text);
  return STATUS[t.toLowerCase()] || STATUS[t] || undefined;
}

// Volume key from the site's volume label ("المجلد 3: ..." or "المجلد الثالث: ..."),
// never from the chapter title. Unknown wording keeps the label itself as a stable key.
function volumeKey(label) {
  if (!label) return undefined;
  const head = label.split(":")[0];
  const digits = head.match(/[\d٠-٩]+/);
  if (digits) return String(num(digits[0]));
  const words = head.replace(/^\s*(?:ال)?مجلد\s*/, "").trim().split(/\s+/);
  const unit = ORDINALS[words[0]];
  if (unit !== undefined) return String(words[1] === "عشر" ? unit + 10 : unit);
  return head.trim();
}

// WordPress redirects ?post_type=series&p=<id> to the series page.
function seriesPath(tid, extra) {
  return "/?post_type=series&p=" + tid + (extra ? "&" + extra : "");
}

// Ids from plugin 1.0.0 were series slugs; map them to the numeric title id.
async function titleId(id) {
  if (/^\d+$/.test(id)) return id;
  const doc = await getDoc("/series/" + id + "/");
  const found =
    doc.querySelector("[data-kol-series-id]")?.attr("data-kol-series-id") ||
    (doc.querySelector("article[id^='post-']")?.attr("id") || "").replace("post-", "");
  if (!found) throw new Error("series not found: " + id);
  return found;
}

// ---- cards (archive and search, both themes) ---------------------------------

function cardFromApi(t) {
  const title = clean(t.title);
  const alt = (t.alt_name || "").split("|").map(clean).filter(Boolean);
  const authors = (t.authors || []).map((a) => a.name).filter(Boolean);
  return {
    id: String(t.id),
    title,
    altTitle: alt[0],
    altTitles: alt,
    author: authors[0] || t.author || undefined,
    authors: authors.length ? authors : undefined,
    cover: abs(t.cover_url),
    description: t.description ? clean(t.description) : undefined,
    year: num(t.year),
    status: mapStatus(t.status),
    genres: (t.genres || []).map((g) => g.name).filter(Boolean),
    chapters: num(t.chapter_count),
    score: num(t.score),
    siteUrl: abs(t.url),
    isFanMade: fanMade(title),
  };
}

function cardFromHtml(el) {
  // classic theme: <article class="maindet"> with <a class="tip" rel="<id>">
  const tip = el.querySelector("a.tip[rel]");
  // starless theme: archive cover carries the id; search cards only have the slug
  const cover = el.querySelector("[data-kol-series-cover-id]");
  const link = el.querySelector("h2 a, h3 a") || tip || cover;
  if (!link) return null;
  const slug = ((link.attr("href") || "").match(/\/series\/([^/?#]+)/) || [])[1];
  const id = tip?.attr("rel") || cover?.attr("data-kol-series-cover-id") || slug;
  if (!id) return null;
  const title = clean(link.attr("title") || link.text());
  const meta = el.querySelectorAll(".kol-search__meta span").map((n) => clean(n.text()));
  const genres = el
    .querySelectorAll(".mdgenre a, .kol-series-archive__genres-list span")
    .map((n) => clean(n.text()).replace(/^#\s*/, ""))
    .filter((t) => t && t !== "·");
  return {
    id,
    title,
    cover: abs(el.querySelector("img")?.attr("src")),
    status: mapStatus(el.querySelector(".kol-series-archive__status")?.text() || meta[0]),
    description:
      clean(el.querySelector(".contexcerpt, .kol-series-archive__excerpt")?.text()) || undefined,
    genres,
    score: num(
      el.querySelector(".mdminf, .kol-series-archive__rating b")?.text() || (meta[1] || "").replace("★", ""),
    ),
    siteUrl: abs(link.attr("href")),
    isFanMade: fanMade(title),
  };
}

function cardsFromDoc(doc) {
  return doc
    .querySelectorAll("article.maindet, article.kol-series-archive__item, article.kol-search__item")
    .map(cardFromHtml)
    .filter(Boolean);
}

function browseQuery(tagId) {
  const p = new URLSearchParams();
  if (tagId && tagId.startsWith("status:")) p.set("status", tagId.slice(7));
  if (tagId && tagId.startsWith("sort:")) p.set("order", tagId.slice(5));
  const q = p.toString();
  return q ? "&" + q : "";
}

// ---- detail (HTML, both themes) ------------------------------------------------

function htmlDetail(doc, id) {
  const title = clean(doc.querySelector("h1.kol-series-editorial__title, h1.entry-title")?.text());
  if (!title) return null;
  // classic theme facts are <span class="sername">label</span><span class="serval">value</span>
  const facts = {};
  const names = doc.querySelectorAll(".sertoauth .sername");
  const values = doc.querySelectorAll(".sertoauth .serval");
  names.forEach((n, i) => (facts[clean(n.text())] = clean(values[i]?.text())));
  const starlessFacts = doc.querySelector(".kol-series-editorial__quick-facts")?.text() || "";
  const altTitle = clean(doc.querySelector(".kol-series-editorial__alt-title, .alter")?.text());
  const all = doc.querySelector("details[data-kol-chapter-volume='__kol_all__']");
  return {
    id,
    title,
    altTitle: altTitle || undefined,
    altTitles: altTitle ? [altTitle] : [],
    author:
      facts["الكاتب"] ||
      clean(doc.querySelector(".kol-series-editorial__byline")?.text()).replace(/^بقلم\s*/, "") ||
      undefined,
    cover: abs(doc.querySelector(".sertothumb img, .kol-series-editorial img")?.attr("src")),
    description: clean(doc.querySelector(".sersys, [itemprop=description]")?.text()) || undefined,
    status: mapStatus(
      doc.querySelector(".sertostat, .kol-series-editorial__quick-fact--status")?.text()?.replace(/الحالة/, ""),
    ),
    year: num(facts["صدر في سنة"] || (starlessFacts.match(/صدر في\s*([\d٠-٩]{4})/) || [])[1]),
    originalLanguage: facts["اللغة الأم"] || undefined,
    genres: doc
      .querySelectorAll(".sertogenre a, .genxed a, .kol-series-editorial__genres a")
      .map((n) => clean(n.text()))
      .filter(Boolean),
    chapters:
      num(all?.querySelector(".kol-series-editorial__volume-count")?.text()) ||
      doc.querySelectorAll(".eplister li").length ||
      undefined,
    siteUrl: BASE + seriesPath(id),
    isFanMade: fanMade(title),
  };
}

// ---- chapters --------------------------------------------------------------------

// reading-list returns 100 chapters per call, oldest first, with a cursor.
async function apiChapters(tid) {
  const out = [];
  let cursor = "";
  for (let guard = 0; guard < 500; guard++) {
    const res = await getJson("/titles/" + tid + "/reading-list" + (cursor ? "?cursor=" + cursor : ""));
    for (const c of res.data || []) {
      // The volume key comes from the site's own volume field, never from the chapter title.
      const volumeTitle = clean(c.volume) || undefined;
      out.push({
        id: String(c.id),
        chapter: c.number ? String(c.number) : undefined,
        position: out.length,
        title: c.title || undefined,
        volume: volumeKey(volumeTitle),
        volumeTitle,
        publishAt: c.published_at || undefined,
      });
    }
    if (!res.meta?.has_more || !res.meta.next_cursor) break;
    cursor = res.meta.next_cursor;
  }
  return out;
}

// Classic theme: every chapter is on the series page, newest first.
function classicChapters(doc) {
  const rows = doc.querySelectorAll(".eplister li").slice().reverse();
  return rows
    .map((li, position) => {
      const id = li.attr("data-ID") || li.attr("data-id");
      if (!id) return null;
      const label = clean(li.querySelector(".epl-num")?.text());
      return {
        id,
        chapter: (label.match(/الفصل\s*([\d٠-٩.]+)/) || [])[1] || undefined,
        position,
        title: clean(li.querySelector(".epl-title")?.text()) || label || undefined,
        publishAt: clean(li.querySelector(".epl-date")?.text()) || undefined,
      };
    })
    .filter(Boolean);
}

// Starless theme: the list is paged server-side, 24 chapters per page, oldest first.
async function starlessChapters(first, tid) {
  const listQuery = (page) =>
    "chapter_volume=__kol_all__&chapter_search&chapter_order=oldest&chapter_page=" + page;
  const pages =
    Number(first.querySelector("details[data-kol-chapter-volume='__kol_all__']")?.attr("data-kol-volume-pages")) || 1;
  const out = [];
  const pushPage = (doc, page) => {
    doc.querySelectorAll("li.kol-series-chapter").forEach((li, i) => {
      const id = li.attr("data-chapter-id");
      if (!id) return;
      const volumeTitle = clean(li.querySelector(".kol-series-chapter__volume")?.text()) || undefined;
      out.push({
        id,
        chapter: li.querySelector("[data-kol-chapter-number]")?.attr("data-kol-chapter-number") || undefined,
        position: (page - 1) * 24 + i,
        title: clean(li.querySelector("[data-kol-chapter-title]")?.text()) || undefined,
        volume: volumeKey(volumeTitle),
        volumeTitle,
        publishAt: li.querySelector("time")?.attr("datetime") || undefined,
        views: num(li.querySelector(".kol-series-chapter__views-count")?.text()),
      });
    });
  };
  for (let p = 1; p <= pages; p += 5) {
    const batch = [];
    for (let k = p; k < p + 5 && k <= pages; k++) batch.push(k);
    const docs = await Promise.all(batch.map((k) => getDoc(seriesPath(tid, listQuery(k)))));
    docs.forEach((doc, j) => pushPage(doc, batch[j]));
  }
  out.sort((a, b) => a.position - b.position);
  return out;
}

async function htmlChapters(tid) {
  const doc = await getDoc(seriesPath(tid));
  if (doc.querySelector(".eplister li")) return classicChapters(doc);
  return starlessChapters(doc, tid);
}

// ---- content ---------------------------------------------------------------------

function paragraphs(doc, root) {
  // Some chapters wrap their paragraphs in div.epcontent; selector lists keep DOM order.
  return doc
    .querySelectorAll(
      root + " > p, " + root + " > blockquote, " + root + " > .epcontent > p, " + root + " > .epcontent > blockquote",
    )
    .map((n) => clean(n.text()))
    .filter(Boolean)
    .join("\n\n");
}

// The classic theme interleaves decoy copies of paragraphs, hidden by per-page
// random class names. Harbor's parser drops hidden nodes; as a second line of
// defence, read this page's own stylesheet and skip any class it hides.
function hiddenClasses(html) {
  const hidden = new Set();
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

async function htmlContent(path) {
  const html = await request(BASE + path, "text");
  const doc = harbor.parseHtml(html);
  const hidden = hiddenClasses(html);
  return doc
    .querySelectorAll("div.epcontent.entry-content > p, div.epcontent.entry-content > blockquote")
    .filter((n) => !(n.attr("class") || "").split(/\s+/).some((c) => hidden.has(c)))
    .map((n) => clean(n.text()))
    .filter(Boolean)
    .join("\n\n");
}

// ---- provider --------------------------------------------------------------------

const plugin = {
  id: "kolnovel",
  name: "ملوك الروايات (Kol Novel)",

  async popular(offset, tagId) {
    const page = Math.floor(offset / ARCHIVE_PAGE_SIZE) + 1;
    const q = browseQuery(tagId);
    const order = q.includes("order=") ? "" : "&order=popular";
    // starless pages with ?paged=, the classic theme with ?page=
    const doc = await getDoc("/series/?paged=" + page + "&page=" + page + q + order);
    return cardsFromDoc(doc);
  },

  async search(query, offset, tagId) {
    // A blank query (Harbor's browse view) lists the catalog.
    if (!clean(query)) return plugin.popular(offset, tagId);
    try {
      const cursor = offset > 0 ? "&cursor=" + offset : "";
      const res = await getJson("/discover?q=" + encodeURIComponent(query) + cursor);
      if (offset > 0 && !res.meta?.next_cursor && !(res.data || []).length) return [];
      return (res.data || []).map(cardFromApi);
    } catch (e) {
      const page = Math.floor(offset / ARCHIVE_PAGE_SIZE) + 1;
      return cardsFromDoc(await getDoc("/?s=" + encodeURIComponent(query) + "&paged=" + page));
    }
  },

  async detail(id) {
    const tid = await titleId(id);
    try {
      const res = await getJson("/titles/" + tid);
      if (res.data) return cardFromApi(res.data);
    } catch (e) {
      // API down: fall through to the rendered series page.
    }
    return htmlDetail(await getDoc(seriesPath(tid)), String(tid));
  },

  async chapters(id) {
    const tid = await titleId(id);
    try {
      const list = await apiChapters(tid);
      if (list.length) return list;
    } catch (e) {
      // API down: fall through to the rendered series page.
    }
    return htmlChapters(tid);
  },

  // Chapter body is HTML with one <p> per paragraph. Keep source order.
  async content(chapterId) {
    if (!/^\d+$/.test(chapterId)) return htmlContent("/" + chapterId); // plugin 1.0.0 page paths
    let res;
    try {
      res = await getJson("/reader/" + chapterId);
    } catch (e) {
      return htmlContent("/?p=" + chapterId); // WordPress redirects to the chapter page
    }
    if (res.data?.access && res.data.access.has_access === false) {
      throw new Error("This chapter is locked on kolnovel.com");
    }
    const doc = harbor.parseHtml("<div id='kol-body'>" + (res.data?.entry?.content || "") + "</div>");
    return paragraphs(doc, "#kol-body");
  },

  async tags() {
    return [
      { id: "status:ongoing", name: "مستمرة", group: "الحالة" },
      { id: "status:completed", name: "مكتملة", group: "الحالة" },
      { id: "status:hiatus", name: "متوقفة مؤقتًا", group: "الحالة" },
      { id: "sort:popular", name: "الأكثر رواجًا", group: "الترتيب" },
      { id: "sort:rating", name: "الأعلى تقييمًا", group: "الترتيب" },
    ];
  },
};
