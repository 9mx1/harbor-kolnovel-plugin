// Harbor eBook source plugin: ملوك الروايات (Kol Novel) - https://kolnovel.com
//
// Search, detail, chapter list and chapter text use the site's public JSON API
// (wp-json/app/v2, the same one its own reader uses), which answers in about a
// second. The rendered series pages take 15-60 s and time out on long novels.
// Browse still parses the series archive page because it supports sort/status.

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

function abs(url) {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return encodeURI(decodeURI(url));
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

const ORDINALS = {
  "الأول": 1, "الاول": 1, "الحادي": 1, "الثاني": 2, "الثالث": 3, "الرابع": 4, "الخامس": 5,
  "السادس": 6, "السابع": 7, "الثامن": 8, "التاسع": 9, "العاشر": 10, "العشرون": 20,
};

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

// The site marks fan editions in the title. Harbor discards entries flagged isFanMade.
function fanMade(title) {
  return /(?:fan[ -]?made|fan edition|نسخة\s*ال?فان|نسخة\s*المعجبين)/iu.test(title || "");
}

function mapStatus(text) {
  return STATUS[(text || "").trim().toLowerCase()] || STATUS[(text || "").trim()] || undefined;
}

// API title record -> EBookSummary
function fromApi(t) {
  const title = (t.title || "").trim();
  const alt = (t.alt_name || "").split("|").map((s) => s.trim()).filter(Boolean);
  const authors = (t.authors || []).map((a) => a.name).filter(Boolean);
  return {
    id: String(t.id),
    title,
    altTitle: alt[0],
    altTitles: alt,
    author: authors[0] || t.author || undefined,
    authors: authors.length ? authors : undefined,
    cover: abs(t.cover_url),
    description: t.description ? String(t.description).trim() : undefined,
    year: num(t.year),
    status: mapStatus(t.status),
    genres: (t.genres || []).map((g) => g.name).filter(Boolean),
    chapters: num(t.chapter_count),
    score: num(t.score),
    siteUrl: abs(t.url),
    isFanMade: fanMade(title),
  };
}

function browseQuery(tagId) {
  const p = new URLSearchParams();
  if (tagId && tagId.startsWith("status:")) p.set("status", tagId.slice(7));
  if (tagId && tagId.startsWith("sort:")) p.set("order", tagId.slice(5));
  const q = p.toString();
  return q ? "&" + q : "";
}

function archiveCard(el) {
  const cover = el.querySelector("a.kol-series-archive__cover");
  const link = el.querySelector("h3 a") || cover;
  const id = cover?.attr("data-kol-series-cover-id");
  if (!link || !id) return null;
  const title = (link.text() || "").trim();
  return {
    id,
    title,
    cover: abs(el.querySelector("img")?.attr("src")),
    status: mapStatus(el.querySelector(".kol-series-archive__status")?.text()),
    description: el.querySelector(".kol-series-archive__excerpt")?.text()?.trim() || undefined,
    genres: el
      .querySelectorAll(".kol-series-archive__genres-list span")
      .map((n) => n.text().trim())
      .filter((t) => t && t !== "·"),
    score: num(el.querySelector(".kol-series-archive__rating b")?.text()),
    siteUrl: abs(link.attr("href")),
    isFanMade: fanMade(title),
  };
}

// Ids from plugin 1.0.0 were series slugs; map them to the numeric title id.
async function titleId(id) {
  if (/^\d+$/.test(id)) return id;
  const doc = await getDoc("/series/" + id + "/");
  const found = doc.querySelector("[data-kol-series-id]")?.attr("data-kol-series-id");
  if (!found) throw new Error("series not found: " + id);
  return found;
}

const plugin = {
  id: "kolnovel",
  name: "ملوك الروايات (Kol Novel)",

  async popular(offset, tagId) {
    const page = Math.floor(offset / ARCHIVE_PAGE_SIZE) + 1;
    const q = browseQuery(tagId);
    const order = q.includes("order=") ? "" : "&order=popular";
    const doc = await getDoc("/series/?paged=" + page + q + order);
    return doc.querySelectorAll("article.kol-series-archive__item").map(archiveCard).filter(Boolean);
  },

  async search(query, offset) {
    const cursor = offset > 0 ? "&cursor=" + offset : "";
    const res = await getJson("/discover?q=" + encodeURIComponent(query) + cursor);
    if (offset > 0 && !res.meta?.next_cursor && !(res.data || []).length) return [];
    return (res.data || []).map(fromApi);
  },

  async detail(id) {
    const res = await getJson("/titles/" + (await titleId(id)));
    return res.data ? fromApi(res.data) : null;
  },

  // reading-list returns 100 chapters per call, oldest first, with a cursor.
  async chapters(id) {
    const tid = await titleId(id);
    const out = [];
    let cursor = "";
    for (let guard = 0; guard < 500; guard++) {
      const res = await getJson("/titles/" + tid + "/reading-list" + (cursor ? "?cursor=" + cursor : ""));
      for (const c of res.data || []) {
        // The volume key comes from the site's own volume field, never from the chapter title.
        const volumeTitle = (c.volume || "").trim() || undefined;
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
  },

  // Chapter body is HTML with one <p> per paragraph. Keep source order.
  async content(chapterId) {
    let html;
    if (/^\d+$/.test(chapterId)) {
      const res = await getJson("/reader/" + chapterId);
      if (res.data?.access && res.data.access.has_access === false) {
        throw new Error("This chapter is locked on kolnovel.com");
      }
      html = res.data?.entry?.content || "";
    } else {
      // Chapter ids from plugin 1.0.0 were page paths.
      const doc = await getDoc("/" + chapterId);
      return doc
        .querySelectorAll("div.epcontent.entry-content > p")
        .map((n) => n.text().trim())
        .filter(Boolean)
        .join("\n\n");
    }
    const doc = harbor.parseHtml("<div id='kol-body'>" + html + "</div>");
    return doc
      // Some chapters wrap their paragraphs in div.epcontent; selector lists keep DOM order.
      .querySelectorAll("#kol-body > p, #kol-body > blockquote, #kol-body > .epcontent > p, #kol-body > .epcontent > blockquote")
      .map((n) => n.text().replace(/ /g, " ").trim())
      .filter(Boolean)
      .join("\n\n");
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
