import { type EpisodeLabel, type PlaybackEntry, normalizeEpisode } from "./episodes.js";
import type { ApiSeason } from "./metadata.js";

export interface SeasonScope {
  providerSeason: number;
  collection: boolean;
  localNumbering: boolean;
  fullBroadcast: boolean;
}

type Reason = "episode_number" | "air_date" | "contextual_date" | "episode_title" | "anchored_finale" |
  "same_line_parent" | "season_mismatch" | "part_mismatch" | "conflicting_evidence" | "unresolved_year" | "unrecognized_label" |
  "episode_not_found" | "extra_parent_unresolved" | "preview" | "invalid_url" | "duplicate_identity";

interface Result {
  entry: PlaybackEntry;
  label: EpisodeLabel;
  status: "confirmed" | "ambiguous" | "unmatched";
  reason: Reason;
  episode?: number;
}

export interface SeasonMatches {
  results: Result[];
  byEpisode: ReadonlyMap<number, Result[]>;
  counts: ReadonlyMap<string, number>;
}

function indexBy<T, K>(entries: T[], keyOf: (entry: T) => K | undefined): Map<K, T[]> {
  const index = new Map<K, T[]>();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (key === undefined) continue;
    const bucket = index.get(key);
    if (bucket) bucket.push(entry);
    else index.set(key, [entry]);
  }
  return index;
}

