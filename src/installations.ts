import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultSettings, parseSettings, Settings } from "./settings.js";

export const installationId = /^[a-f0-9]{48}$/;

export class Installations {
  private constructor(private directory: string, private key: Buffer) {}

  static async open(directory: string): Promise<Installations> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const path = join(directory, "master.key");
    let key: Buffer;
    try { key = await readFile(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if ((await readdir(directory)).some(name => name.endsWith(".json"))) {
        throw new Error("Installation encryption key is missing. Restore data/master.key from backup.");
      }
      key = randomBytes(32);
      await writeFile(path, key, { mode: 0o600, flag: "wx" });
    }
    if (key.length !== 32) throw new Error("Invalid installation encryption key");
    await chmod(path, 0o600);
    return new Installations(directory, key);
  }

  async get(id: string): Promise<string | undefined> {
    if (!installationId.test(id)) return;
    let raw: string;
    try { raw = await readFile(join(this.directory, `${id}.json`), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const data = JSON.parse(raw);
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(data.iv, "hex"), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(Buffer.from(data.tag, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(data.ciphertext, "hex")), decipher.final()]).toString("utf8");
  }

  async save(apiKey: string, id = randomBytes(24).toString("hex")): Promise<string> {
    if (!installationId.test(id)) throw new Error("Invalid installation ID");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(id));
    const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
    const data = JSON.stringify({ iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex") });
    const path = join(this.directory, `${id}.json`);
    const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temp, data, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
    return id;
  }

  async settings(id: string): Promise<Settings> {
    if (!installationId.test(id)) throw new Error("Invalid installation ID");
    let raw: string;
    try { raw = await readFile(join(this.directory, `${id}.preferences.json`), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultSettings();
      throw error;
    }
    const settings = parseSettings(JSON.parse(raw));
    if (!settings) throw new Error("Invalid installation preferences");
    return settings;
  }

  async saveSettings(id: string, settings: Settings): Promise<void> {
    if (!installationId.test(id) || !parseSettings(settings)) throw new Error("Invalid installation preferences");
    const path = join(this.directory, `${id}.preferences.json`);
    const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temp, JSON.stringify(settings), { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  }
}
