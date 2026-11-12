"""Read Vibe's billing allowance without exporting credentials or starting an agent."""

import asyncio
from datetime import datetime, timezone
import json
import math
from importlib.metadata import version


def reset_time(value):
    if not isinstance(value, str) or len(value) > 128:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return None
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except (ValueError, OverflowError):
        return None


def normalize_billing(read):
    detail = read.budget.vibe_budget if read.budget else None
    if detail is None:
        return {"status": "unavailable"}
    used, limit = detail.usage_percentage, detail.initial_budget
    if any(
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        for value in (used, limit)
    ) or used < 0 or used > 1e15 or limit <= 0:
        return {"status": "unavailable"}
    # Vibe reports percentage points, not a 0..1 fraction. Never turn the
    # internal allowance units into USD or infer a five-hour/weekly window.
    result = {"status": "ok", "usedPercent": used}
    reset = reset_time(detail.reset_at)
    if reset is not None:
        result["resetTimeIso"] = reset
    subscription = read.subscription
    plan = subscription.plan_name.upper() if subscription else ""
    if plan in {"FREE", "INDIVIDUAL", "PRO", "EDU", "TEAM", "ENTERPRISE"}:
        result["plan"] = plan
    payg = detail.payg_enabled
    if payg is None and subscription is not None:
        payg = subscription.vibe_payg_enabled
    if isinstance(payg, bool):
        result["paygEnabled"] = payg
    return result


async def read_quota():
    if not version("mistral-vibe").startswith("3.1."):
        return {"status": "unsupported_runtime"}
    from vibe.core.config import build_default_orchestrator, load_dotenv_values
    from vibe.core.config.harness_files import init_harness_files_manager
    from vibe.core.platform_auth._mistral import mistral_credentials
    from vibe.app_server._billing import HttpBillingGateway

    init_harness_files_manager("user")
    load_dotenv_values()
    config = (await build_default_orchestrator()).config
    credentials = await asyncio.to_thread(mistral_credentials, config)
    if credentials is None:
        return {"status": "missing_auth"}
    async with asyncio.timeout(8):
        read = await HttpBillingGateway().read(
            api_base=credentials.provider.api_base,
            credentials=credentials.credentials,
        )
    return normalize_billing(read)


if __name__ == "__main__":
    try:
        result = asyncio.run(read_quota())
    except ImportError:
        result = {"status": "unsupported_runtime"}
    except Exception:
        # Never print exception text, response bodies, account identifiers,
        # token previews or headers. Python owns all credential resolution.
        result = {"status": "failed"}
    print(json.dumps(result, allow_nan=False, separators=(",", ":")), flush=True)
