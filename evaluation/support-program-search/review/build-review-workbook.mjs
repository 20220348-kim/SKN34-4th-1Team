import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";


if (!process.argv[2]) {
  throw new Error("Usage: build-review-workbook.mjs POOL_DIRECTORY [draft|final] [CAPTURE]");
}
const runDir = path.resolve(process.argv[2]);
const mode = process.argv[3] ?? "draft";
const capturePathArgument = process.argv[4];
if (!new Set(["draft", "final"]).has(mode)) {
  throw new Error("Mode must be draft or final");
}
const reviewCsvPath = path.join(runDir, "review-pool.csv");
const manifestPath = path.join(runDir, "review-pool-manifest.json");
const outputDir = path.join(runDir, "outputs");
const outputPath = path.join(
  outputDir,
  mode === "final"
    ? "search-quality-labeling.xlsx"
    : "search-quality-labeling-offline-draft.xlsx",
);
const previewDir = path.join(outputDir, "previews", mode);
try {
  await fs.lstat(outputPath);
  throw new Error("Output already exists; use a new pool directory to preserve reviews: " + outputPath);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const csvText = (await fs.readFile(reviewCsvPath, "utf8")).replace(/^\uFEFF/, "");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
if (manifest.schemaVersion !== "support-program-review-pool-manifest-v1") {
  throw new Error("Unsupported review-pool manifest schema");
}
if (manifest.captureIncluded !== (mode === "final")) {
  throw new Error("Workbook mode does not match the review-pool capture state");
}
if (mode === "final") {
  if (!capturePathArgument) {
    throw new Error("Final workbook creation requires the actual capture path");
  }
  const captureHash = createHash("sha256")
    .update(await fs.readFile(path.resolve(capturePathArgument)))
    .digest("hex");
  if (!/^[0-9a-f]{64}$/.test(manifest.captureFileSha256 ?? "")) {
    throw new Error("Review-pool manifest has no valid capture hash");
  }
  if (captureHash !== manifest.captureFileSha256) {
    throw new Error("Actual capture file hash does not match the review-pool manifest");
  }
} else if (capturePathArgument) {
  throw new Error("Draft workbook creation must not receive a capture path");
}
const workbook = await Workbook.fromCSV(csvText, { sheetName: "검토표" });
const reviewSheet = workbook.worksheets.getItem("검토표");
const rowCount = reviewSheet.getUsedRange(true).values.length - 1;
const expectedHeader = [
  "query_id",
  "split",
  "query",
  "decision",
  "reason",
  "reviewer",
  "title",
  "summary",
  "target_description",
  "regions",
  "categories",
  "application_period",
  "organization",
  "program_id",
];
const actualHeader = reviewSheet.getRange("A1:N1").values[0].map((value) => String(value ?? ""));
if (JSON.stringify(actualHeader) !== JSON.stringify(expectedHeader)) {
  throw new Error("Review pool columns or column order changed");
}
if (rowCount !== manifest.reviewRowCount) {
  throw new Error("Review pool row count does not match the manifest");
}
if (reviewSheet.getUsedRange(true).formulas.some((row) => row.some((value) => value))) {
  throw new Error("Review text must be literal values, not spreadsheet formulas");
}
const immutableFields = expectedHeader.filter(
  (field) => !new Set(["decision", "reason", "reviewer"]).has(field),
).sort();
const reviewRows = reviewSheet.getUsedRange(true).values.slice(1).map(
  (row) => Object.fromEntries(expectedHeader.map((field, index) => [field, String(row[index] ?? "")])),
);
reviewRows.sort((left, right) => {
  for (const field of ["query_id", "program_id"]) {
    if (left[field] < right[field]) return -1;
    if (left[field] > right[field]) return 1;
  }
  return 0;
});
const immutableRows = reviewRows.map(
  (row) => Object.fromEntries(immutableFields.map((field) => [field, row[field]])),
);
const structureHash = createHash("sha256").update(JSON.stringify(immutableRows)).digest("hex");
if (structureHash !== manifest.reviewStructureSha256) {
  throw new Error("Immutable review content changed or CSV text was converted by the spreadsheet importer");
}
const lastRow = rowCount + 1;

reviewSheet.showGridLines = false;
reviewSheet.freezePanes.freezeRows(1);
reviewSheet.freezePanes.freezeColumns(3);

const usedRange = reviewSheet.getRange(`A1:N${lastRow}`);
usedRange.format.font = { name: "Arial", size: 10, color: "#1F2937" };
usedRange.format.verticalAlignment = "top";
usedRange.format.wrapText = true;

const header = reviewSheet.getRange("A1:N1");
header.format = {
  fill: "#1F4E78",
  font: { name: "Arial", size: 10, bold: true, color: "#FFFFFF" },
  horizontalAlignment: "center",
  verticalAlignment: "center",
  wrapText: true,
  rowHeight: 32,
};

reviewSheet.getRange(`A2:B${lastRow}`).format.horizontalAlignment = "center";
reviewSheet.getRange(`N2:N${lastRow}`).format.font = { name: "Arial", size: 9, color: "#374151" };
reviewSheet.getRange(`D2:F${lastRow}`).format.fill = "#FFF2CC";
reviewSheet.getRange(`D2:D${lastRow}`).dataValidation = {
  rule: { type: "list", values: ["relevant", "irrelevant", "unclear"] },
};

const decisionRange = reviewSheet.getRange(`D2:D${lastRow}`);
decisionRange.conditionalFormats.addCustom('=$D2="relevant"', {
  fill: "#D9EAD3",
  font: { color: "#274E13", bold: true },
});
decisionRange.conditionalFormats.addCustom('=$D2="irrelevant"', {
  fill: "#F2F2F2",
  font: { color: "#595959" },
});
decisionRange.conditionalFormats.addCustom('=$D2="unclear"', {
  fill: "#FCE5CD",
  font: { color: "#7F6000", bold: true },
});

reviewSheet.getRange(`A2:N${lastRow}`).format.rowHeight = 72;
const widths = {
  A: 10,
  B: 10,
  C: 42,
  D: 14,
  E: 28,
  F: 14,
  G: 42,
  H: 54,
  I: 30,
  J: 14,
  K: 16,
  L: 20,
  M: 22,
  N: 32,
};
for (const [column, width] of Object.entries(widths)) {
  reviewSheet.getRange(`${column}:${column}`).format.columnWidth = width;
}

const reviewTable = reviewSheet.tables.add(`A1:N${lastRow}`, true, "ReviewPoolTable");
reviewTable.style = "TableStyleMedium2";
reviewTable.showFilterButton = true;

const guideSheet = workbook.worksheets.add("안내");
guideSheet.showGridLines = false;
guideSheet.getRange("A1").values = [["검색 품질 라벨링 안내"]];
guideSheet.getRange("A1:B1").format = {
  font: { name: "Arial", size: 16, bold: true, color: "#1F2937" },
  rowHeight: 30,
  verticalAlignment: "center",
};
guideSheet.getRange("A2").values = [[
  mode === "final"
    ? `기준일 ${manifest.referenceDate} / 질문 ${Object.keys(manifest.perQueryCounts).length}개 / ${rowCount}행 / 실제 검색 결과 포함`
    : `기준일 ${manifest.referenceDate} / 질문 ${Object.keys(manifest.perQueryCounts).length}개 / ${rowCount}행 / 실제 검색 전 사전 검토용`,
]];
guideSheet.getRange("A2:B2").format = {
  font: { name: "Arial", size: 10, italic: true, color: "#6B7280" },
  rowHeight: 22,
};

guideSheet.getRange("A4:B8").values = [
  ["판정값", "판정 기준"],
  ["relevant", "질문의 목적·명시된 지역·대상·지원 방식이 맞습니다. 최종 신청 자격을 보증하는 뜻은 아닙니다."],
  ["irrelevant", "목적·대상·지역·지원 형태 중 하나 이상이 명확히 맞지 않습니다."],
  ["unclear", "질문이 요구한 핵심 조건을 공고 내용으로 확인할 수 없습니다. 추측하지 말고 모르는 조건을 적습니다."],
  ["근거", "relevant와 unclear는 한 줄 근거를 반드시 적습니다."],
];
guideSheet.getRange("A4:B4").format = {
  fill: "#1F4E78",
  font: { name: "Arial", size: 10, bold: true, color: "#FFFFFF" },
  horizontalAlignment: "center",
};
guideSheet.getRange("A5:A8").format.font = { name: "Arial", size: 10, bold: true };
guideSheet.getRange("A5:B8").format.wrapText = true;
guideSheet.getRange("A5:B8").format.verticalAlignment = "top";
guideSheet.getRange("A5:B8").format.rowHeight = 34;

guideSheet.getRange("A10:B16").values = [
  ["순서", "작업"],
  [
    1,
    mode === "final"
      ? "담당 query_id를 필터링합니다. 이전 판정이 있으면 유지하고 새로 추가된 빈 행을 검토합니다."
      : "지금 사전 검토를 시작해도 됩니다. 실제 검색 후보가 추가되면 기존 판정을 보존하고 새 행만 검토합니다.",
  ],
  [2, "C열 질문을 읽고 G~M열 공고와 비교합니다. 긴 내용은 셀을 선택해 수식 입력줄을 펼쳐 읽습니다."],
  [3, "노란 D열 decision에 판정, E열 reason에 한 줄 이유, F열 reviewer에 이름을 적습니다."],
  [4, "질문·공고·행은 바꾸지 않습니다. 검색 순위는 보지 않습니다. 예상과 달라도 본인 판정대로 적습니다."],
  [5, "담당자 이름을 붙인 새 XLSX로 저장해 전달합니다. CSV 변환은 담당 개발자가 수행합니다."],
  [6, "판단 불가는 2차 확인합니다. 끝내 확인할 수 없으면 이유를 남겨 질문 전체를 점수 계산에서 제외합니다."],
];
guideSheet.getRange("A10:B10").format = {
  fill: "#1F4E78",
  font: { name: "Arial", size: 10, bold: true, color: "#FFFFFF" },
  horizontalAlignment: "center",
};
guideSheet.getRange("A11:A16").format.horizontalAlignment = "center";
guideSheet.getRange("A11:B16").format.wrapText = true;
guideSheet.getRange("A11:B16").format.verticalAlignment = "top";
guideSheet.getRange("A11:B16").format.rowHeight = 34;
guideSheet.getRange("A11:B11").format.fill = "#FFF2CC";

guideSheet.getRange("A18:B23").values = [
  ["irrelevant 사유", "사용 기준"],
  ["PURPOSE_MISMATCH", "찾는 지원 목적과 다릅니다."],
  ["TARGET_MISMATCH", "지원 대상이 다릅니다."],
  ["REGION_MISMATCH", "지원 지역이 다릅니다."],
  ["SUPPORT_TYPE_MISMATCH", "요청한 지원 형태와 다릅니다."],
  ["직접 작성", "위 코드로 설명하기 어려울 때 짧게 적습니다."],
];
guideSheet.getRange("A18:B18").format = {
  fill: "#1F4E78",
  font: { name: "Arial", size: 10, bold: true, color: "#FFFFFF" },
  horizontalAlignment: "center",
};
guideSheet.getRange("A19:A23").format.font = { name: "Arial", size: 10, bold: true };
guideSheet.getRange("A19:B23").format.wrapText = true;
guideSheet.getRange("A19:B23").format.rowHeight = 28;

guideSheet.getRange("A:A").format.columnWidth = 24;
guideSheet.getRange("B:B").format.columnWidth = 80;
guideSheet.getRange("C:D").format.columnWidth = 4;

await fs.mkdir(previewDir, { recursive: true });
const reviewPreview = await workbook.render({
  sheetName: "검토표",
  range: "A1:N12",
  scale: 1,
  format: "png",
});
await fs.writeFile(
  path.join(previewDir, "review-pool.png"),
  new Uint8Array(await reviewPreview.arrayBuffer()),
  { flag: "wx" },
);
const guidePreview = await workbook.render({
  sheetName: "안내",
  range: "A1:D23",
  scale: 1,
  format: "png",
});
await fs.writeFile(
  path.join(previewDir, "guide.png"),
  new Uint8Array(await guidePreview.arrayBuffer()),
  { flag: "wx" },
);

const keyRange = await workbook.inspect({
  kind: "table",
  range: "검토표!A1:N6",
  include: "values,formulas",
  tableMaxRows: 6,
  tableMaxCols: 14,
});
console.log(keyRange.ndjson);
const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!",
  options: { useRegex: true, maxResults: 100 },
  summary: "final formula error scan",
});
console.log(errors.ndjson);

await fs.mkdir(outputDir, { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
// Export privately, then copy exclusively so concurrent generators cannot replace reviews.
const temporaryDir = await fs.mkdtemp(path.join(outputDir, ".workbook-"));
const temporaryPath = path.join(temporaryDir, "review.xlsx");
try {
  await output.save(temporaryPath);
  await fs.copyFile(temporaryPath, outputPath, constants.COPYFILE_EXCL);
} finally {
  await fs.unlink(temporaryPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  await fs.unlink(temporaryPath + ".inspect.ndjson").catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  await fs.rmdir(temporaryDir);
}
console.log(JSON.stringify({ outputPath, rowCount }, null, 2));
