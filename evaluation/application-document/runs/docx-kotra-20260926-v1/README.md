# DOCX 공식 신청서 1차 검증

이 문서는 초기 XML 수준 결과 기록이다. 당시 작성본 SHA-256 `d35b39e...`는 이후 Word에서 복구 경고가 확인돼 유효한 작성 결과로 사용하지 않는다. namespace 선언 보존 수정 후의 Word 열기·페이지 검증은 [안정화 기록](../docx-stabilization-20260926-v1/README.md)을 기준으로 한다.

- 공식 출처: [기업마당 2026년 해외 공공조달 선도기업 육성사업](https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000117178), 참가신청서 DOCX 첨부
- 원본 SHA-256: `26a761197b64aaf884cd6636851d423f7d1a51686249d418a1f2c3e57ab50cd7`
- 원본 바이너리: 저장소에 포함하지 않음
- OOXML: 문단 150개, 표 1개, 내용 컨트롤 0개
- NativeTarget: 269개, 편집 후보 12개
- Codex가 표의 라벨과 물리 셀을 대조한 기준 필드 10개: 후보 coverage 10/10, exact 10, ambiguous 0, wrong 0, unmapped 0. 독립적인 사람 검수는 미실행.
- OpenAI Mapping: `gpt-5.6-luna`, production Agent 1회 호출, Correct 10, Wrong 0, Unmapped 0, Wrong Target Rate 0. 단일 문서·단일 호출 결과이며 일반화 성능은 측정하지 않음.
- Native write: 개인 정보가 아닌 더미 값 5개를 원본과 분리된 DOCX에 기입. 재열기, 대상 값, 다른 대상 텍스트, 표 수·행·셀·병합, 내용 컨트롤 수와 XML 스타일 속성 검사 통과. 결과 SHA-256: `d35b39e600193c14fa6bd98c63378d96df23188efe1d5b9b32e50e0a096863dd`. 결과 바이너리는 저장소에 포함하지 않음. Word/LibreOffice 렌더 확인은 미실행.
- 단순 가로 `gridSpan` 셀은 하나의 물리 `tc`를 주소로 사용한다. 세로 병합, 여러 문단의 단일 셀, 혼합 스타일, 텍스트박스·도형 등은 자동 작성에서 제외한다.
- AI 전체 회귀: 1차 실행 1,339 통과·97 실패(tokenizer 다운로드 차단), 재실행 1,426 통과·11 fixture 오류(pytest temp ACL), 해당 DOCX·문서 계약 파일 92개 전부 통과. 테스트 실행 환경의 접근 권한 문제였고, 기능 회귀로 판정하지 않음.
- Core 파서 JDK 21/Gradle 테스트: Gradle 단일 실행 데몬의 로컬 loopback 연결 오류로 미실행. Web 전체 1,270개, Shared 전체 19개 테스트와 Shared typecheck·변경 파일 oxlint 통과. 실제 Core→AI→Web 통합, CI와 배포 검증은 미실행.

평가 입력은 [blind 질문](../../blind-docx-kotra-procurement-2026-v1.json), 정답은 [expected](../../expected/docx-kotra-procurement-2026-v1.json)로 분리했다. 정답 target ID는 모델 요청에 넣지 않았다. [mapping.json](mapping.json)에 1회 호출 결과를 기록했다.