export function reconcileSeason(entries: PlaybackEntry[], labels: EpisodeLabel[], season: ApiSeason, scope: SeasonScope): SeasonMatches {
  const catalog = season.episodes.map(episode => ({ ...episode, label: normalizeEpisode(episode.name || "") }));
  const byDate = indexBy(catalog, episode => episode.date);
  const byMonthDay = indexBy(catalog, episode => episode.date?.slice(5));
  const byNumber = indexBy(catalog, episode => episode.label.number || episode.number);
  const byTitle = indexBy(catalog, episode => episode.label.descriptor || undefined);
  const byEpisode = new Map(catalog.map(episode => [episode.number, episode]));
  const rows = entries.map((entry, index) => ({ entry, label: labels[index] }));
  const lines = indexBy(rows, row => row.entry.line);
  const results: Result[] = [];

  const sameSeason = (label: EpisodeLabel) => label.season === undefined || label.season === scope.providerSeason ||
    (scope.localNumbering && label.season === 1);
  const catalogPart = (episode: typeof catalog[number]) => scope.fullBroadcast ? undefined : episode.label.part;

  for (const line of lines.values()) {
    const eligible = line.filter(({ entry, label }) => entry.url && sameSeason(label) && label.contentType === "regular_candidate");
    const dateAnchors = eligible.filter(({ label }) => label.date && byDate.has(label.date));
    const compactDates = season.complete ? eligible.flatMap(({ label }) => {
      if (!label.compactDate || !label.monthDay || byNumber.has(label.number!)) return [];
      const dates = byMonthDay.get(label.monthDay);
      return dates?.length === 1 ? [dates[0].number] : [];
    }) : [];
    const increasing = compactDates.every((episode, i) => i === 0 || episode >= compactDates[i - 1]);
    const decreasing = compactDates.every((episode, i) => i === 0 || episode <= compactDates[i - 1]);
    const dateContext = dateAnchors.length > 0 || new Set(eligible.flatMap(({ label }) =>
      label.monthDay && !label.compactDate && byMonthDay.has(label.monthDay) ? [label.monthDay] : [])).size >= 2 ||
      (increasing || decreasing) && new Set(compactDates).size >= 3;

    // Establish a numbering offset only when separate dated regular broadcasts corroborate it.
    const numberedDates = dateAnchors.flatMap(({ label }) => {
      const matches = byDate.get(label.date!)!.filter(episode => catalogPart(episode) === label.part);
      return matches.length === 1 && label.number !== undefined
        ? [{ date: label.date!, offset: (matches[0].label.number || matches[0].number) - label.number }] : [];
    });
    const offset = new Set(numberedDates.map(item => item.date)).size >= 2 &&
      new Set(numberedDates.map(item => item.offset)).size === 1 ? numberedDates[0].offset : 0;

    const select = (row: typeof line[number], between?: { first: number; last: number }): Result => {
      const { entry, label } = row;
      const unmatched = (reason: Reason, status: Result["status"] = "unmatched"): Result => ({ ...row, status, reason });
      if (!entry.url) return unmatched("invalid_url");
      if (!sameSeason(label)) return unmatched("season_mismatch");
      if (label.contentType === "preview") return unmatched("preview");
      const extra = Boolean(label.edition);
      const named = scope.collection && label.season === undefined && !label.date && !label.monthDay
        ? [] : byTitle.get(label.descriptor) || [];
      if (label.contentType === "unknown" && !named.length) return unmatched("unrecognized_label");

      const dated = label.date ? byDate.get(label.date) || [] :
        label.monthDay && (!label.compactDate || dateContext) ? byMonthDay.get(label.monthDay) || [] : [];
      const number = label.number !== undefined ? label.number + offset : undefined;
      const numbered = number !== undefined && (!scope.collection || label.season !== undefined)
        ? byNumber.get(number) || [] : [];
      // In a complete catalog a date and an explicit number are competing claims until they agree.
      const compact = label.compactDate && dateContext && dated.length > 0;
      if (compact && numbered.some(episode => !dated.includes(episode))) return unmatched("conflicting_evidence", "ambiguous");
      if (label.monthDay && !dated.length && (!label.compactDate || !numbered.length)) return unmatched("unresolved_year");
      const evidence = [
        { matches: dated, reason: (label.date ? "air_date" : "contextual_date") as Reason },
        { matches: compact ? [] : numbered, reason: "episode_number" as const },
        { matches: named, reason: "episode_title" as const }
      ].filter(signal => signal.matches.length);
      if (!evidence.length) return unmatched(extra ? "extra_parent_unresolved" : "episode_not_found");
      let candidates = evidence[0].matches.filter(episode => evidence.every(signal => signal.matches.includes(episode)));
      if (!candidates.length) return unmatched("conflicting_evidence", "ambiguous");

      // Never let numbering override a known conflicting date, including incomplete season metadata.
      if (label.date && !dated.length) {
        candidates = candidates.filter(episode => !episode.date);
        if (!candidates.length) return unmatched("conflicting_evidence", "ambiguous");
      }
      if (season.complete && label.number !== undefined && !compact && !numbered.length &&
        (!scope.collection || label.season !== undefined) && (dated.length || named.length)) {
        return unmatched("conflicting_evidence", "ambiguous");
      }
      candidates = candidates.filter(episode => {
        const expected = catalogPart(episode);
        // A full episode must not be returned for one part of a split broadcast.
        return expected === label.part || extra && !label.part && !numbered.length && season.complete;
      });
      if (!candidates.length) return unmatched("part_mismatch", "ambiguous");
      if (candidates.length > 1 && between) {
        candidates = candidates.filter(episode => episode.number > between.first && episode.number < between.last);
      }
      if (candidates.length !== 1) return unmatched(extra ? "extra_parent_unresolved" : "conflicting_evidence", "ambiguous");
      if (extra && scope.collection && label.season === undefined && !dated.length && !named.length) return unmatched("extra_parent_unresolved");
      return { ...row, status: "confirmed", reason: evidence[0].reason, episode: candidates[0].number };
    };

    const regular = line.filter(row => !row.label.edition).map(row => select(row));
    const anchors = regular.filter(result => result.status === "confirmed");
    const ascending = anchors.every((anchor, i) => i === 0 || anchors[i - 1].episode! <= anchor.episode!);
    const descending = anchors.every((anchor, i) => i === 0 || anchors[i - 1].episode! >= anchor.episode!);
    if (ascending || descending) {
      let next = 0;
      for (const [index, result] of regular.entries()) {
        while (next < anchors.length && anchors[next].entry.position <= result.entry.position) next++;
        if (result.status !== "ambiguous" || next === 0 || next === anchors.length) continue;
        const first = anchors[next - 1].episode!, last = anchors[next].episode!;
        regular[index] = select(result, { first: Math.min(first, last), last: Math.max(first, last) });
      }
    }
    // A finale can fill the final slot after a consistent run of independently verified regular entries.
    // Unknown entries or a gap after the last anchor make that inference unsafe.
    const last = catalog.at(-1);
    const previous = anchors.at(-1);
    const tail = previous && eligible.filter(row => row.entry.position > previous.entry.position);
    if (season.complete && last?.date && last.date <= new Date().toISOString().slice(0, 10) && previous &&
      ascending && new Set(anchors.map(anchor => anchor.episode)).size >= 2 &&
      previous.episode === last.number - 1 && tail?.length === 1 && tail[0].label.finale && !scope.collection) {
      const finale = tail[0];
      const index = regular.findIndex(result => result.entry === finale.entry);
      const label = finale.label;
      if (index >= 0 && regular[index].status === "unmatched" && !label.date && !label.monthDay &&
        label.number === undefined && !label.part &&
        !regular.some(result => result.entry.position > previous.entry.position && result.entry !== finale.entry &&
          result.label.contentType !== "preview")) {
        regular[index] = { ...finale, status: "confirmed", reason: "anchored_finale", episode: last.number };
      }
    }
    const regularByUrl = indexBy(regular.filter(row => row.status === "confirmed"), row => row.entry.url);
    const parentsByDate = indexBy([...regularByUrl.values()].flatMap(matches =>
      new Set(matches.map(row => row.episode)).size === 1 ? matches : []), row => row.label.date);
    const extras = line.filter(row => row.label.edition).map(row => {
      const result = select(row);
      if (result.reason !== "extra_parent_unresolved" || result.status !== "unmatched" || !row.label.date ||
        row.label.number !== undefined || !row.entry.url) return result;
      // A dated extra can borrow an already verified regular entry's date when TMDB omits it.
      const parents = parentsByDate.get(row.label.date) || [];
      const identities = new Set(parents.map(parent => parent.episode!));
      if (identities.size !== 1) return result;
      const episode = byEpisode.get(parents[0].episode!)!;
      if (catalogPart(episode) !== row.label.part || row.label.descriptor && row.label.descriptor !== episode.label.descriptor) return result;
      return { ...row, status: "confirmed" as const, reason: "same_line_parent" as const, episode: episode.number };
    });
    results.push(...regular, ...extras);
  }

  // The same exact regular URL cannot represent two catalog episodes in one provider record.
  const byUrl = indexBy(results.filter(result => result.status === "confirmed"), result => result.entry.url);
  for (const duplicates of byUrl.values()) {
    const regular = duplicates.filter(result => !result.label.edition);
    const identities = regular.length ? regular : duplicates;
    if (new Set(identities.map(result => result.episode)).size <= 1) continue;
    for (const result of duplicates) {
      result.status = "ambiguous";
      result.reason = "duplicate_identity";
      delete result.episode;
    }
  }
  const counts = new Map<string, number>();
  const increment = (key: string) => counts.set(key, (counts.get(key) || 0) + 1);
  for (const { label, reason, status } of results) {
    increment(`vod.content.${label.contentType}`);
    increment(`vod.match.${status}.${reason}`);
    if (label.edition) increment(`vod.extra.${status}`);
  }
  return { results, byEpisode: indexBy(results.filter(result => result.status === "confirmed"), result => result.episode), counts };
}
