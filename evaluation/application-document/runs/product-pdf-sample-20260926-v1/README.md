# 제품 제공처 PDF 첨부의 AcroForm 표본 탐색

검사일: 2026-09-26. 현재 서비스가 지원하는 기업마당 제공처의 실제 지원사업 공고 첨부 중 PDF 신청서와 동의서를 우선 확인했다. 원본은 저장소 밖 임시 폴더에만 두었다. 이 공고가 현재 로컬 DB에 수집·추천된 상태인지는 확인하지 않았으므로 **제공처 실공고 첨부 검증**으로 한정한다.

| 제공처 공고·첨부 | 원본 SHA-256 | 페이지 | AcroForm 필드·위젯 | 판정 |
|---|---|---:|---:|---|
| [기업마당 부산 치의학산업 디지털 전환 공고](https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000120862)의 `기업지원 신청서 양식.pdf` | `ed57932fc5fae573a50e4cc897da8a25d1b373f77f1384a867b95ad9b0c55b61` | 9 | 0·0 | flat PDF |
| [기업마당 문화산업 완성보증 공고](https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000122594)의 `개인정보수집이용제공동의 양식.pdf` | `2835d4ac62d5841aae012e9b429e2d5b607b0183aba8a632e4572d9a39b372b3` | 1 | 0·0 | flat PDF |

두 첨부는 독립 pypdf로 페이지와 `/AcroForm/Fields`, 페이지 `/Widget`을 확인했다. 따라서 이 표본으로 AcroForm text·radio·checkbox·choice Mapping/Write를 실행하지 않았다. 유료 OpenAI 호출 0회. 검사한 제품 제공처 PDF에서는 선택형 AcroForm 표본을 확보하지 못했으므로 `PRODUCT_REAL_SAMPLE_NOT_FOUND`로 기록한다. 이는 기업마당·K-Startup 전체에 해당 표본이 없다는 뜻이 아니다. 기존 부산 항공부품 flat PDF의 FFDetr·Mapping·PDFBox E2E 결과는 [이전 실행](../pdf-e2e-20260925-v1/README.md)을 참고한다.
