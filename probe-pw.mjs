import { chromium } from "playwright";
const browser = await chromium.launch({ headless: false, channel: "chrome", args: ["--disable-blink-features=AutomationControlled"] });
const ctx = await browser.newContext({ locale: "nl-BE", timezoneId: "Europe/Brussels", viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage();
const resp = await page.goto("https://www.pathe.be/nl/bioscopen/stad/sint-niklaas", { waitUntil: "networkidle", timeout: 90000 }).catch(e => ({ status: () => "ERR " + e.message }));
console.log("page status", resp.status(), await page.title());
await page.waitForTimeout(6000);
for (const p of ["/api/cinema/cinema-pathe-sint-niklaas/shows?language=nl", "/api/show/ebenezer-56410/showtimes/cinema-pathe-sint-niklaas/2026-11-17?language=nl"]) {
  const r = await page.evaluate(async (p) => { const x = await fetch(p, { credentials: "include" }); return x.status + " " + (await x.text()).slice(0, 120); }, p);
  console.log("api", r);
}
await browser.close();
