import test from "node:test";
import assert from "node:assert/strict";
import { chineseKind } from "../src/model.js";
import { episodeFor, playables } from "../src/episodes.js";
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

test("grouped playback excludes webpage players and preserves signed HLS URLs", () => {
  const items = playables(drama(), "drama");
  assert.equal(items.length, 2);
  assert.equal(items[0].episode.key, "episode:1:1:main");
  assert.equal(items[0].group, "m3u8");
  const signed = drama(1, { vod_play_url: "第1集$https://v.example/index.m3u8?token=a$b&expires=1#恶意$javascript:alert(1)" });
  assert.equal(playables(signed, "drama")[0].url, "https://v.example/index.m3u8?token=a$b&expires=1");
});

test("episode labels align across padding and Chinese numerals", () => {
  const labels = ["第01集", "第1集", "第一集", "1", "S01E01"];
  assert.equal(new Set(labels.map(label => episodeFor(label, "测试剧", "drama").key)).size, 1);
  assert.equal(episodeFor("第十二集", "测试剧", "drama").key, "episode:1:12:main");
  assert.notEqual(episodeFor("第1集预告", "测试剧", "drama").key, episodeFor("第1集", "测试剧", "drama").key);
});

test("variety dates, parts and bonus episodes remain separate", () => {
  const show = "奔跑吧兄弟第一季";
  const a = episodeFor(`${show}2014.10.10期`, show, "variety");
  const b = episodeFor("20141010", show, "variety");
  assert.equal(a.key, b.key);
  assert.equal(a.released, "2014-10-10T00:00:00.000Z");
  const labels = ["20261113上", "2026-11-13（下）", "20261113加更", "20261113纯享"];
  assert.equal(new Set(labels.map(x => episodeFor(x, show, "variety").key)).size, 4);
  assert.equal(episodeFor("20261399", show, "variety").released, undefined);
  const items = playables(drama(1, { vod_name: show, vod_play_url: labels.map((l, i) => `${l}$https://v.example/${i}.m3u8`).join("#") }), "variety");
  assert.equal(new Set(items.map(p => p.episode.key)).size, 4);
});

test("dated variety labels ignore redundant broadcast numbers and preserve parts and extras", () => {
  for (const label of ["20260501", "第20260501期", "20260501第2期", "20260501（第二期）"]) {
    assert.equal(episodeFor(label, "奔跑吧第十季", "variety").key, "date:2026-05-01:main", label);
  }
  for (const [label, suffix] of [["20260501第2期上", "上"], ["20260501（第2期下）", "下"],
    ["20260501第2期加更", "加更"], ["20260501第2期会员版", "会员版"]]) {
    assert.equal(episodeFor(label, "奔跑吧第十季", "variety").key, `date:2026-05-01:${suffix}`, label);
  }
});
