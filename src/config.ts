import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ApiSource { id: string; name: string; url: string; backups?: string[] }
export interface SourceConfig { apis: ApiSource[]; mkvdrama: { id: string; name: string; url: string } }

function object(input: unknown): input is Record<string, unknown> {
  return Boolean(input && typeof input === "object" && !Array.isArray(input));
}

function invalid(field: string): never { throw new Error(`config.json: invalid ${field}`); }

function endpoint(input: unknown, field: string, website = false): string {
  if (typeof input !== "string" || !input.trim()) return invalid(field);
  let url: URL;
  try { url = new URL(input); } catch { return invalid(field); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash ||
    website && (url.protocol !== "https:" || url.port || url.pathname !== "/" || url.search)) return invalid(field);
  return website ? url.origin : url.href;
}

export function parseConfig(input: unknown): SourceConfig {
  if (!object(input) || !object(input.api_site) || !Object.keys(input.api_site).length || !object(input.web_site)) return invalid("source categories");
  if (Object.keys(input).some(key => !["api_site", "web_site"].includes(key))) return invalid("source category");
  const apis = Object.entries(input.api_site).map(([id, entry]) => {
    const field = `api_site.${id}`;
    if (!/^[a-z][a-z0-9_-]*$/.test(id) || id === "mkvdrama" || !object(entry) ||
      Object.keys(entry).some(key => !["name", "api", "backup_apis"].includes(key)) ||
      typeof entry.name !== "string" || !entry.name.trim()) return invalid(field);
    const url = endpoint(entry.api, `${field}.api`);
    const values = entry.backup_apis === undefined ? [] : entry.backup_apis;
    if (!Array.isArray(values)) return invalid(`${field}.backup_apis`);
    const backups = values.map(value => endpoint(value, `${field}.backup_apis`));
    if (new Set([url, ...backups]).size !== backups.length + 1) return invalid(`${field}.backup_apis`);
    return { id, name: entry.name.trim(), url, backups };
  });
  const website = input.web_site.mkvdrama;
  if (Object.keys(input.web_site).some(id => id !== "mkvdrama") || !object(website) ||
    Object.keys(website).some(key => !["name", "url"].includes(key)) ||
    typeof website.name !== "string" || !website.name.trim()) return invalid("web_site.mkvdrama");
  return { apis, mkvdrama: { id: "mkvdrama", name: website.name.trim(), url: endpoint(website.url, "web_site.mkvdrama.url", true) } };
}

export function loadConfig(path = resolve(__dirname, "../config.json")): SourceConfig {
  let input: unknown;
  try { input = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("config.json: unable to read valid JSON"); }
  return parseConfig(input);
}

export const sourceConfig = loadConfig();
