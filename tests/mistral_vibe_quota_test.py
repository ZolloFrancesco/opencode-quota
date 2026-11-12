import importlib.util
from pathlib import Path
from types import SimpleNamespace as Record
import unittest

path = Path(__file__).resolve().parents[1] / "src/lib/mistral-vibe-quota.py"
spec = importlib.util.spec_from_file_location("vibe_quota", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BillingProtocolTest(unittest.TestCase):
    def billing(self, used=25, limit=100, reset="2026-12-01T00:00:00Z"):
        return Record(
            budget=Record(vibe_budget=Record(
                usage_percentage=used, initial_budget=limit,
                reset_at=reset, payg_enabled=None,
            )),
            subscription=Record(plan_name="EDU", vibe_payg_enabled=False),
        )

    def test_percentage_points_not_fraction(self):
        self.assertEqual(module.normalize_billing(self.billing(0.25)), {
            "status": "ok", "usedPercent": 0.25,
            "resetTimeIso": "2026-12-01T00:00:00Z",
            "plan": "EDU", "paygEnabled": False,
        })

    def test_overage_is_not_clamped(self):
        self.assertEqual(module.normalize_billing(self.billing(125))["usedPercent"], 125)

    def test_missing_or_invalid_allowance_is_not_zero(self):
        self.assertEqual(module.normalize_billing(Record(budget=None)), {"status": "unavailable"})
        for used, limit in ((-1, 100), (float("nan"), 100), (1, 0), (1, float("inf")), (True, 100)):
            with self.subTest(used=used, limit=limit):
                self.assertEqual(module.normalize_billing(self.billing(used, limit)), {"status": "unavailable"})

    def test_reset_needs_explicit_timezone(self):
        for reset in (None, "tomorrow", "2026-12-01T00:00:00"):
            self.assertNotIn("resetTimeIso", module.normalize_billing(self.billing(reset=reset)))

    def test_never_returns_credentials_internal_budget_units_or_unknown_text(self):
        read = self.billing()
        read.subscription.plan_name = "Bearer secret"
        result = module.normalize_billing(read)
        self.assertNotIn("plan", result)
        self.assertNotIn("initial_budget", result)
        self.assertNotIn("secret", repr(result))


if __name__ == "__main__":
    unittest.main()
