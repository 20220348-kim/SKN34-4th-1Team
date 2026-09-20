// Run with the bundled Node runtime and explicit REVIEW_PLAYWRIGHT_MODULE.
// REVIEW_BROWSER_EXECUTABLE may point to an already installed Chrome binary.
// No packages/browsers are installed and only temporary synthetic data is used.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const directory = path.dirname(fileURLToPath(import.meta.url));
const modulePath = process.env.REVIEW_PLAYWRIGHT_MODULE;
const python = process.env.REVIEW_PYTHON || "python3";
const headers = [
  "query_id", "split", "query", "decision", "reason", "reviewer", "title",
  "summary", "target_description", "regions", "categories", "application_period",
  "organization", "program_id",
];
const mutable = new Set(["decision", "reason", "reviewer"]);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const compact = (items) => JSON.stringify(items.map((item) => Object.fromEntries(
  Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
)));
const csv = (rows) => "\uFEFF" + [headers, ...rows.map((row) => headers.map((field) => row[field]))]
  .map((row) => row.map((value) => /[",\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value).join(","))
  .join("\r\n") + "\r\n";

async function setup(temporary) {
  const rows = ["001", "002", "003"].map((id, index) => ({
    query_id: "Q01", split: "dev", query: "서울 소상공인의 AI 홍보 콘텐츠 제작 지원",
    decision: "", reason: "", reviewer: "",
    title: ["서울 AI 콘텐츠 제작", "울산 마케팅 지원", "아직 확인하지 않은 합성 공고"][index],
    summary: '한글 "인용"과 줄바꿈\n' + "공고에 없는 조건은 추측하지 않습니다. ".repeat(10)
      + '<img src="https://example.invalid/leak" onerror="window.injected=true">',
    target_description: "소상공인", regions: index === 1 ? "울산" : "서울",
    categories: "AI", application_period: "상시", organization: "합성 기관",
    program_id: "SYNTHETIC:" + id,
  }));
  const manifest = {
    schemaVersion: "support-program-review-pool-manifest-v1",
    name: "synthetic-browser-test", referenceDate: "2026-09-06",
    querySetSha256: sha256("synthetic query set"), captureIncluded: false,
    reviewRowCount: rows.length, perQueryCounts: { Q01: rows.length },
    reviewStructureSha256: sha256(compact(rows.map((row) => Object.fromEntries(
      Object.entries(row).filter(([field]) => !mutable.has(field)),
    )))),
    poolKeySha256: sha256(rows.map((row) => row.query_id + "\t" + row.program_id).sort().join("\n")),
  };
  const seeds = rows.slice(0, 2).map((row, index) => ({
    queryId: row.query_id, programId: row.program_id,
    decision: index === 0 ? "relevant" : "irrelevant",
    reason: index === 0 ? "대화에서 요약을 읽고 추천 가능 판정(별도 사유 미입력)" : "서울 질문인데 울산 대상",
    reviewer: "대화 사용자",
    provenance: {
      kind: "conversation", basis: "conversation_summary",
      userResponse: index === 0 ? "추천해도 되지" : "안되지 대상이 질문자는 서울인데, 대상자는 울산이니까",
      userReason: index === 0 ? null : "지역이 다름",
      presentedQuery: rows[0].query, presentedProgramTitle: row.title,
      presentedProgramSummary: "짧은 합성 요약", reviewMethod: "대화 요약 확인",
    },
  }));
  const payload = {
    schemaVersion: "support-program-browser-review-v1", name: manifest.name,
    referenceDate: manifest.referenceDate, querySetSha256: manifest.querySetSha256,
    reviewStructureSha256: manifest.reviewStructureSha256,
    poolKeySha256: manifest.poolKeySha256, captureIncluded: manifest.captureIncluded,
    rows, seedJudgments: seeds,
  };
  const encoded = JSON.stringify(payload).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  const template = await fs.readFile(path.join(directory, "review-page.html"), "utf8");
  assert.equal(template.split("__REVIEW_DATA__").length, 2);
  const html = template.replace("__REVIEW_DATA__", encoded);
  await fs.writeFile(path.join(temporary, "review.html"), html);
  await fs.writeFile(path.join(temporary, "review-pool.csv"), csv(rows));
  await fs.writeFile(path.join(temporary, "review-pool-manifest.json"), JSON.stringify(manifest));
  return { rows, seeds, manifest, html };
}

test("offline review page: isolated synthetic browser and converter workflow", {
  skip: !modulePath ? "Set REVIEW_PLAYWRIGHT_MODULE to the bundled Playwright module; nothing is installed automatically." : false,
  timeout: 120000,
}, async (t) => {
  const imported = await import(pathToFileURL(path.resolve(modulePath)).href);
  const { chromium } = imported.default || imported;
  const executablePath = process.env.REVIEW_BROWSER_EXECUTABLE || chromium.executablePath();
  await fs.access(executablePath);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "govbiz-review-browser-test-"));
  let browser;
  let server;
  const externalRequests = [];
  const pageErrors = [];
  try {
    const scenario = await setup(temporary);
    server = http.createServer((request, response) => {
      if (request.url !== "/review.html") {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(scenario.html);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const origin = "http://127.0.0.1:" + server.address().port;
    const url = origin + "/review.html";
    browser = await chromium.launch({ executablePath, headless: true, args: [
      "--disable-background-networking", "--disable-component-update", "--disable-sync",
      "--no-first-run", "--no-default-browser-check",
    ] });
    async function isolatedContext(options = {}) {
      const context = await browser.newContext({ acceptDownloads: true, ...options });
      await context.route("**/*", async (route) => {
        if (route.request().url() === url) await route.continue();
        else {
          externalRequests.push(route.request().url());
          await route.abort();
        }
      });
      context.on("page", (page) => page.on("pageerror", (error) => pageErrors.push(error.message)));
      return context;
    }
    const context = await isolatedContext({ viewport: { width: 1100, height: 900 } });
    const page = await context.newPage();
    await page.goto(url);
    const count = () => page.locator("#progress-text").textContent();
    let exportNumber = 0;
    async function download(pageToUse = page) {
      const waiting = pageToUse.waitForEvent("download");
      await pageToUse.locator("#export-button").click();
      const file = await waiting;
      const output = path.join(temporary, "export-" + (++exportNumber) + ".json");
      await file.saveAs(output);
      return { output, data: JSON.parse(await fs.readFile(output, "utf8")) };
    }
    async function importValue(value, accept = false) {
      await page.locator("#message").evaluate((element) => { element.textContent = ""; });
      if (accept) page.once("dialog", (dialog) => dialog.accept());
      await page.locator("#import-file").setInputFiles({
        name: "review-progress.json", mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(value)),
      });
      await page.locator("#message").filter({ hasText: accept ? "불러왔습니다" : "불러오지 않았습니다" }).waitFor();
    }

    await t.test("two conversation judgments are counted and source text is not executed", async () => {
      assert.match(await count(), /2 \/ 3건 입력 완료/);
      assert.match(await page.locator("#program-title").textContent(), /아직 확인하지 않은/);
      assert.equal(await page.locator("#program-summary img").count(), 0);
      assert.equal(await page.evaluate(() => window.injected), undefined);
      const initial = await download();
      assert.equal(initial.data.judgments.length, 3);
      assert.deepEqual(initial.data.judgments.slice(0, 2), scenario.seeds);
    });
    await t.test("a selected recommendation needs a reason and reviewer to be complete", async () => {
      await page.locator('[data-decision="relevant"]').click();
      assert.match(await count(), /2 \/ 3/);
      assert.match(await page.locator("#current-status").textContent(), /이유/);
      await page.locator("#reason").fill("질문의 지역과 지원 목적이 일치합니다.");
      assert.match(await count(), /3 \/ 3/);
      await page.locator("#reviewer").fill("");
      assert.match(await count(), /2 \/ 3/);
      await page.locator("#reviewer").fill("합성 검토자");
      assert.match(await count(), /3 \/ 3/);
    });
    await t.test("navigation preserves judgments and displays the original conversation", async () => {
      await page.locator("#previous").click();
      assert.match(await page.locator("#seed-note").textContent(), /질문자는 서울/);
      await page.locator("#previous").click();
      assert.match(await page.locator("#seed-note").textContent(), /추천해도 되지/);
      assert.equal(await page.locator("#previous").isDisabled(), true);
      await page.locator("#next").click();
      await page.locator("#next").click();
      assert.equal(await page.locator("#reason").inputValue(), "질문의 지역과 지원 목적이 일치합니다.");
      await page.locator("#next-unfinished").click();
      assert.match(await page.locator("#message").textContent(), /입력이 끝났습니다/);
    });
    await t.test("refresh restores both progress and position from local storage", async () => {
      await page.reload();
      assert.match(await count(), /3 \/ 3/);
      assert.match(await page.locator("#program-title").textContent(), /아직 확인하지 않은/);
      assert.equal(await page.locator("#reason").inputValue(), "질문의 지역과 지원 목적이 일치합니다.");
      assert.equal(await page.locator("#reviewer").inputValue(), "합성 검토자");
    });
    await t.test("unclear requires a reason and remains separately visible", async () => {
      await page.locator('[data-decision="unclear"]').click();
      await page.locator("#reason").fill("");
      assert.match(await count(), /2 \/ 3/);
      await page.locator("#reason").fill("핵심 조건이 요약에 없습니다.");
      assert.match(await count(), /3 \/ 3/);
      assert.match(await page.locator("#counts").textContent(), /판단 어려움 1건/);
    });
    let draft;
    await t.test("export retains all rows, the two seeds, and an unfinished draft", async () => {
      page.once("dialog", (dialog) => dialog.accept());
      await page.locator("#clear").click();
      await page.locator("#reason").fill('아직 작성 중인 이유\n한글 "인용"');
      draft = await download();
      assert.equal(draft.data.judgments.length, 3);
      assert.deepEqual(draft.data.judgments.slice(0, 2), scenario.seeds);
      assert.equal(draft.data.judgments[2].decision, "");
      assert.equal(draft.data.judgments[2].reason, '아직 작성 중인 이유\n한글 "인용"');
      assert.match(await count(), /2 \/ 3/);
    });
    await t.test("invalid imports are rejected atomically without changing current progress", async () => {
      const bad = [
        { ...draft.data, querySetSha256: "0".repeat(64) },
        { ...draft.data, judgments: draft.data.judgments.slice(0, 2) },
        { ...draft.data, judgments: [...draft.data.judgments.slice(0, 2), draft.data.judgments[0]] },
        { ...draft.data, judgments: draft.data.judgments.map((item, index) => index === 2 ? { ...item, decision: "maybe" } : item) },
      ];
      for (const value of bad) {
        await importValue(value);
        assert.deepEqual((await download()).data, draft.data);
      }
    });
    await t.test("explicit valid import restores unfinished drafts and original provenance", async () => {
      await page.locator('[data-decision="irrelevant"]').click();
      await page.locator("#reason").fill("다른 임시 입력");
      await importValue(draft.data, true);
      assert.deepEqual((await download()).data, draft.data);
      assert.equal(await page.locator("#reason").inputValue(), draft.data.judgments[2].reason);
      assert.match(await count(), /2 \/ 3/);
    });
    await t.test("downloaded JSON converts to the full matching CSV and cannot overwrite outputs", async () => {
      const output = path.join(temporary, "converted.csv");
      const args = ["-B", path.join(directory, "extract-review-json.py"),
        "--review-pool", path.join(temporary, "review-pool.csv"),
        "--pool-manifest", path.join(temporary, "review-pool-manifest.json"),
        "--review-json", draft.output, "--output", output];
      const result = spawnSync(python, args, { encoding: "utf8", timeout: 15000 });
      assert.equal(result.status, 0, result.stderr);
      const expected = scenario.rows.map((row, index) => ({
        ...row, decision: draft.data.judgments[index].decision,
        reason: draft.data.judgments[index].reason, reviewer: draft.data.judgments[index].reviewer,
      }));
      assert.equal(await fs.readFile(output, "utf8"), csv(expected));
      assert.equal(JSON.parse(result.stdout).reviewRowCount, 3);
      const second = spawnSync(python, args, { encoding: "utf8", timeout: 15000 });
      assert.notEqual(second.status, 0);
      assert.match(second.stderr, /already exists/);
      assert.equal(await fs.readFile(output, "utf8"), csv(expected));
    });
    await t.test("blocked local storage warns but still supports a complete downloadable backup", async () => {
      const unavailable = await isolatedContext();
      await unavailable.addInitScript(() => {
        for (const method of ["getItem", "setItem"]) {
          Storage.prototype[method] = () => { throw new DOMException("Disabled for test", "SecurityError"); };
        }
      });
      const blockedPage = await unavailable.newPage();
      await blockedPage.goto(url);
      assert.equal(await blockedPage.locator("#warning").isVisible(), true);
      assert.match(await blockedPage.locator("#storage-status").textContent(), /사용 불가|저장 필요/);
      const backup = await download(blockedPage);
      assert.equal(backup.data.judgments.length, 3);
      assert.deepEqual(backup.data.judgments.slice(0, 2), scenario.seeds);
      await unavailable.close();
    });
    await t.test("a second window cannot silently overwrite another window's changes", async () => {
      const secondPage = await context.newPage();
      await secondPage.goto(url);
      await secondPage.locator("#reason").fill("두 번째 창 입력");
      await page.locator("#warning").waitFor();
      assert.match(await page.locator("#warning").textContent(), /다른 창/);
      await page.locator("#reason").fill("첫 번째 창의 보관할 입력");
      await secondPage.reload();
      assert.equal(await secondPage.locator("#reason").inputValue(), "두 번째 창 입력");
      await secondPage.close();
    });
    await t.test("360px mobile layout has no horizontal overflow and all decision buttons are usable", async () => {
      const mobile = await isolatedContext({ viewport: { width: 360, height: 800 } });
      const mobilePage = await mobile.newPage();
      await mobilePage.goto(url);
      assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      for (const decision of ["relevant", "irrelevant", "unclear"]) {
        const button = mobilePage.locator('[data-decision="' + decision + '"]');
        await button.click();
        assert.equal(await button.getAttribute("aria-pressed"), "true");
        assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      await mobile.close();
    });
    await t.test("hybrid mode requires selected human checks without prefilling AI as human", async () => {
      const generated = spawnSync(python, ["-B", "-c", `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mode_browser_synthetic", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
scenario = module.ReviewModeTest()
scenario.setUp()
try:
    selection, _, progress = scenario.compose(mode="hybrid")
    html = module.MODE.build_human_page(selection, progress, scenario.rows, scenario.manifest)
    print(json.dumps({"html": html, "required": selection["requiredHumanReviewCount"], "rows": len(scenario.rows)}))
finally:
    scenario.tearDown()
`, path.join(directory, "test_review_modes.py")], { encoding: "utf8", maxBuffer: 2_000_000 });
      assert.equal(generated.status, 0, generated.stderr);
      const mode = JSON.parse(generated.stdout);
      const originalHtml = scenario.html;
      const originalStorage = await page.evaluate(() => ({ ...localStorage }));
      scenario.html = mode.html;
      const modePage = await context.newPage();
      try {
        await modePage.goto(url);
        assert.match(await modePage.locator("#progress-text").textContent(), new RegExp("0 / " + mode.rows));
        const required = modePage.locator("section").filter({ has: modePage.getByRole("button", { name: "다음 필수 사람 검토" }) });
        assert.match(await required.textContent(), new RegExp("미완료 " + mode.required));
        await modePage.getByRole("button", { name: "다음 필수 사람 검토" }).click();
        assert.match(await required.textContent(), /현재 공고: 필수 검토 대상/);
        await modePage.locator("#reviewer").fill("합성 사람 검토자");
        await modePage.locator('[data-decision="irrelevant"]').click();
        assert.match(await required.textContent(), new RegExp("미완료 " + (mode.required - 1)));
        const saved = await download(modePage);
        assert.equal(saved.data.judgments.filter((item) => item.decision !== "").length, 1);
        assert.equal(saved.data.judgments.filter((item) => item.provenance?.kind === "ai_consensus").length, 0);
        const storageAfter = await modePage.evaluate(() => ({ ...localStorage }));
        for (const [key, value] of Object.entries(originalStorage)) assert.equal(storageAfter[key], value);
        assert.equal(Object.keys(storageAfter).some((key) => key.includes(":selection:")), true);
      } finally {
        scenario.html = originalHtml;
        await modePage.close();
      }
    });
    assert.deepEqual(externalRequests, [], "The review page attempted non-local requests");
    assert.deepEqual(pageErrors, [], "Unexpected browser JavaScript errors");
    t.diagnostic("No outbound page requests; all contexts use temporary, isolated browser storage.");
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
