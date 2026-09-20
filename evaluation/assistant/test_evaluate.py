"""모델 호출 없이 도움말 파서·질문 세트·채점 규칙을 검증한다."""

import unittest

from evaluate import build_agent_requests, build_requests, is_agent_case, load_help_entries, load_questions, score, score_agent, summarize, summarize_agent


class HelpEntryParserTest(unittest.TestCase):
    def test_reads_every_chatbot_help_entry_in_the_ai_service_contract_shape(self):
        entries = load_help_entries()
        ids = [entry["id"] for entry in entries]
        self.assertIn("search-score-meaning", ids)
        self.assertIn("partner-write-requires-company", ids)
        for entry in entries:
            self.assertEqual(
                set(entry), {"id", "title", "question", "summary", "body", "limitation", "audience", "status", "action"},
            )
            self.assertIn(entry["audience"], ("public", "member", "company", "admin"))
            self.assertIn(entry["status"], ("available", "demo", "planned"))
            if entry["action"] is not None:
                self.assertRegex(entry["action"]["to"], r"^/app/[A-Za-z0-9/-]*$", "action route must be a bare /app path")
        # 필터 검색 항목의 `?mode=filter` 질의는 프런트처럼 떼어 낸다.
        status_entry = next(entry for entry in entries if entry["id"] == "status-unknown-source")
        self.assertEqual(status_entry["action"], {"label": "필터 검색 열기", "to": "/app/chat"})


class QuestionSetTest(unittest.TestCase):
    def test_questions_validate_against_the_ai_service_request_contract(self):
        fixture = load_questions()
        prepared = build_requests(fixture, load_help_entries())
        classify_cases = [case for case in fixture["cases"] if not is_agent_case(case)]
        self.assertEqual(len(prepared), len(classify_cases))
        self.assertEqual(len(fixture["cases"]) - len(classify_cases), 20, "에이전트 문항 20개")
        help_cases = [case for case, _ in prepared if case["expectedIntent"] == "PRODUCT_HELP"]
        self.assertEqual(len(help_cases), 30, "도움말 10항목 × 표현 3개")
        unanswerable = [case for case, _ in prepared if case["expectedIntent"] in ("OUT_OF_SCOPE", "UNCLEAR")]
        self.assertEqual(len(unanswerable), 10, "답할 수 없는 문항 10개")
        for case, request in prepared:
            self.assertEqual(request.message, case["message"])
            self.assertEqual(len(request.help_entries), len(load_help_entries()))
            if case["expectedIntent"] == "PROGRAM_QUESTION":
                self.assertTrue(request.context.program_selected, f"{case['id']}: 공고 질문은 상세 화면에서 묻는다")
            if case["expectedIntent"] == "ACCOUNT_STATE":
                self.assertTrue(request.session.authenticated, f"{case['id']}: 상태 질문은 로그인 세션으로 묻는다")


class AgentQuestionSetTest(unittest.TestCase):
    def test_agent_requests_carry_a_principal_for_logged_in_sessions_and_documents_only_on_resume(self):
        from agent_fixtures import ACCOUNT_ID, saved_program_documents

        fixture = load_questions()
        prepared = build_agent_requests(fixture, load_help_entries())
        self.assertEqual(len(prepared), len(fixture["cases"]), "에이전트 모드는 모든 문항을 돌린다")
        agent_cases = [(case, request) for case, request in prepared if is_agent_case(case)]
        self.assertEqual(len([case for case, _ in agent_cases if case["expectedIntent"] == "PARTNER_MATCH"]), 8)
        self.assertEqual(len([case for case, _ in agent_cases if case["expectedIntent"] == "SAVED_PROGRAMS_QUESTION"]), 8)
        self.assertEqual(len([case for case, _ in agent_cases if case["expectedIntent"] == "ACCOUNT_STATE"]), 4)
        for case, request in prepared:
            self.assertEqual(request.principal is not None, request.session.authenticated)
            if request.principal is not None:
                self.assertEqual(request.principal.account_id, ACCOUNT_ID)
                self.assertEqual(request.principal.has_company, request.session.has_company)
            self.assertIsNone(request.saved_program_documents)
        documents = saved_program_documents()
        self.assertEqual([len(document["chunks"]) for document in documents], [3, 2, 0], "세 번째 공고는 원문 미수집")
        resumed = agent_cases[0][1].model_validate({**agent_cases[0][1].model_dump(by_alias=True), "savedProgramDocuments": documents, "resumeIntent": "SAVED_PROGRAMS_QUESTION"})
        self.assertEqual(len(resumed.saved_program_documents), 3)


