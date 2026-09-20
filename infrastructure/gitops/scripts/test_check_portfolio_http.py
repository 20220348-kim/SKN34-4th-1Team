import json
import unittest

from check_portfolio_http import NoRedirect, check


class PortfolioHttpTests(unittest.TestCase):
    def responses(self):
        return {
            "/?mode=filter": (200, b'<div id="root"></div>'),
            "/api/v1/health": (200, b'{"status":"up"}'),
            "/api/v1/support-programs/catalog?page=1&pageSize=12&status=ALL":
                (200, json.dumps({"programs": [], "total": 0}).encode()),
            "/api/v1/auth/me": (401, b'{}'),
        }

    def test_empty_catalog_is_valid_but_not_reported_as_real_data(self):
        check(self.responses().__getitem__)

    def test_failures_and_auth_bypass_are_not_hidden(self):
        for path in self.responses():
            with self.subTest(path=path):
                responses = self.responses()
                responses[path] = (200, b'{}') if path.endswith("/me") else (503, b'{}')
                with self.assertRaises(ValueError):
                    check(responses.__getitem__)

    def test_does_not_follow_redirects_to_external_services(self):
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, "", {}, "https://external.invalid"))


if __name__ == "__main__":
    unittest.main()
