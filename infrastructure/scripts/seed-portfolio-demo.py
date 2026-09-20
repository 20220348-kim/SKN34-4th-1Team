#!/usr/bin/env python3
"""Explicit free demo for the dedicated Mac kind cluster, never Compose/RDS.

Starts only with empty Catalog/Core data. A private receipt allows a partial run
to resume without replacing accounts, passwords or catalog rows. Public program
data is written only to Catalog; Core receives its normal authenticated snapshot.
"""
import argparse
from datetime import date, timedelta
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import time

CLUSTER = "govbiz-portfolio"
EMAILS = ("demo1@portfolio.govbiz.local", "demo2@portfolio.govbiz.local")
SOURCES = ("BIZINFO", "KSTARTUP", "MSIT", "CNTRADE_NOTICE")
SOURCE_HOME = dict(zip(SOURCES, ("https://www.bizinfo.go.kr/", "https://www.k-startup.go.kr/",
                                "https://www.msit.go.kr/", "https://cntrade.chungnam.go.kr/")))


def text(value):
    return "CONVERT(X'" + str(value).encode().hex() + "' USING utf8mb4)"


def fixtures(day):
    start, end = day - timedelta(days=1), day + timedelta(days=90)
    themes = ("AI 문서 자동화", "스마트 제조", "디지털 헬스케어", "수출 물류", "데이터 협업",
              "예비 창업 사업화", "지역 과학기술 연구", "온라인 수출 상담")
    rows = []
    for i, (source, theme) in enumerate(zip(("BIZINFO",) * 5 + SOURCES[1:], themes), 1):
        row = dict(source=source, id=f"portfolio-demo-{i:02}", title=f"[데모] {theme} 지원사업",
                   organization="[데모] GovBiz 시연기관", summary="무료 포트폴리오 시연용 가상 공고입니다. 실제 모집·지원금·신청 자격 안내가 아닙니다.",
                   target="[데모] 가상 중소기업 및 창업기업", category="창업" if source == "KSTARTUP" else "기술",
                   region="전국", period=f"{start} ~ {end}", start=str(start), end=str(end), sort=day.strftime("%Y%m%d") + "120000")
        # Frozen demo subset of SupportProgramIndexTextHelper: no control text,
        # truncation or startup metadata. Real Catalog and Core verify the hash.
        body = "\n".join((f"제목: {row['title']}", f"기관: {row['organization']}", f"지원대상: {row['target']}",
                          f"분야: {row['category']}", f"지역: {row['region']}", f"신청기간: {row['period']}", f"내용: {row['summary']}"))
        row["hash"] = hashlib.sha256(body.encode()).hexdigest()
        rows.append(row)
    return rows


def envelope(body, guard):
    return ("SET NAMES utf8mb4; SET time_zone='+09:00';\n"
            "CREATE TEMPORARY TABLE portfolio_guard(ok BOOLEAN NOT NULL CHECK(ok=TRUE));\n"
            "SET @locked=GET_LOCK('govbiz-portfolio-demo-v1',10);\nSTART TRANSACTION;\n"
            "INSERT INTO portfolio_guard VALUES(@locked=1);\n" + guard + "\n" + body +
            "\nCOMMIT; DO RELEASE_LOCK('govbiz-portfolio-demo-v1');\n")


def catalog_sql(rows):
    statements = []
    columns = "source_code,source_program_id,title,organization,summary,categories,regions,target_description,application_period_raw,application_start_date,application_end_date,source_url,source_sort_timestamp,content_hash"
    for row in rows:
        values = [row[k] for k in ("source", "id", "title", "organization", "summary")]
        values += [json.dumps([row["category"]], ensure_ascii=False), json.dumps([row["region"]], ensure_ascii=False)]
        values += [row[k] for k in ("target", "period", "start", "end")]
        # Preserve the client's official-host validation. These are only provider
        # homepages, not fabricated real program URLs; demo titles remain explicit.
        values += [SOURCE_HOME[row["source"]] + "#govbiz-portfolio-demo", row["sort"], row["hash"]]
        statements.append(f"INSERT INTO support_program({columns}) VALUES({','.join(map(text, values))});")
    for source in SOURCES:
        matching = [r for r in rows if r["source"] == source]
        fingerprint = hashlib.sha256("\n".join(sorted(f"{source}:{r['id']}:{r['hash']}" for r in matching)).encode()).hexdigest()
        statements += [f"INSERT INTO support_program_sync_generation VALUES({text(source)},1);",
                       f"INSERT INTO support_program_sync_status(source_code,published_generation,published_catalog_fingerprint,published_program_count,index_ready,last_sync_outcome) VALUES({text(source)},1,{text(fingerprint)},{len(matching)},FALSE,'NONE');",
                       f"UPDATE catalog_source_revision SET revision=1 WHERE source_code={text(source)};"]
    guard = "\n".join(f"INSERT INTO portfolio_guard SELECT COUNT(*)=0 FROM {table};" for table in
                      ("support_program", "support_program_sync_status", "support_program_sync_generation"))
    guard += "\nINSERT INTO portfolio_guard SELECT COUNT(*)=0 FROM catalog_source_revision WHERE revision<>0;"
    return envelope("\n".join(statements), guard)


