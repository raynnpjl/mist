import test from "node:test";
import assert from "node:assert/strict";
import { chineseKind } from "../src/model.js";
import { normalizeEpisode, extractPlayback } from "../src/episodes.js";
import { drama } from "./fixtures.js";

test("Chinese filtering uses origin/category, not dubbed language", () => {
  assert.equal(chineseKind(drama()), "drama");
  assert.equal(chineseKind(drama(1, { type_name: "动作片", vod_area: "香港", vod_play_url: "HD国语$https://v.example/movie.m3u8" })), "movie");
  assert.equal(chineseKind(drama(1, { type_name: "动作片", vod_area: "美国", vod_lang: "国语" })), undefined);
  assert.equal(chineseKind(drama(1, { type_name: "剧情片", vod_area: "" })), undefined);
  assert.equal(chineseKind(drama(1, { type_name: "台湾剧", vod_area: "" })), "drama");
  assert.equal(chineseKind(drama(1, { type_name: "电影片" })), undefined);
  for (const type_name of ["伦理片", "预告片", "日本动漫", "现代都市", "日韩综艺", "电影解说"]) {
    assert.equal(chineseKind(drama(1, { type_name })), undefined);
  }
});

test("Chinese animation categories allow episodic animation without admitting foreign anime", () => {
  for (const type_name of ["国产动漫", "中国动漫", "大陆动漫", "港台动漫", "动漫", "动漫片"]) {
    assert.equal(chineseKind(drama(1, { type_name })), "animation", type_name);
    assert.equal(chineseKind(drama(1, { type_name, vod_area: "国产" })), "animation", type_name);
    assert.equal(chineseKind(drama(1, { type_name, vod_area: "日本", vod_lang: "国语" })), undefined, type_name);
  }
  for (const type_name of ["国产动漫", "中国动漫", "大陆动漫", "港台动漫"]) {
    assert.equal(chineseKind(drama(1, { type_name, vod_area: "" })), "animation", type_name);
  }
  for (const type_name of ["动漫", "动漫片"]) {
    assert.equal(chineseKind(drama(1, { type_name, vod_area: "", vod_lang: "国语" })), undefined, type_name);
  }
});

test("Chinese animated films remain movies and require a Chinese origin", () => {
  for (const type_name of ["动画片", "动漫电影", "动画电影"]) {
    const vod = drama(1, { type_name, vod_play_url: "正片$https://v.example/movie.m3u8" });
    assert.equal(chineseKind(vod), "movie", type_name);
    assert.equal(chineseKind({ ...vod, vod_area: "日本", vod_lang: "国语" }), undefined, type_name);
    assert.equal(chineseKind({ ...vod, vod_area: "" }), undefined, type_name);
  }
});

test("playback extraction keeps positions and line identities while rejecting unsupported URLs", () => {
  const signed = drama(1, { vod_play_from: "same$$$same",
    vod_play_url: "第1集$https://v.example/index.m3u8?token=a$b&expires=1#无效$javascript:alert(1)$$$未知$https://v.example/file.mp4" });
  const entries = extractPlayback(signed, "hongniu");
  assert.deepEqual(entries.map(({ provider, showId, line, group, position, label }) => [provider, showId, line, group, position, label]), [
    ["hongniu", "1", 0, "same", 0, "第1集"], ["hongniu", "1", 0, "same", 1, "无效"], ["hongniu", "1", 1, "same", 0, "未知"]
  ]);
  assert.equal(entries[0].url, "https://v.example/index.m3u8?token=a$b&expires=1");
  assert.equal(entries[1].url, undefined);
  assert.ok(entries[2].url?.endsWith("/file.mp4"));
});

test("episode normalization preserves independent date, period and part evidence", () => {
  for (const label of ["第十二期", "第12集", "EP12", "E12", "Episode 12", "ＥＰ１２", "12"]) {
    assert.equal(normalizeEpisode(label).number, 12, label);
  }
  for (const date of ["20240517", "2024-05-17", "2024/05/17", "2024.05.17", "2024年5月17日", "２０２４／５／１７"]) {
    const item = normalizeEpisode(`節目名稱 ${date}（第十二期下）`, ["節目名稱"]);
    assert.equal(item.date, "2024-05-17", date);
    assert.equal(item.number, 12, date);
    assert.equal(item.part, "下", date);
  }
  for (const label of ["05-17", "5月17日", "0517"]) assert.equal(normalizeEpisode(label).monthDay, "05-17");
  assert.equal(normalizeEpisode("0517").number, 517);
  assert.equal(normalizeEpisode("20240230").date, undefined);
});

test("classifies edition markers without treating narrative uses as editions", () => {
  for (const [label, category] of [
    ["第1期 会员加更", "member_extra"], ["第1期加更版", "member_extra"], ["第1期舞台纯享", "alternate"],
    ["第1期加长版", "extended"], ["第1期未刪減版", "extended"], ["第1期幕后", "behind_scenes"],
    ["第1期花絮", "behind_scenes"], ["第1期下期预告", "preview"], ["先导片", "preview"], ["番外", "special"],
    ["特别篇", "special"], ["大礼包", "unknown"], ["第1期：会员加更计划", "unknown"], ["第1期 收官之夜", "regular_candidate"]
  ]) assert.equal(normalizeEpisode(label).contentType, category, label);
});
