import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Account, Accounts } from "./accounts.js";

const lifetime = 8 * 60 * 60_000;
const cookieName = "mist_access";

export function accessGate(accounts: Accounts, encryptionKey: string): express.Router {
  if (!/^[a-f0-9]{64}$/i.test(encryptionKey)) throw new Error("MIST_ENCRYPTION_KEY must contain 64 hexadecimal characters (32 bytes)");
  const key = Buffer.from(encryptionKey, "hex");
  const sign = (payload: string) => createHmac("sha256", key).update(`mist:account-session:v1\0${payload}`).digest();
  const failures = new Map<string, { count: number; until: number }>();
  const authenticated = async (req: express.Request): Promise<Account | undefined> => {
    const value = req.headers.cookie?.split(";").map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    const match = value?.match(/^([a-f0-9-]{36})\.(\d+)\.([A-Za-z0-9_-]{43})$/);
    if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= Date.now() ||
      !timingSafeEqual(sign(`${match[1]}.${match[2]}`), Buffer.from(match[3], "base64url"))) return;
    return accounts.accountForSession(match[1]);
  };
  const identity = (account?: Account) => ({ authenticated: Boolean(account),
    ...(account?.configured ? { installation: account.installation } : {}) });
  const router = express.Router();
  router.get("/access", async (req, res, next) => {
    try { res.json(identity(await authenticated(req))); } catch (error) { next(error); }
  });
  router.delete("/access", (req, res) => {
    res.clearCookie(cookieName, { httpOnly: true, sameSite: "strict", secure: req.secure, path: "/api" }).json({ authenticated: false });
  });
  router.post("/access", async (req, res, next) => {
    const now = Date.now(), ip = req.ip || "unknown", previous = failures.get(ip);
    if (previous && previous.until > now && previous.count >= 10) {
      res.set("Retry-After", String(Math.ceil((previous.until - now) / 1000))).status(429)
        .json({ error: "Too many access attempts. Please try again later." });
      return;
    }
    try {
      const supplied = typeof req.body?.accessKey === "string" ? req.body.accessKey.trim() : "";
      const account = await accounts.authenticate(supplied);
      if (!account) {
        const attempt = previous && previous.until > now ? previous : { count: 0, until: now + 15 * 60_000 };
        attempt.count++;
        failures.delete(ip);
        failures.set(ip, attempt);
        if (failures.size > 1024) failures.delete(failures.keys().next().value!);
        res.status(401).json({ error: "Invalid access key." });
        return;
      }
      failures.delete(ip);
      const payload = `${account.id}.${now + lifetime}`;
      res.cookie(cookieName, `${payload}.${sign(payload).toString("base64url")}`, {
        httpOnly: true, sameSite: "strict", secure: req.secure, path: "/api", maxAge: lifetime
      }).json(identity(account));
    } catch (error) { next(error); }
  });
  router.use(async (req, res, next) => {
    try {
      const account = await authenticated(req);
      if (!account) { res.status(401).json({ error: "Access key required." }); return; }
      res.locals.account = account;
      next();
    } catch (error) { next(error); }
  });
  return router;
}