def core_sql(hashes):
    if set(hashes) != set(EMAILS) or any(not re.fullmatch(r"\$2[aby]\$12\$[./A-Za-z0-9]{53}", h) for h in hashes.values()):
        raise ValueError("Requires two BCrypt cost-12 hashes, never plaintext/default passwords")
    statements = []
    for i, email in enumerate(EMAILS, 1):
        statements += [
            f"INSERT INTO account(email,password_hash,role,email_verified_at,terms_agreed_at) VALUES({text(email)},{text(hashes[email])},'USER',NOW(6),NOW(6));",
            "SET @a=LAST_INSERT_ID();",
            "INSERT INTO company(account_id,business_number,company_name,business_status,business_status_code,region,industry,founded_year,business_verified_at,created_at,updated_at) "
            f"VALUES(@a,{text('000000000' + str(i))},{text('[데모] 포트폴리오 기업 ' + str(i))},'시연용 가상기업','00','서울특별시','정보통신업',2024,NOW(6),NOW(6),NOW(6));",
            "SET @c=LAST_INSERT_ID();",
            "INSERT INTO company_partner_profile(company_id,roles,interest_areas,introduction,capabilities,created_at,updated_at) "
            "VALUES(@c,JSON_ARRAY('LEAD','PARTICIPANT'),JSON_ARRAY('기술'),'[데모] 사업자 확인을 하지 않은 가상 시연 기업입니다.',JSON_ARRAY('데이터 분석'),NOW(6),NOW(6));",
            f"SET @p=(SELECT id FROM support_program WHERE source_code='BIZINFO' AND source_program_id={text(f'portfolio-demo-{i:02}')});",
            "INSERT INTO partner_recruitment(account_id,company_id,support_program_id,title,body,own_role,seeking_role,seeking_count,region,capabilities,recruitment_deadline,created_at,updated_at) "
            f"VALUES(@a,@c,@p,{text('[데모] 협업 파트너 모집 ' + str(i))},'[데모] 실제 모집이 아닌 포트폴리오 시연용입니다.','LEAD','PARTICIPANT',1,'전국',JSON_ARRAY('데이터 분석'),DATE_ADD(CURDATE(),INTERVAL 60 DAY),NOW(6),NOW(6));",
            "INSERT INTO saved_support_program(account_id,support_program_id,saved_at) VALUES(@a,@p,NOW(6));",
        ]
    guard = "\n".join(f"INSERT INTO portfolio_guard SELECT COUNT(*)=0 FROM {table};" for table in ("account", "company", "partner_recruitment"))
    guard += "\nINSERT INTO portfolio_guard SELECT COUNT(*)=8 FROM support_program WHERE source_program_id LIKE 'portfolio-demo-%';"
    return envelope("\n".join(statements), guard)


