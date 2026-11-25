export default async function run(page, ui) {
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.stack));
  page.on("console", (m) => errors.push(m.type() + ": " + m.text()));
  await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  return errors;
}
