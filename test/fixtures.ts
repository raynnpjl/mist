import { Pool } from "../src/cache.js";
import { Fetcher, Provider, SOURCES } from "../src/providers.js";
import { Vod } from "../src/model.js";
import { MediaInspector, MediaProbe } from "../src/media.js";

export const TEST_SOURCES = SOURCES.map(source => ({ ...source, url: `https://${source.id}.example/api.php/provide/vod` }));

export function drama(id = 1, overrides: Vod = {}): Vod {
  return { vod_id: id, vod_name: `测试剧${id}`, type_id: 13, type_name: "国产剧", vod_area: "中国大陆",
    vod_year: "2024", vod_actor: "演员甲,演员乙", vod_director: "导演甲", vod_lang: "国语",
    vod_content: "<p>剧集简介</p>", vod_pic: "https://images.example/poster.jpg", vod_play_from: "web$$$m3u8",
    vod_play_url: `第01集$https://video.example/share/${id}#第02集$https://video.example/share/${id}-2$$$第01集$https://video.example/${id}/1.m3u8#第02集$https://video.example/${id}/2.m3u8`,
    ...overrides };
}

export function fixtures(records: Vod[], sourceCount = 2, pageSize = 20) {
  const requests: URL[] = [];
  const fetcher: Fetcher = async (input, options) => {
    const url = new URL(String(input));
    requests.push(url);
    const first = records[0] || drama();
    const year = String(first.vod_year);
    if (url.hostname === "api.themoviedb.org") {
      if (url.pathname.endsWith("/authentication")) return Response.json({ success: true });
      if (url.pathname.includes("/find/")) return Response.json(url.pathname.endsWith("/tt26235088") ?
        { tv_results: [{ id: 210757 }], movie_results: [{ id: 210757 }] } : { tv_results: [], movie_results: [] });
      if (url.pathname.includes("/episode/")) {
        const episode = Number(url.pathname.split("/").at(-1));
        return Response.json({ name: `Episode ${episode}`, air_date: `${year}-11-${episode === 1 ? "13" : "14"}` });
      }
      if (!url.pathname.endsWith("/210757")) return new Response("Not found", { status: 404 });
      return Response.json({ id: 210757, original_name: first.vod_name, original_title: first.vod_name,
        name: first.vod_name, first_air_date: `${year}-01-01`, release_date: `${year}-01-01`,
        origin_country: ["CN"], external_ids: { imdb_id: "tt26235088" } });
    }
    if ((options?.headers as Record<string, string>)["User-Agent"] !== "Mozilla/5.0") throw new Error("Missing UA");
    if (url.pathname.endsWith(".m3u8")) return new Response("#EXTM3U\n#EXTINF:10,\nsegment.ts\n");
    if (url.pathname.endsWith(".ts")) return new Response(new Uint8Array(256 * 1024).fill(0x47),
      { status: 206, headers: { "Content-Type": "video/mp2t" } });
    if (url.searchParams.get("ac") === "list") return Response.json({ code: 1, list: [], class: [
      { type_id: 13, type_name: "国产剧" }, { type_id: 6, type_name: "动作片" }, { type_id: 25, type_name: "大陆综艺" }
    ] });
    let items = records;
    const id = url.searchParams.get("ids"), search = url.searchParams.get("wd"), category = url.searchParams.get("t");
    if (id) items = items.filter(v => String(v.vod_id) === id);
    if (search) items = items.filter(v => String(v.vod_name).includes(search));
    if (category) items = items.filter(v => String(v.type_id) === category);
    const page = Number(url.searchParams.get("pg") || 1);
    const data = items.slice((page - 1) * pageSize, page * pageSize).map(v => ({ ...v,
      vod_play_url: String(v.vod_play_url).replaceAll("video.example", url.hostname) }));
    return Response.json({ code: 1, pagecount: Math.ceil(items.length / pageSize), list: data });
  };
  const pool = new Pool(6);
  const probe: MediaProbe = async () => ({ width: 1920, height: 1080, bitrate: 2_500_000,
    videoCodec: "h264", audioCodec: "aac", channelLayout: "stereo" });
  return { requests, fetcher, probe, inspector: new MediaInspector(fetcher, probe),
    providers: TEST_SOURCES.slice(0, sourceCount).map(s => new Provider(s, pool, fetcher)) };
}
