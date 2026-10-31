// Harbor eBook source plugin: ملوك الروايات (Kol Novel) - https://kolnovel.com
//
// Parses the site's public HTML pages only (the same pages a browser loads).
// Server latency is high (15-50 s per request), so chapter-list pages are fetched
// in small parallel batches and every request is retried once.

const BASE = "https://kolnovel.com";
const PAGE_SIZE = 20; // series archive page size
const CHAPTER_PAGE_SIZE = 24; // chapter list page size
const TIMEOUT = 60000;

const STATUS = {
  "مستمرة": "ongoing",
  "متوقفة": "hiatus",
  "متوقفة مؤقتًا": "hiatus",
  "مكتملة": "completed",
};

async function getDoc(path) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await harbor.http(BASE + path, { responseType: "text", timeoutMs: TIMEOUT });
      if (!res.ok) throw new Error("http " + res.status + " for " + path);
      return harbor.parseHtml(res.body);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function abs(url) {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return BASE + url;
  return BASE + "/" + url;
}

// Arabic-Indic digits and the Arabic thousands separator -> plain number.
function num(text) {
  if (!text) return undefined;
  const latin = text.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  if (!/\d/.test(latin)) return undefined;
  const n = Number(latin.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function slugOf(href) {
  const m = (href || "").match(/\/series\/([^/?#]+)/);
  return m ? m[1] : "";
}

// The site marks fan editions in the title. Harbor discards entries flagged isFanMade.
function fanMade(title) {
  return /(?:fan[ -]?made|fan edition|نسخة\s*ال?فان|نسخة\s*المعجبين)/iu.test(title || "");
}

function mapStatus(text) {
  return STATUS[(text || "").trim()] || undefined;
}

function browseQuery(tagId) {
  const p = new URLSearchParams();
  if (tagId && tagId.startsWith("status:")) p.set("status", tagId.slice(7));
  if (tagId && tagId.startsWith("sort:")) p.set("order", tagId.slice(5));
  const q = p.toString();
  return q ? "&" + q : "";
}

function archiveCard(el) {
  const link = el.querySelector("h3 a") || el.querySelector("a.kol-series-archive__cover");
  if (!link) return null;
  const id = slugOf(link.attr("href"));
  if (!id) return null;
  const title = (link.text() || "").trim();
  const img = el.querySelector("img");
  return {
    id,
    title,
    cover: abs(img?.attr("src")),
    status: mapStatus(el.querySelector(".kol-series-archive__status")?.text()),
    description: el.querySelector(".kol-series-archive__excerpt")?.text()?.trim() || undefined,
    genres: el
      .querySelectorAll(".kol-series-archive__genres-list span")
      .map((n) => n.text().trim())
      .filter((t) => t && t !== "·"),
    score: num(el.querySelector(".kol-series-archive__rating b")?.text()),
    siteUrl: BASE + "/series/" + id + "/",
    isFanMade: fanMade(title),
  };
}

function searchCard(el) {
  const link = el.querySelector("h3 a");
  if (!link) return null;
  const id = slugOf(link.attr("href"));
  if (!id) return null;
  const title = (link.text() || "").trim();
  const img = el.querySelector("img");
  const meta = el.querySelectorAll(".kol-search__meta span").map((n) => n.text().trim());
  return {
    id,
    title,
    cover: abs(img?.attr("src")),
    status: mapStatus(meta[0]),
    score: num((meta[1] || "").replace("★", "")),
    siteUrl: BASE + "/series/" + id + "/",
    isFanMade: fanMade(title),
  };
}

function chapterRow(li, position) {
  const a = li.querySelector("a.kol-series-chapter__link");
  const href = a?.attr("href") || "";
  const path = href.replace(/^https?:\/\/[^/]+\//, "").replace(/^\//, "");
  if (!path) return null;
  const volumeTitle = li.querySelector(".kol-series-chapter__volume")?.text()?.trim() || undefined;
  // The volume key comes from the site's own volume label element, never from the chapter title.
  const volMatch = volumeTitle && volumeTitle.match(/^[^\d٠-٩]*([\d٠-٩]+)/);
  return {
    id: path,
    chapter: li.querySelector("[data-kol-chapter-number]")?.attr("data-kol-chapter-number") || undefined,
    position,
    title: li.querySelector("[data-kol-chapter-title]")?.text()?.trim() || undefined,
    volume: volMatch ? String(num(volMatch[1])) : undefined,
    volumeTitle,
    publishAt: li.querySelector("time")?.attr("datetime") || undefined,
    views: num(li.querySelector(".kol-series-chapter__views-count")?.text()),
  };
}

function chapterListPath(id, page) {
  return (
    "/series/" + id + "/?chapter_volume=__kol_all__&chapter_search&chapter_order=oldest&chapter_page=" + page
  );
}

const plugin = {
  id: "kolnovel",
  name: "ملوك الروايات (Kol Novel)",

  async popular(offset, tagId) {
    const page = Math.floor(offset / PAGE_SIZE) + 1;
    const q = browseQuery(tagId);
    const order = q.includes("order=") ? "" : "&order=popular";
    const doc = await getDoc("/series/?paged=" + page + q + order);
    return doc.querySelectorAll("article.kol-series-archive__item").map(archiveCard).filter(Boolean);
  },

  async search(query, offset, tagId) {
    const page = Math.floor(offset / PAGE_SIZE) + 1;
    const doc = await getDoc("/?s=" + encodeURIComponent(query) + "&paged=" + page);
    return doc.querySelectorAll("article.kol-search__item").map(searchCard).filter(Boolean);
  },

  async detail(id) {
    const doc = await getDoc("/series/" + id + "/");
    const root = doc.querySelector(".kol-series-editorial__identity") || doc;
    const title = doc.querySelector("h1.kol-series-editorial__title")?.text()?.trim();
    if (!title) return null;
    const all = doc.querySelector("details[data-kol-chapter-volume='__kol_all__']");
    const facts = doc.querySelector(".kol-series-editorial__quick-facts")?.text() || "";
    const year = num((facts.match(/صدر في\s*([\d٠-٩]{4})/) || [])[1]);
    const altTitle = doc.querySelector(".kol-series-editorial__alt-title")?.text()?.trim();
    const statusText = doc
      .querySelector(".kol-series-editorial__quick-fact--status")
      ?.text()
      ?.replace(/^\s*الحالة/, "");
    return {
      id,
      title,
      altTitle: altTitle || undefined,
      altTitles: altTitle ? [altTitle] : [],
      author:
        root.querySelector(".kol-series-editorial__byline")?.text()?.replace(/^\s*بقلم\s*/, "").trim() || undefined,
      cover: abs(doc.querySelector(".kol-series-editorial img")?.attr("src")),
      description: doc.querySelector("[itemprop=description]")?.text()?.trim() || undefined,
      status: mapStatus(statusText),
      year,
      genres: doc.querySelectorAll(".kol-series-editorial__genres a").map((n) => n.text().trim()).filter(Boolean),
      chapters: num(all?.querySelector(".kol-series-editorial__volume-count")?.text()),
      siteUrl: BASE + "/series/" + id + "/",
      isFanMade: fanMade(title),
    };
  },

  // The flat list is paged server-side (24 per page, oldest first).
  async chapters(id) {
    const first = await getDoc(chapterListPath(id, 1));
    const pages =
      Number(first.querySelector("details[data-kol-chapter-volume='__kol_all__']")?.attr("data-kol-volume-pages")) || 1;
    const out = [];
    const pushPage = (doc, page) => {
      doc.querySelectorAll("li.kol-series-chapter").forEach((li, i) => {
        const c = chapterRow(li, (page - 1) * CHAPTER_PAGE_SIZE + i);
        if (c) out.push(c);
      });
    };
    pushPage(first, 1);
    const todo = [];
    for (let p = 2; p <= pages; p++) todo.push(p);
    const BATCH = 5; // Harbor allows six in-flight requests
    for (let i = 0; i < todo.length; i += BATCH) {
      const slice = todo.slice(i, i + BATCH);
      const docs = await Promise.all(slice.map((p) => getDoc(chapterListPath(id, p))));
      docs.forEach((doc, k) => pushPage(doc, slice[k]));
    }
    out.sort((a, b) => a.position - b.position);
    return out;
  },

  // Chapter text lives in div.epcontent as one <p> per paragraph. Keep DOM order.
  async content(chapterId) {
    const doc = await getDoc("/" + chapterId);
    const blocks = doc.querySelectorAll("div.epcontent.entry-content > p");
    return blocks.map((n) => n.text().trim()).filter(Boolean).join("\n\n");
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