class ScoringTest(unittest.TestCase):
    def test_scores_agent_tools_cards_and_quotes(self):
        from agent_fixtures import RECRUITMENT_IDS, SAVED_PROGRAM_IDS, chunk_texts

        valid = RECRUITMENT_IDS | SAVED_PROGRAM_IDS
        match_case = {"id": "M", "split": "dev", "mode": "agent", "expectedIntent": "PARTNER_MATCH", "expectedTools": ["get_my_company_profile", "search_partner_recruitments"], "expectedCards": ["21"]}
        first = {"intent": "PARTNER_MATCH", "answer": "답", "cards": [{"id": "21", "quote": None}, {"id": "22", "quote": None}], "toolCalls": [], "needsDocuments": False}
        good = score_agent(match_case, first, first, ["get_my_company_profile", "search_partner_recruitments"], chunk_texts(), valid)
        self.assertTrue(good["intentCorrect"] and good["toolsCorrect"] and good["cardsValid"] and good["expectedCardsIncluded"])
        bad = score_agent(match_case, first, {**first, "cards": [{"id": "999", "quote": None}]}, ["search_partner_recruitments"], chunk_texts(), valid)
        self.assertFalse(bad["toolsCorrect"] or bad["cardsValid"] or bad["expectedCardsIncluded"])

        docs_case = {"id": "D", "split": "dev", "mode": "agent", "expectedIntent": "SAVED_PROGRAMS_QUESTION", "expectedTools": [], "expectedCards": ["BIZINFO:PBLN_000000000000001"]}
        needs = {"intent": "SAVED_PROGRAMS_QUESTION", "answer": None, "cards": [], "toolCalls": [], "needsDocuments": True}
        final = {"intent": "SAVED_PROGRAMS_QUESTION", "answer": "답", "toolCalls": [], "needsDocuments": False,
                 "cards": [{"id": "BIZINFO:PBLN_000000000000001", "quote": "기업마당 온라인 신청"}]}
        verified = score_agent(docs_case, needs, final, [], chunk_texts(), valid)
        self.assertTrue(verified["needsDocuments"] and verified["quotesVerified"] and verified["expectedCardsIncluded"])
        forged = score_agent(docs_case, needs, {**final, "cards": [{"id": "BIZINFO:PBLN_000000000000001", "quote": "원문에 없는 문장"}]}, [], chunk_texts(), valid)
        self.assertFalse(forged["quotesVerified"])
        summary = summarize_agent([good, bad, verified, forged, score_agent(docs_case, None, None, [], chunk_texts(), valid)])
        self.assertEqual(summary["agentCases"], 4)
        self.assertEqual(summary["toolSelectionAccuracy"], 0.75)
        self.assertEqual(summary["quoteVerificationRate"], 0.5)
        self.assertEqual(summary["errors"], 1)


    def test_scores_intent_citation_topic_and_abstain(self):
        help_case = {"id": "H", "split": "dev", "expectedIntent": "PRODUCT_HELP", "expectedCitation": "search-score-meaning"}
        account_case = {"id": "A", "split": "heldout", "expectedIntent": "ACCOUNT_STATE", "expectedAccountTopic": "SAVED_PROGRAMS"}
        oos_case = {"id": "N", "split": "dev", "expectedIntent": "OUT_OF_SCOPE"}
        results = [
            score(help_case, {"intent": "PRODUCT_HELP", "citations": ["eligibility-unknown"]}),
            score(account_case, {"intent": "ACCOUNT_STATE", "accountTopic": "SAVED_PROGRAMS"}),
            score(oos_case, {"intent": "UNCLEAR"}),
            score(oos_case, None),
        ]
        self.assertTrue(results[0]["intentCorrect"])
        self.assertFalse(results[0]["citationCorrect"])
        self.assertTrue(results[1]["accountTopicCorrect"])
        self.assertFalse(results[2]["intentCorrect"])
        self.assertTrue(results[2]["abstained"], "UNCLEAR도 기권으로 센다")
        self.assertEqual(results[3]["error"], "no output")

        summary = summarize(results)
        self.assertEqual(summary["scored"], 3)
        self.assertEqual(summary["errors"], 1)
        self.assertAlmostEqual(summary["intentAccuracy"], 2 / 3, places=3)
        self.assertEqual(summary["helpCitationAccuracy"], 0.0)
        self.assertEqual(summary["accountTopicAccuracy"], 1.0)
        self.assertEqual(summary["abstainRateOnUnanswerable"], 1.0)
        self.assertEqual(summary["falseAbstainRateOnAnswerable"], 0.0)
        self.assertEqual(summary["perSplit"]["heldout"]["intentAccuracy"], 1.0)


if __name__ == "__main__":
    unittest.main()