def run(command, data=None):
    result = subprocess.run(command, input=data, capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise ValueError("Command failed; SQL, credentials and raw output suppressed")
    return result.stdout.strip()


def verify_context(kube):
    config = json.loads(run(kube + ["config", "view", "--minify", "-o", "json"]))
    if not re.fullmatch(r"https://127\.0\.0\.1:[0-9]+", config["clusters"][0]["cluster"]["server"]):
        raise ValueError("Only the dedicated loopback kind cluster is allowed")
    nodes = json.loads(run(kube + ["get", "nodes", "-o", "json"]))["items"]
    if [n["metadata"]["name"] for n in nodes] != [CLUSTER + "-control-plane"]:
        raise ValueError("Unexpected cluster")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kubeconfig", required=True, type=Path)
    parser.add_argument("--credentials-file", required=True, type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    kube = ["kubectl", "--kubeconfig", str(args.kubeconfig), "--context", "kind-" + CLUSTER]
    verify_context(kube)
    nk = kube + ["-n", "govbiz-msa"]

    def sql(owner, query):
        if owner not in ("catalog", "core"):
            raise ValueError("Unexpected DB owner")
        return run(nk + ["exec", "-i", owner + "-mysql-0", "--", "sh", "-c",
                        'MYSQL_PWD="$MYSQL_PASSWORD" mysql --default-character-set=utf8mb4 --batch --skip-column-names -u "$MYSQL_USER" "$MYSQL_DATABASE"'], query)

    for owner in ("catalog", "core"):
        identity = sql(owner, "SELECT VERSION(),DATABASE();").split()
        if len(identity) != 2 or not identity[0].startswith("8.4.") or identity[1] != "govbiz_" + owner:
            raise ValueError("Unexpected MySQL version/database")
    catalog_id = sql("catalog", "SELECT catalog_id FROM catalog_instance WHERE singleton_id=1;")
    deployments = json.loads(run(nk + ["get", "deployment/catalog-service", "-o", "json"]))
    env = {e["name"]: e.get("value") for e in deployments["spec"]["template"]["spec"]["containers"][0]["env"]}
    if any(env.get(s + "_SYNC_ENABLED") != "false" for s in SOURCES) or env.get("SUPPORT_PROGRAM_INDEX_ENABLED") != "false":
        raise ValueError("Disable real collectors/indexing before installing demo data")
    counts = {owner: int(sql(owner, "SELECT COUNT(*) FROM " + ("support_program" if owner == "catalog" else "account") + ";")) for owner in ("catalog", "core")}
    print("Dedicated local demo plan: 8 programs, 2 USER accounts, 2 companies/recruitments. Existing:", counts)
    if not args.apply:
        return
    receipt = args.credentials_file
    if receipt.exists() or receipt.is_symlink():
        info = receipt.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid():
            raise ValueError("Credentials must be an owner-only regular file")
        record = json.loads(receipt.read_text())
        if record["catalogId"] != catalog_id or set(record["accounts"]) != set(EMAILS):
            raise ValueError("Receipt belongs to another demo dataset")
    else:
        if any(counts.values()):
            raise ValueError("First seed requires empty Catalog/Core data; existing data is preserved")
        if not receipt.parent.is_dir() or receipt.parent.resolve() != receipt.parent.absolute():
            raise ValueError("Use an existing private directory without symlinks")
        record = {"catalogId": catalog_id, "seedDate": str(date.today()),
                  "accounts": {email: secrets.token_urlsafe(18) for email in EMAILS}}
        with os.fdopen(os.open(receipt, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w") as stream:
            json.dump(record, stream, ensure_ascii=False, indent=2)
    if counts["catalog"] == 0:
        sql("catalog", catalog_sql(fixtures(date.fromisoformat(record["seedDate"]))))
    elif counts["catalog"] != 8 or int(sql("catalog", "SELECT COUNT(*) FROM support_program WHERE source_program_id LIKE 'portfolio-demo-%';")) != 8:
        raise ValueError("Unexpected Catalog data; nothing is overwritten")
    deadline = time.monotonic() + 100
    while int(sql("core", "SELECT COUNT(*) FROM support_program WHERE source_program_id LIKE 'portfolio-demo-%';")) != 8:
        if time.monotonic() >= deadline:
            raise ValueError("Normal Catalog -> Core projection failed; inspect before resuming")
        time.sleep(2)
    if counts["core"] == 0:
        hashes = {email: run(["htpasswd", "-niBC", "12", "demo"], password + "\n").split(":", 1)[1] for email, password in record["accounts"].items()}
        sql("core", core_sql(hashes))
    elif counts["core"] != 2 or int(sql("core", "SELECT COUNT(*) FROM account WHERE role='USER' AND email IN (" + ",".join(map(text, EMAILS)) + ");")) != 2:
        raise ValueError("Unexpected accounts; no passwords or roles changed")
    print("GOVBIZ_PORTFOLIO_DEMO_OK: 8 projected demo programs; 2 USER accounts. No paid API calls.")
    print("Private login file:", receipt)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        raise SystemExit("Portfolio seed stopped. No raw SQL/credentials are printed; inspect read-only state before retrying.")
