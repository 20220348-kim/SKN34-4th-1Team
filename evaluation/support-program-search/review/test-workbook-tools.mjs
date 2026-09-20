import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const launcher = fileURLToPath(new URL("./run-workbook-tool.sh", import.meta.url));
const enabled = Boolean(process.env.ARTIFACT_NODE && process.env.ARTIFACT_NODE_MODULES);
const headers = [
  "query_id", "split", "query", "decision", "reason", "reviewer", "title",
  "summary", "target_description", "regions", "categories", "application_period",
  "organization", "program_id",
];
const row = ["Q01", "dev", "합성 검색", "", "", "", "가상 공고", '한글 "인용"\n두 번째 줄',
  "중소기업", "서울", "AI", "상시", "가상기관", "SYNTH:00123"];
const toCsv = (values) => values.map(
  (items) => items.map((value) => '"' + value.replaceAll('"', '""') + '"').join(","),
).join("\r\n") + "\r\n";

function callTool(tool, ...args) {
  return spawnSync("sh", [launcher, tool, ...args], {
    encoding: "utf8", timeout: 60000, env: process.env,
  });
}

async function prepare(directory, data = row) {
  await fs.mkdir(directory);
  const immutable = Object.fromEntries(headers.map((field, index) => [field, data[index]])
    .filter(([field]) => !["decision", "reason", "reviewer"].includes(field))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  await fs.writeFile(path.join(directory, "review-pool.csv"), toCsv([headers, data]));
  await fs.writeFile(path.join(directory, "review-pool-manifest.json"), JSON.stringify({
    schemaVersion: "support-program-review-pool-manifest-v1",
    captureIncluded: false, referenceDate: "2026-09-06", perQueryCounts: { Q01: 1 },
    reviewRowCount: 1,
    reviewStructureSha256: createHash("sha256").update(JSON.stringify([immutable])).digest("hex"),
  }));
}

test("workbook text, manifest checks, and no-clobber workflow", { skip: !enabled }, async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "govbiz-workbook-test-"));
  try {
    const pool = path.join(temporary, "pool");
    await prepare(pool);
    const xlsx = path.join(pool, "outputs", "search-quality-labeling-offline-draft.xlsx");
    const extracted = path.join(temporary, "extracted.csv");
    await t.test("bundled launcher generates XLSX and preserves Korean, quotes, and multiline text", async () => {
      const built = callTool("build-review-workbook.mjs", pool, "draft");
      assert.equal(built.status, 0, built.stderr);
      const result = callTool("extract-review-csv.mjs", xlsx, extracted);
      assert.equal(result.status, 0, result.stderr);
      assert.equal((await fs.readFile(extracted, "utf8")).replace(/^\uFEFF/, ""), toCsv([headers, row]));
    });
    await t.test("regeneration cannot overwrite an existing workbook", async () => {
      const before = await fs.readFile(xlsx);
      const result = callTool("build-review-workbook.mjs", pool, "draft");
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Output already exists/);
      assert.deepEqual(await fs.readFile(xlsx), before);
    });
    await t.test("CSV extraction cannot overwrite existing review data", async () => {
      const before = await fs.readFile(extracted);
      const result = callTool("extract-review-csv.mjs", xlsx, extracted);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Output already exists/);
      assert.deepEqual(await fs.readFile(extracted), before);
    });
    await t.test("immutable CSV content changed after manifest generation is rejected", async () => {
      const changed = path.join(temporary, "changed");
      await prepare(changed);
      await fs.writeFile(path.join(changed, "review-pool.csv"), toCsv([headers, row.with(6, "변조 제목")]));
      const result = callTool("build-review-workbook.mjs", changed, "draft");
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Immutable review content changed/);
    });
    await t.test("formula-like source text is rejected instead of being silently evaluated", async () => {
      const formulas = path.join(temporary, "formulas");
      await prepare(formulas, row.with(6, "=1+1"));
      const result = callTool("build-review-workbook.mjs", formulas, "draft");
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /literal values, not spreadsheet formulas/);
    });
  } finally {
    // Only this test's mkdtemp directory is removed.
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
