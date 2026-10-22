"""Copilot <-> OpenAdapt bridge.

This is the ONLY place that imports ``openadapt_flow``. The TypeScript adapter
(via ``OpenAdaptEngine``) shells out to this module, so the engine can be
replaced or upgraded without touching the copilot's domain code.

Commands
--------
probe            report what the engine can actually do on this machine
record-scripted  drive a demonstration through the real ``Recorder`` against a
                 local demo app (real frames, real events, real DOM evidence)
compile          compile a recording directory into a workflow bundle
replay           replay a bundle against a URL and summarise the run report

Every command prints one line starting with ``__COPILOT_JSON__`` followed by
the JSON result, and (optionally) writes the same JSON to ``--result``. Engine
output stays on stdout/stderr untouched, so nothing is hidden or rewritten.

Why "scripted": a recorder needs *someone* to perform the demonstration. In an
automated run there is no human at the browser, so this driver performs the
clicks through ``Recorder`` exactly as ``openadapt_flow.demo_driver`` does for
OpenAdapt's own demos: record time may use Playwright locators to find pixels,
replay never does. A human-driven demonstration uses
``openadapt-flow record`` directly and produces the identical artifacts.
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path
from typing import Any


def emit(payload: dict[str, Any], result_path: str | None) -> None:
    text = json.dumps(payload, indent=2, default=str)
    if result_path:
        Path(result_path).parent.mkdir(parents=True, exist_ok=True)
        Path(result_path).write_text(text, encoding="utf-8")
    print("__COPILOT_JSON__" + json.dumps(payload, default=str), flush=True)


# --------------------------------------------------------------------------
# Demonstration scripts
#
# Each entry is a list of (kind, css_selector, extra). ``type`` carries the
# parameter name and the value typed during the demonstration; the value is
# recorded as a parameter, never baked into a postcondition (compile lints it).
# Selectors here are the *demo apps'* real DOM ids, documented in
# apps/demo/README.md. They are used only to find pixels at record time.
# --------------------------------------------------------------------------
DEMONSTRATIONS: dict[str, dict[str, Any]] = {
    "acme-crm": {
        "title": "Create customer",
        "steps": [
            ("click", "#new-customer", None),
            ("click", "#customer-name", None),
            ("type", None, {"param": "company_name", "value": "Acme Demo Ltd"}),
            ("click", "#customer-email", None),
            ("type", None, {"param": "email", "value": "demo@acme.test"}),
            ("click", "#save-customer", None),
        ],
    },
    "stockdesk": {
        "title": "Register stock item",
        "steps": [
            ("click", "#new-item", None),
            ("click", "#item-sku", None),
            ("type", None, {"param": "sku", "value": "DEMO-001"}),
            ("click", "#item-qty", None),
            ("type", None, {"param": "quantity", "value": "25"}),
            ("click", "#save-item", None),
        ],
    },
}


def cmd_probe(args: argparse.Namespace) -> dict[str, Any]:
    info: dict[str, Any] = {"ok": True, "python": sys.version.split()[0]}
    try:
        import openadapt_flow  # noqa: F401

        info["engine"] = {
            "name": "openadapt-flow",
            "version": getattr(openadapt_flow, "__version__", "unknown"),
            "path": str(Path(openadapt_flow.__file__).parent),
        }
    except Exception as exc:  # pragma: no cover - environment dependent
        return {"ok": False, "error": f"openadapt_flow import failed: {exc}"}

    for module in ("cv2", "rapidocr_onnxruntime", "playwright"):
        try:
            __import__(module)
            info[module] = True
        except Exception:
            info[module] = False

    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            info["chromium_path"] = p.chromium.executable_path
            info["chromium_installed"] = Path(p.chromium.executable_path).exists()
    except Exception as exc:
        info["chromium_installed"] = False
        info["chromium_error"] = str(exc)
    return info


def cmd_record_scripted(args: argparse.Namespace) -> dict[str, Any]:
    from openadapt_flow.backends.playwright_backend import PlaywrightBackend
    from openadapt_flow.recorder import Recorder

    spec = DEMONSTRATIONS.get(args.app)
    if spec is None:
        return {"ok": False, "error": f"unknown demonstration {args.app!r}"}

    out_dir = Path(args.out)
    if out_dir.exists():
        # A recording directory is write-once in spirit; start clean so a re-run
        # cannot half-merge two demonstrations.
        import shutil

        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    overrides = {}
    for pair in args.param or []:
        key, _, value = pair.partition("=")
        overrides[key] = value

    backend, close = PlaywrightBackend.launch(args.url, headless=not args.headed)
    actions: list[dict[str, Any]] = []
    try:
        page = backend.page

        def center(selector: str) -> tuple[int, int]:
            locator = page.locator(selector).first
            locator.wait_for(state="visible")
            box = locator.bounding_box()
            if box is None:
                raise RuntimeError(f"no bounding box for {selector!r}")
            return (
                int(box["x"] + box["width"] / 2),
                int(box["y"] + box["height"] / 2),
            )

        recorder = Recorder(backend, out_dir, app_url=args.url)
        for kind, selector, extra in spec["steps"]:
            if kind == "click":
                assert selector is not None
                x, y = center(selector)
                recorder.click(x, y)
                actions.append({"action": "click", "selector": selector})
            elif kind == "type":
                assert extra is not None
                value = overrides.get(extra["param"], extra["value"])
                recorder.type_text(value, param=extra["param"])
                actions.append(
                    {
                        "action": "type",
                        "param": extra["param"],
                        # never echo a demonstrated value that could be secret
                        "value_length": len(value),
                    }
                )
            else:  # pragma: no cover - bad spec
                raise RuntimeError(f"unsupported step kind {kind!r}")
        recorder.finish()
    finally:
        close()

    events = (out_dir / "events.jsonl").read_text(encoding="utf-8").strip().splitlines()
    frames = list((out_dir / "frames").glob("*.png"))
    return {
        "ok": True,
        "recording_dir": str(out_dir),
        "title": spec["title"],
        "events": len(events),
        "frames": len(frames),
        "actions": actions,
    }


def _demo_script(app_key: str):
    """Drive the recorder's OWN browser through a demonstration.

    This exists so the interactive pipeline (listener -> frames -> finish ->
    compile) can be exercised in CI. Playwright drives the browser instead of a
    person, so the bridge reports the driver as ``synthetic`` and never claims a
    human demonstration took place.
    """
    spec = DEMONSTRATIONS[app_key]

    def drive(page: Any, pump: Any) -> None:
        def click(selector: str) -> None:
            page.wait_for_selector(selector, state="visible", timeout=20000)
            page.click(selector)
            pump()
            pump()

        for kind, selector, extra in spec["steps"]:
            if kind == "click":
                assert selector is not None
                click(selector)
            else:
                assert extra is not None
                page.keyboard.type(str(extra["value"]))
                pump()
                pump()

    return drive


def cmd_record_interactive(args: argparse.Namespace) -> dict[str, Any]:
    """Human-driven recording: headed browser, stop when the stop file appears."""
    from openadapt_flow.interactive_recorder import record_interactive

    out_dir = Path(args.out)
    if out_dir.exists():
        import shutil

        shutil.rmtree(out_dir)
    out_dir.parent.mkdir(parents=True, exist_ok=True)

    stop_file = Path(args.stop_file)
    if stop_file.exists():
        stop_file.unlink()

    script = _demo_script(args.demo) if args.demo else None
    kwargs: dict[str, Any] = {}
    if script is None:
        kwargs["stop_when"] = lambda: stop_file.exists()

    recording = record_interactive(
        args.url,
        out_dir,
        param_fields=tuple(args.param or ()),
        secret_fields=tuple(args.secret or ()),
        headless=args.headless,
        script=script,
        **kwargs,
    )

    events_path = Path(recording) / "events.jsonl"
    events = (
        events_path.read_text(encoding="utf-8").strip().splitlines()
        if events_path.exists()
        else []
    )
    frames = list((Path(recording) / "frames").glob("*.png"))
    return {
        "ok": True,
        "recording_dir": str(recording),
        "events": len(events),
        "frames": len(frames),
        "mode": "interactive",
        "driver": f"synthetic:{args.demo}" if args.demo else "human",
    }


def cmd_compile(args: argparse.Namespace) -> dict[str, Any]:
    from openadapt_flow.__main__ import main as flow_main

    out = Path(args.out)
    argv = [
        "compile",
        str(args.recording),
        "--out",
        str(out),
        "--name",
        args.name,
    ]
    if args.accept_params:
        argv += ["--accept-params", args.accept_params]
    else:
        argv.append("--no-confirm-params")
    code = flow_main(argv)
    workflow_path = out / "workflow.json"
    return {
        "ok": code == 0 and workflow_path.exists(),
        "exit_code": code,
        "bundle_dir": str(out),
        "workflow_json": str(workflow_path) if workflow_path.exists() else None,
    }


def cmd_replay(args: argparse.Namespace) -> dict[str, Any]:
    from openadapt_flow.__main__ import main as flow_main

    run_dir = Path(args.run_dir)
    argv = ["replay", str(args.bundle), "--run-dir", str(run_dir), "--url", args.url]
    for pair in args.param or []:
        argv += ["--param", pair]
    if args.headed:
        argv.append("--headed")

    code = flow_main(argv)
    report_path = run_dir / "report.json"
    if not report_path.exists():
        return {
            "ok": False,
            "exit_code": code,
            "error": "engine produced no report.json",
            "run_dir": str(run_dir),
        }

    report = json.loads(report_path.read_text(encoding="utf-8"))
    results = []
    steps_total_ms = 0.0
    for index, item in enumerate(report.get("results", [])):
        resolution = item.get("resolution") or {}
        # The engine's own per-step evidence. `input_verified` is its check that
        # a typed value landed in the field; `duration_ms`/`timings` are what
        # make a slow step attributable. None of this was surfaced before.
        elapsed = item.get("elapsed_ms")
        if isinstance(elapsed, (int, float)):
            steps_total_ms += float(elapsed)
        field_read = item.get("field_read")
        results.append(
            {
                "index": index,
                "step_id": item.get("step_id"),
                "intent": item.get("intent"),
                "ok": bool(item.get("ok")),
                "skipped": bool(item.get("skipped")),
                "rung": resolution.get("rung"),
                "postconditions_ok": item.get("postconditions_ok"),
                "identity_ok": (item.get("identity") or {}).get("ok"),
                "risk": item.get("risk"),
                "error": item.get("error"),
                "duration_ms": elapsed if isinstance(elapsed, (int, float)) else None,
                "input_verified": item.get("input_verified"),
                "field_read": field_read if isinstance(field_read, str) else None,
                "failure_category": item.get("failure_category"),
                "resolution_elapsed_ms": resolution.get("elapsed_ms"),
                # P0: the engine's own refusal evidence. `safety_halt` on its own
                # says "the step was stopped for safety", not why. These two
                # fields separate a real policy refusal from an application
                # that rejected the write (M3 could not tell them apart).
                "safety_halt": bool(item.get("safety_halt")),
                "safety_refusal_evidence": item.get("safety_refusal_evidence"),
                "effect_verified": item.get("effect_verified"),
                "skip_effect_verify": item.get("skip_effect_verify"),
            }
        )
    halt = report.get("halt") or {}
    total_ms = report.get("total_ms", 0) or 0
    engine_overhead_ms = max(0.0, float(total_ms) - steps_total_ms)
    return {
        "ok": True,
        "exit_code": code,
        "run_dir": str(run_dir),
        "report_path": str(report_path),
        "success": bool(report.get("success")),
        "execution_outcome": report.get("execution_outcome"),
        "transaction_outcome": report.get("transaction_outcome"),
        "execution_completed": report.get("execution_completed"),
        "halt_reason": halt.get("reason"),
        "halt_intent": halt.get("intent"),
        # What the application itself showed when the run stopped. This is how an
        # app-level rejection (e.g. "Save failed: validation rejected") becomes
        # distinguishable from a policy refusal. Text only: no response bodies.
        "halt_observed_texts": halt.get("observed_texts") or [],
        "rung_counts": report.get("rung_counts") or {},
        "heal_count": report.get("heal_count", 0),
        "model_calls": report.get("model_calls", 0),
        "total_ms": total_ms,
        "steps_total_ms": steps_total_ms,
        "engine_overhead_ms": engine_overhead_ms,
        "results": results,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--result", default=None, help="also write the JSON here")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("probe")
    p.set_defaults(func=cmd_probe)

    p = sub.add_parser("record-scripted")
    p.add_argument("--url", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--app", required=True, choices=sorted(DEMONSTRATIONS))
    p.add_argument("--param", action="append", metavar="K=V")
    p.add_argument("--headed", action="store_true")
    p.set_defaults(func=cmd_record_scripted)

    p = sub.add_parser("record-interactive")
    p.add_argument("--url", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--stop-file", required=True)
    p.add_argument("--param", action="append", metavar="FIELD")
    p.add_argument("--secret", action="append", metavar="FIELD")
    p.add_argument("--demo", default=None, choices=sorted(DEMONSTRATIONS))
    p.add_argument("--headless", action="store_true")
    p.set_defaults(func=cmd_record_interactive)

    p = sub.add_parser("compile")
    p.add_argument("--recording", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--accept-params", default=None)
    p.set_defaults(func=cmd_compile)

    p = sub.add_parser("replay")
    p.add_argument("--bundle", required=True)
    p.add_argument("--url", required=True)
    p.add_argument("--run-dir", required=True)
    p.add_argument("--param", action="append", metavar="K=V")
    p.add_argument("--headed", action="store_true")
    p.set_defaults(func=cmd_replay)

    args = parser.parse_args(argv)
    try:
        payload = args.func(args)
    except Exception as exc:
        payload = {
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "traceback": traceback.format_exc(limit=8),
        }
    emit(payload, args.result)
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
